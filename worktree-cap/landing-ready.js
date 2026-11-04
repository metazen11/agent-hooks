#!/usr/bin/env node
/**
 * landing-ready — record review+audit PASS for a worktree's current HEAD.
 * Usage: landing-ready.js [worktree-path] [--evidence "text"]
 *
 * Run by the ORCHESTRATOR after independent review and audit PASS, never by the
 * implementer. The attestation is written OUTSIDE every worktree (state dir,
 * WORKTREE_CAP_STATE_DIR or ~/.claude/worktree-cap), keyed by repo + full HEAD
 * sha, created exclusively (O_EXCL|O_NOFOLLOW, mode 0600). A later commit
 * changes HEAD, so the attestation no longer applies (re-review required).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function die(msg) { console.error(`landing-ready: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const ei = args.indexOf('--evidence');
const evidence = ei >= 0 ? lib.clean(args.splice(ei, 2)[1] || '', 500) : '';
const wt = path.resolve(args[0] || process.cwd());
const head = lib.tryGit(wt, ['rev-parse', 'HEAD']);
if (!head || !lib.SHA40.test(head)) die(`${lib.clean(wt)} is not a git worktree with a 40-char HEAD`);
const toplevel = fs.realpathSync(lib.tryGit(wt, ['rev-parse', '--show-toplevel']));
const root = fs.realpathSync(lib.repoRoot(wt));
if (toplevel === root) die('refusing to mark the MAIN worktree; pass an agent worktree path');

fs.mkdirSync(lib.stateDir(), { recursive: true, mode: 0o700 });
const state = fs.realpathSync(lib.stateDir());
if (state === root || state.startsWith(root + path.sep)) die('state dir is inside the repo; set WORKTREE_CAP_STATE_DIR outside it');
const file = lib.attestationPath(root, head);
const dir = path.dirname(file);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!fs.lstatSync(dir).isDirectory()) die('attestation dir is not a real directory');

const body = `review: APPROVE ${head}\naudit: PASS ${head}\n${evidence ? evidence + '\n' : ''}`;
try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, body);
    fs.closeSync(fd);
} catch (e) {
    if (e.code === 'EEXIST') {
        if (!fs.lstatSync(file).isFile()) die('attestation path exists and is not a regular file; refusing');
        console.log(`landing-ready: already attested for ${head.slice(0, 10)}`);
        process.exit(0);
    }
    die(`cannot write attestation: ${lib.clean(e.message)}`);
}
console.log(`landing-ready: ${lib.clean(toplevel, 200)} attested for ${head.slice(0, 10)}`);
