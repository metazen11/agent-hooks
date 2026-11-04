'use strict';
/**
 * Shared knowledge for worktree-cap: how to find a repo's agent worktrees,
 * decide which are "unlanded", read the landing markers, ratchet the cap, and
 * format the report. worktree-cap.js, unlanded-report.js and landing-ready.js
 * all route through here.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HEADROOM = 3;          // cap = unlanded-at-baseline + HEADROOM
const PRUNABLE_DAYS = 7;
const READY = '.landing-ready';
const HOLD = '.landing-hold';
const CAP_FILE = '.worktree-cap';
const WORKTREE_DIRS = ['/.worktrees/', '/.claude/worktrees/'];
const SHA40 = /^[0-9a-f]{40}$/;
const TRUNKS = ['dev', 'develop', 'main', 'master'];

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function tryGit(cwd, args) {
    try { return git(cwd, args); } catch { return null; }
}

/** Main worktree root of the repo containing cwd, or null if not in a git repo. */
function repoRoot(cwd) {
    const out = tryGit(cwd, ['worktree', 'list', '--porcelain']);
    const m = out && out.match(/^worktree (.+)$/m); // first entry is always the main worktree
    return m ? m[1] : null;
}

/** Integration trunk: origin/dev|develop else origin/main|master (local branch only if no remote ref). */
function trunkRef(root) {
    for (const prefix of ['origin/', '']) {
        for (const t of TRUNKS) {
            if (tryGit(root, ['rev-parse', '--verify', '-q', `${prefix}${t}^{commit}`]) !== null) return prefix + t;
        }
    }
    return null;
}

class CapFileError extends Error {}

/** Untrusted text (paths, branch names, hold reasons) -> printable, bounded. */
function clean(x, max = 100) {
    const t = String(x).replace(/[^\x20-\x7e]/g, '?');
    return t.length > max ? t.slice(0, max) + '...' : t;
}

/**
 * Effective cap, ratcheting DOWN only.
 *  - env WORKTREE_CAP: explicit operator override; used as-is, never persisted.
 *  - else <root>/.worktree-cap (must be a REGULAR file: a symlink/dir throws
 *    CapFileError, callers fail closed). First sight (absent/invalid) baselines
 *    at unlanded + 3; afterwards, if unlanded + 3 < cap the file is rewritten
 *    (temp file + rename, never following a link). Never raised automatically.
 * File contents are never echoed.
 */
function resolveCap(root, unlanded) {
    const env = process.env.WORKTREE_CAP;
    if (env !== undefined && env !== '') {
        if (/^[1-9]\d*$/.test(env)) return Number(env);
        process.stderr.write('[worktree-cap] ignoring invalid WORKTREE_CAP (need a positive integer)\n');
    }
    const target = unlanded + HEADROOM;
    const file = path.join(root, CAP_FILE);
    let st = null;
    try { st = fs.lstatSync(file); } catch { /* absent */ }
    if (st && !st.isFile()) {
        throw new CapFileError(`${CAP_FILE} in ${clean(root)} is not a regular file (symlink or directory); refusing to read or write it. Replace it with a plain file holding a positive integer.`);
    }
    let cap = null;
    if (st) {
        const raw = fs.readFileSync(file, 'utf8').slice(0, 32).trim();
        if (/^[1-9]\d*$/.test(raw)) cap = Number(raw);
        else process.stderr.write(`[worktree-cap] invalid ${CAP_FILE} in ${clean(root)}; re-baselining\n`);
    }
    if (cap === null || target < cap) {
        cap = target;
        try {
            if (fs.realpathSync(path.dirname(file)) !== fs.realpathSync(root)) throw new Error('target escapes repo root');
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${cap}\n`, { flag: 'wx' });
            fs.renameSync(tmp, file);
        } catch (e) {
            process.stderr.write(`[worktree-cap] cannot persist ${CAP_FILE}: ${clean(e.message)}\n`);
        }
    }
    return cap;
}

/** Attestation store: OUTSIDE every worktree (implementers must not self-attest). */
function stateDir() {
    return process.env.WORKTREE_CAP_STATE_DIR || path.join(os.homedir(), '.claude', 'worktree-cap');
}
function attestationPath(root, head) {
    const key = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
    return path.join(stateDir(), key, `${head}.attest`);
}

function ageString(sec) {
    const d = Math.floor(sec / 86400);
    if (d >= 1) return `${d}d`;
    const h = Math.floor(sec / 3600);
    return h >= 1 ? `${h}h` : `${Math.max(0, Math.floor(sec / 60))}m`;
}

/**
 * "Reviewed+audited" is true only if an attestation for this repo + FULL 40-char
 * HEAD exists in the orchestrator state dir (written by landing-ready.js). A
 * .landing-ready file inside the worktree is implementer-writable and ignored.
 * .landing-hold must be a regular, untracked file; only its first line is used.
 */
function markerState(root, wtPath, head) {
    let hold = null;
    try {
        const f = path.join(wtPath, HOLD);
        const st = fs.lstatSync(f);
        if (st.isFile() && tryGit(wtPath, ['ls-files', '--error-unmatch', HOLD]) === null) {
            const first = fs.readFileSync(f, 'utf8').slice(0, 512).trim().split('\n')[0].trim();
            hold = first ? clean(first, 80) : null;
        }
    } catch { /* no hold */ }
    let ready = false;
    if (SHA40.test(head)) {
        try {
            const f = attestationPath(root, head);
            if (fs.lstatSync(f).isFile()) {
                const t = fs.readFileSync(f, 'utf8').slice(0, 4096);
                ready = t.split('\n').includes(`review: APPROVE ${head}`) && t.split('\n').includes(`audit: PASS ${head}`);
            }
        } catch { /* no attestation */ }
    }
    let selfMarker = false;
    try { selfMarker = fs.lstatSync(path.join(wtPath, READY)).isFile() || true; } catch { /* none */ }
    return { hold, ready, staleMarker: selfMarker && !ready };
}

/**
 * Agent worktrees of the repo at `root`, classified:
 *   unlanded - HEAD has commits not in trunk (work that could be lost)
 *   prunable - nothing ahead and last commit >= 7 days old
 * Worktrees that are landed and recent are omitted. No trunk found =>
 * cannot prove landed => unlanded (fail closed).
 */
function scan(root, now = Math.floor(Date.now() / 1000)) {
    const trunk = trunkRef(root);
    const out = tryGit(root, ['worktree', 'list', '--porcelain']) || '';
    const result = { root, trunk, unlanded: [], prunable: [] };
    for (const block of out.split('\n\n')) {
        const p = (block.match(/^worktree (.+)$/m) || [])[1];
        if (!p || p === root || !WORKTREE_DIRS.some((d) => (p + '/').includes(d))) continue;
        const branch = ((block.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) || '(detached)';
        const head = tryGit(p, ['rev-parse', 'HEAD']);
        if (!head) { // unreadable/missing: cannot prove landed => unlanded (fail closed)
            result.unlanded.push({ path: p, branch, ahead: NaN, age: 0, hold: null, ready: false, staleMarker: false });
            continue;
        }
        const num = (v) => (v !== null && /^\d+$/.test(v) ? Number(v) : NaN);
        // null git output must stay NaN: Number(null) === 0 would read as "landed".
        const ahead = trunk ? num(tryGit(p, ['rev-list', '--count', `${trunk}..HEAD`])) : NaN;
        const ts = num(tryGit(p, ['log', '-1', '--format=%ct']));
        const wt = { path: p, branch, ahead, age: now - ts, ...markerState(root, p, head) };
        if (ahead !== 0) result.unlanded.push(wt);
        else if (Number.isFinite(wt.age) && wt.age >= PRUNABLE_DAYS * 86400) result.prunable.push(wt);
    }
    return result;
}

function line(w, tag) {
    const ahead = Number.isNaN(w.ahead) ? '+?' : `+${w.ahead}`;
    const flags = [w.ready && 'REVIEWED+AUDITED, READY TO LAND', w.hold && `HOLD: ${w.hold}`, w.staleMarker && 'in-worktree .landing-ready ignored (not an attestation)'].filter(Boolean);
    return `  ${tag} ${clean(w.path, 200)}  branch=${clean(w.branch, 80)}  ${ahead} commits  last commit ${ageString(w.age)} ago${flags.length ? '  [' + flags.join('; ') + ']' : ''}`;
}

/** Human report for one scan result; '' when there is nothing to say. */
function format(s) {
    if (!s.unlanded.length && !s.prunable.length) return '';
    const lines = [`${clean(s.root, 200)}  (trunk: ${clean(s.trunk || 'NONE FOUND', 60)})`];
    for (const w of s.unlanded) lines.push(line(w, 'unlanded'));
    for (const w of s.prunable) lines.push(line(w, 'prunable'));
    if (s.unlanded.length) lines.push('  next: land each with /reconcile, or delete: git worktree remove --force <path>, then delete the branch');
    if (s.prunable.length) lines.push('  prunable: nothing ahead, idle 7d+  ->  git worktree remove <path>');
    return lines.join('\n');
}

module.exports = { CapFileError, clean, attestationPath, stateDir, SHA40, repoRoot, scan, format, resolveCap, trunkRef, markerState, git, tryGit, READY, HOLD, CAP_FILE, HEADROOM };
