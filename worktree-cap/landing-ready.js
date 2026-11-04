#!/usr/bin/env node
/**
 * landing-ready — drop the .landing-ready marker AFTER independent review and
 * audit PASS. Usage: landing-ready.js [worktree-path] [--evidence "text"]
 * Writes `review: APPROVE <sha>` / `audit: PASS <sha>` for the worktree's
 * current HEAD; any later commit invalidates the marker (re-review required).
 * Called by the orchestrator, never by the implementer for its own work.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const args = process.argv.slice(2);
const ei = args.indexOf('--evidence');
const evidence = ei >= 0 ? args.splice(ei, 2)[1] || '' : '';
const wt = path.resolve(args[0] || process.cwd());
const head = lib.tryGit(wt, ['rev-parse', 'HEAD']);
if (!head) { console.error(`landing-ready: ${wt} is not a git worktree`); process.exit(1); }
const toplevel = lib.tryGit(wt, ['rev-parse', '--show-toplevel']);
if (fs.realpathSync(toplevel) === fs.realpathSync(lib.repoRoot(wt))) {
    console.error('landing-ready: refusing to mark the MAIN worktree; pass an agent worktree path');
    process.exit(1);
}
fs.writeFileSync(path.join(toplevel, lib.READY),
    `review: APPROVE ${head}\naudit: PASS ${head}\n${evidence ? evidence + '\n' : ''}`);
// Keep markers out of `git add -A` (info/exclude is shared across worktrees).
const exclude = path.resolve(toplevel, lib.tryGit(toplevel, ['rev-parse', '--git-path', 'info/exclude']));
fs.mkdirSync(path.dirname(exclude), { recursive: true });
let cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
for (const f of [lib.READY, lib.HOLD]) {
    if (!cur.split('\n').includes(f)) { cur += `${cur === '' || cur.endsWith('\n') ? '' : '\n'}${f}\n`; }
}
fs.writeFileSync(exclude, cur);
console.log(`landing-ready: ${toplevel} marked for ${head.slice(0, 10)}`);
