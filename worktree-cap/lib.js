'use strict';
/**
 * Shared knowledge for worktree-cap: how to find a repo's agent worktrees,
 * decide which are "unlanded", read the landing markers, ratchet the cap, and
 * format the report. worktree-cap.js, unlanded-report.js and landing-ready.js
 * all route through here.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEADROOM = 3;          // cap = unlanded-at-baseline + HEADROOM
const PRUNABLE_DAYS = 7;
const READY = '.landing-ready';
const HOLD = '.landing-hold';
const CAP_FILE = '.worktree-cap';
const WORKTREE_DIRS = ['/.worktrees/', '/.claude/worktrees/'];
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

/**
 * Effective cap, ratcheting DOWN only.
 *  - env WORKTREE_CAP: explicit operator override; used as-is, never persisted.
 *  - else <root>/.worktree-cap holds the cap. First sight (no/invalid file)
 *    baselines it at unlanded + 3. Afterwards, if unlanded + 3 < cap the file
 *    is rewritten to unlanded + 3. It is never raised automatically; raise by
 *    editing the file on purpose.
 */
function resolveCap(root, unlanded) {
    const env = process.env.WORKTREE_CAP;
    if (env !== undefined && env !== '') {
        if (/^[1-9]\d*$/.test(env)) return Number(env);
        process.stderr.write(`[worktree-cap] ignoring invalid WORKTREE_CAP=${JSON.stringify(env)}\n`);
    }
    const target = unlanded + HEADROOM;
    const file = path.join(root, CAP_FILE);
    let cap = null;
    try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (/^[1-9]\d*$/.test(raw)) cap = Number(raw);
        else process.stderr.write(`[worktree-cap] invalid ${file} (${JSON.stringify(raw)}); re-baselining\n`);
    } catch { /* absent */ }
    if (cap === null || target < cap) {
        cap = cap === null ? target : target;
        try { fs.writeFileSync(file, `${cap}\n`); } catch (e) {
            process.stderr.write(`[worktree-cap] cannot persist ${file}: ${e.message}\n`);
        }
    }
    return cap;
}

function ageString(sec) {
    const d = Math.floor(sec / 86400);
    if (d >= 1) return `${d}d`;
    const h = Math.floor(sec / 3600);
    return h >= 1 ? `${h}h` : `${Math.max(0, Math.floor(sec / 60))}m`;
}

/** Marker is valid only if it attests review+audit for the CURRENT head sha. */
function markerState(wtPath, head) {
    const read = (f) => { try { return fs.readFileSync(path.join(wtPath, f), 'utf8'); } catch { return null; } };
    const hold = read(HOLD);
    const ready = read(READY);
    const sha = (re) => { const m = ready && ready.match(re); return m && m[1]; };
    const rev = sha(/^review: APPROVE ([0-9a-f]{7,40})\b/m);
    const aud = sha(/^audit: PASS ([0-9a-f]{7,40})\b/m);
    const matches = (s) => !!s && head.startsWith(s);
    const ok = matches(rev) && matches(aud);
    return {
        hold: hold !== null && hold.trim() !== '' ? hold.trim().split('\n')[0] : null,
        ready: ok,
        staleMarker: ready !== null && !ok,
    };
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
        if (!head) continue; // directory gone; `git worktree prune` territory
        const ahead = trunk ? Number(tryGit(p, ['rev-list', '--count', `${trunk}..HEAD`])) : NaN;
        const ts = Number(tryGit(p, ['log', '-1', '--format=%ct']));
        const wt = { path: p, branch, ahead, age: now - ts, ...markerState(p, head) };
        if (ahead !== 0) result.unlanded.push(wt);
        else if (wt.age >= PRUNABLE_DAYS * 86400) result.prunable.push(wt);
    }
    return result;
}

function line(w, tag) {
    const ahead = Number.isNaN(w.ahead) ? '+?' : `+${w.ahead}`;
    const flags = [w.ready && 'REVIEWED+AUDITED, READY TO LAND', w.hold && `HOLD: ${w.hold}`, w.staleMarker && 'stale/invalid .landing-ready'].filter(Boolean);
    return `  ${tag} ${w.path}  branch=${w.branch}  ${ahead} commits  last commit ${ageString(w.age)} ago${flags.length ? '  [' + flags.join('; ') + ']' : ''}`;
}

/** Human report for one scan result; '' when there is nothing to say. */
function format(s) {
    if (!s.unlanded.length && !s.prunable.length) return '';
    const lines = [`${s.root}  (trunk: ${s.trunk || 'NONE FOUND'})`];
    for (const w of s.unlanded) lines.push(line(w, 'unlanded'));
    for (const w of s.prunable) lines.push(line(w, 'prunable'));
    if (s.unlanded.length) lines.push('  next: land each with /reconcile, or delete: git worktree remove --force <path>, then delete the branch');
    if (s.prunable.length) lines.push('  prunable: nothing ahead, idle 7d+  ->  git worktree remove <path>');
    return lines.join('\n');
}

module.exports = { repoRoot, scan, format, resolveCap, trunkRef, markerState, git, tryGit, READY, HOLD, CAP_FILE, HEADROOM };
