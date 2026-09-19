#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// self-update.js  —  keep hook/plugin repos current from git
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node self-update.js --session-start   # hook mode: NOTIFY only, throttled
//    node self-update.js --check           # report status, change nothing
//    node self-update.js --apply           # actually fast-forward (explicit)
//    node self-update.js --now             # ignore the throttle window
//
//  Repos are declared in repos.json beside this file.
//
//  SAFETY CONTRACT — by DEFAULT this NEVER modifies a repo. In hook mode it
//  fetches (read-only) and, if a repo is behind, PROMPTS the user in context
//  with the exact command to run. Nothing is merged without an explicit
//  `--apply`, which the operator runs deliberately.
//
//  Even with --apply it is cowardly: FAST-FORWARD ONLY, and it REFUSES
//  (leaving the repo untouched, reporting why) when:
//
//    · the working tree is dirty            — never clobber uncommitted work
//    · HEAD is not on the configured branch — you are mid-task elsewhere
//    · there is no upstream tracking branch
//    · the branch has diverged (local commits not on the remote)
//    · a rebase/merge/bisect is in progress
//
//  It NEVER merges, rebases, resets, stashes, or force-anythings. The worst
//  case is that it does nothing and says so. Network failure is non-fatal.
//
//  Throttle: at most once per UPDATE_INTERVAL_HOURS (default 24) per repo,
//  tracked in ~/.claude/state/self-update/<slug>.json.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'state', 'self-update');
const INTERVAL_HOURS = Math.max(0, parseFloat(process.env.SELF_UPDATE_EVERY_HOURS) || 24);

// ── git helpers ──────────────────────────────────────────────

/** Run git in `cwd`. Returns trimmed stdout, or null on any failure. */
function git(cwd, args, timeout = 20000) {
    try {
        return execFileSync('git', args, {
            cwd,
            timeout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch {
        return null;
    }
}

/**
 * Inspect `repo` and, only when `apply` is true, fast-forward it.
 * Returns {slug, status, detail, behind, cmd} — status is one of:
 *   behind | updated | current | skipped | error
 */
function inspectRepo(repo, apply) {
    const { path: dir, branch, slug } = repo;
    const res = (status, detail) => ({ slug, status, detail });

    if (!fs.existsSync(path.join(dir, '.git'))) return res('error', 'not a git repo');

    // Refuse while another git operation is mid-flight.
    const gitDir = git(dir, ['rev-parse', '--git-dir']);
    if (gitDir) {
        const abs = path.isAbsolute(gitDir) ? gitDir : path.join(dir, gitDir);
        for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'BISECT_LOG', 'CHERRY_PICK_HEAD']) {
            if (fs.existsSync(path.join(abs, marker))) return res('skipped', `${marker} in progress`);
        }
    }

    const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!current) return res('error', 'cannot read HEAD');
    if (current !== branch) return res('skipped', `on '${current}', not '${branch}'`);

    // Dirty tree — never touch it.
    const dirty = git(dir, ['status', '--porcelain']);
    if (dirty === null) return res('error', 'git status failed');
    if (dirty !== '') {
        const n = dirty.split('\n').filter(Boolean).length;
        return res('skipped', `${n} uncommitted change${n === 1 ? '' : 's'}`);
    }

    const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) return res('skipped', 'no upstream tracking branch');

    if (git(dir, ['fetch', '--quiet', '--prune'], 45000) === null) {
        return res('skipped', 'fetch failed (offline?)');
    }

    const counts = git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    if (!counts) return res('error', 'cannot compare with upstream');
    const [ahead, behind] = counts.split(/\s+/).map(Number);

    if (behind === 0) return res('current', ahead > 0 ? `${ahead} local commit(s) to push` : 'up to date');
    // Diverged: local commits the remote lacks. A ff would lose nothing, but it
    // cannot ff anyway — surface it rather than attempting anything clever.
    if (ahead > 0) return res('skipped', `diverged: ${ahead} ahead, ${behind} behind — reconcile manually`);

    // Behind and clean: this is the one case we CAN safely advance.
    if (!apply) {
        return {
            slug, status: 'behind', behind,
            detail: `${behind} new commit${behind === 1 ? '' : 's'} on ${upstream}`,
            cmd: `git -C ${dir} merge --ff-only ${upstream}`,
        };
    }

    const before = git(dir, ['rev-parse', '--short', 'HEAD']);
    if (git(dir, ['merge', '--ff-only', upstream], 30000) === null) {
        return res('error', 'fast-forward failed');
    }
    const after = git(dir, ['rev-parse', '--short', 'HEAD']);
    return res('updated', `${before} → ${after} (+${behind})`);
}

// ── throttle state ───────────────────────────────────────────

function stateFile(slug) {
    return path.join(STATE_DIR, slug.replace(/[^\w.-]/g, '_') + '.json');
}

function dueForCheck(slug) {
    if (INTERVAL_HOURS === 0) return true;
    try {
        const st = JSON.parse(fs.readFileSync(stateFile(slug), 'utf8'));
        return (Date.now() - (st.lastCheck || 0)) >= INTERVAL_HOURS * 3600 * 1000;
    } catch {
        return true;   // no state yet, or unreadable → check
    }
}

function recordCheck(slug, status) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(stateFile(slug), JSON.stringify({ lastCheck: Date.now(), status }) + '\n');
    } catch { /* state is an optimisation, not a requirement */ }
}

// ── config ───────────────────────────────────────────────────

function loadRepos() {
    let self = __filename;
    try { self = fs.realpathSync(self); } catch {}
    const cfg = path.join(path.dirname(self), 'repos.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        return (parsed.repos || [])
            .map((r) => ({ ...r, path: r.path.replace(/^~/, HOME) }))
            .filter((r) => r.path && r.branch && r.slug);
    } catch {
        return [];
    }
}

// ── main ─────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    const hookMode = args.includes('--session-start');
    const force = args.includes('--now');
    const checkOnly = args.includes('--check');
    const apply = args.includes('--apply');

    const repos = loadRepos();
    if (repos.length === 0) {
        if (!hookMode) console.log('self-update: no repos configured (repos.json)');
        return;
    }

    const results = [];
    for (const repo of repos) {
        // The throttle governs the (networked) fetch, not explicit operator runs.
        if (hookMode && !force && !dueForCheck(repo.slug)) continue;
        const r = checkOnly ? updateRepoDryRun(repo) : inspectRepo(repo, apply);
        if (hookMode || apply) recordCheck(repo.slug, r.status);
        results.push(r);
    }

    if (!hookMode) {
        for (const r of results) {
            console.log(`  ${r.status.padEnd(8)} ${r.slug.padEnd(16)} ${r.detail}`);
            if (r.status === 'behind') console.log(`           ${r.cmd}`);
        }
        if (results.length === 0) console.log('  (nothing to report)');
        if (results.some((r) => r.status === 'behind')) {
            console.log('\n  Run with --apply to fast-forward these.');
        }
        return;
    }

    // Hook mode: speak ONLY when there is something to act on. Silence otherwise.
    const behind = results.filter((r) => r.status === 'behind');
    const updated = results.filter((r) => r.status === 'updated');
    if (behind.length === 0 && updated.length === 0) return;

    const out = ['<self-update>'];
    if (behind.length > 0) {
        out.push('These repos have new commits upstream (nothing has been changed):');
        for (const r of behind) out.push(`- ${r.slug}: ${r.detail}`);
        out.push('');
        out.push('ASK THE USER whether to update. Only if they agree, run:');
        for (const r of behind) out.push(`  ${r.cmd}`);
        out.push('Then tell them to restart Claude Code so the new hook code loads.');
    }
    if (updated.length > 0) {
        out.push('Fast-forwarded:');
        for (const r of updated) out.push(`- ${r.slug}: ${r.detail}`);
    }
    out.push('</self-update>');
    process.stdout.write(out.join('\n') + '\n');
}

/** --check: report what WOULD happen without fetching or merging. */
function updateRepoDryRun(repo) {
    const { path: dir, branch, slug } = repo;
    if (!fs.existsSync(path.join(dir, '.git'))) return { slug, status: 'error', detail: 'not a git repo' };
    const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = git(dir, ['status', '--porcelain']);
    const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const parts = [`branch=${current || '?'}`];
    if (current !== branch) parts.push(`(want ${branch})`);
    if (dirty) parts.push(`${dirty.split('\n').filter(Boolean).length} dirty`);
    if (!upstream) parts.push('no upstream');
    const counts = upstream ? git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]) : null;
    if (counts) {
        const [a, b] = counts.split(/\s+/).map(Number);
        parts.push(`${a} ahead / ${b} behind (cached)`);
    }
    return { slug, status: 'info', detail: parts.join(', ') };
}

try { main(); } catch { /* an updater must never break a session */ }
process.exit(0);
