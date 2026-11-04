#!/usr/bin/env node
/**
 * unlanded-report — SessionStart + Stop hook.
 *
 * SessionStart: print unlanded/prunable agent worktrees for the repo at cwd and
 *   every git repo one level below it (the fire-map folder holds several repos).
 *   Also applies the cap ratchet (only for repos that already have .worktree-cap).
 * Stop: same list, and BLOCK stopping while any worktree is reviewed+audited
 *   (valid .landing-ready for its current HEAD) but unlanded, unless that
 *   worktree has a non-empty .landing-hold stating why. stop_hook_active is
 *   deliberately NOT an escape hatch: land it or write the hold.
 * Bypass: WORKTREE_CAP_DISABLE=true.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function reposUnder(cwd) {
    const roots = new Set();
    const own = lib.repoRoot(cwd);
    if (own) roots.add(own);
    let entries = [];
    try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { /* unreadable cwd */ }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const child = path.join(cwd, e.name);
        if (fs.existsSync(path.join(child, '.git'))) {
            const r = lib.repoRoot(child);
            if (r) roots.add(r);
        }
    }
    return [...roots];
}

function run(input) {
    const scans = reposUnder(input.cwd || process.cwd()).map((r) => lib.scan(r));
    for (const s of scans) {
        if (fs.existsSync(path.join(s.root, lib.CAP_FILE))) { try { lib.resolveCap(s.root, s.unlanded.length); } catch (e) { process.stderr.write(`[unlanded-report] ${e.message}\n`); } }
    }
    const report = scans.map(lib.format).filter(Boolean).join('\n\n');
    const stop = input.hook_event_name === 'Stop';
    const blockers = stop ? scans.flatMap((s) => s.unlanded.filter((w) => w.ready && !w.hold)) : [];
    return { report, blockers, stop };
}

function main() {
    if (process.env.WORKTREE_CAP_DISABLE === 'true') return;
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* run on cwd */ }
    let r;
    try { r = run(input); } catch (e) {
        process.stderr.write(`[unlanded-report] internal error: ${e.message}\n`);
        return;
    }
    if (r.stop && r.blockers.length) {
        const paths = r.blockers.map((w) => `  ${w.path}`).join('\n');
        process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: `Reviewed+audited work has not landed:\n${paths}\n\n${r.report}\n\n` +
                `Land it now (/reconcile), or if landing must wait write the reason to <worktree>/${lib.HOLD}.`,
        }));
    } else if (r.report) {
        process.stdout.write(JSON.stringify(r.stop
            ? { systemMessage: `Unlanded worktrees:\n${r.report}` }
            : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Unlanded agent worktrees (land or delete before opening more):\n${r.report}` } }));
    }
}

if (require.main === module) main();
module.exports = { run, reposUnder };
