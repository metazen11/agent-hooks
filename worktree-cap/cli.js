#!/usr/bin/env node
/**
 * worktree-cap CLI — host-agnostic front end over lib.js (Claude, Codex, Anvil
 * adapters all route through the same lib; this is the shell-callable form).
 *
 *   cli.js check  <repo> [--cap N] [--json]   exit 0 under cap, 2 at/over cap
 *   cli.js report <dir>  [--json]             unlanded/prunable per repo under dir (exit 0)
 *   cli.js stop   <dir>  [--json]             exit 2 if a reviewed+audited worktree is unlanded and not held
 *   cli.js add    <repo> <git worktree add args...>   check, then run `git worktree add`
 *
 * Cap semantics: lib.resolveCap (persisted .worktree-cap, ratchets down only;
 * --cap N or WORKTREE_CAP overrides without persisting).
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { reposUnder } = require('./unlanded-report');

function checkRepo(repoArg, capOverride) {
    const root = lib.repoRoot(path.resolve(repoArg));
    if (!root) return { error: `not a git repository: ${repoArg}`, exit: 1 };
    const s = lib.scan(root);
    if (capOverride) process.env.WORKTREE_CAP = String(capOverride);
    const cap = lib.resolveCap(root, s.unlanded.length);
    const blocked = s.unlanded.length >= cap;
    return { root, cap, count: s.unlanded.length, blocked, scan: s, exit: blocked ? 2 : 0 };
}

function blockText(r) {
    return `worktree-cap: ${r.count} unlanded worktrees open, cap is ${r.cap}. Refusing to open another.\n\n${lib.format(r.scan)}\n\n` +
        `NEXT STEP: land one with /reconcile (or delete it if abandoned). The cap only ratchets down; raise it deliberately by editing ${path.join(r.root, lib.CAP_FILE)}.`;
}

function main(argv) {
    const json = argv.includes('--json');
    const ci = argv.indexOf('--cap');
    let cap;
    if (ci >= 0) {
        cap = argv.splice(ci, 2)[1];
        if (!/^[1-9]\d*$/.test(cap || '')) { console.error('--cap needs a positive integer'); return 1; }
    }
    const [cmd, target = '.', ...rest] = argv.filter((a) => a !== '--json');
    if (process.env.WORKTREE_CAP_DISABLE === 'true' && cmd !== 'report') {
        console.error('[worktree-cap] bypassed via WORKTREE_CAP_DISABLE');
        return cmd === 'add' ? spawnSync('git', ['-C', target, 'worktree', 'add', ...rest], { stdio: 'inherit' }).status : 0;
    }
    switch (cmd) {
        case 'check': case 'add': {
            const r = checkRepo(target, cap);
            if (r.error) { console.error(r.error); return r.exit; }
            if (json) console.log(JSON.stringify({ root: r.root, cap: r.cap, count: r.count, blocked: r.blocked, unlanded: r.scan.unlanded, prunable: r.scan.prunable }));
            else if (r.blocked) console.error(blockText(r));
            else if (cmd === 'check') console.log(`worktree-cap: ${r.count}/${r.cap} unlanded in ${r.root} - ok`);
            if (r.blocked || cmd === 'check') return r.exit;
            return spawnSync('git', ['-C', r.root, 'worktree', 'add', ...rest], { stdio: 'inherit' }).status;
        }
        case 'report': {
            const scans = reposUnder(path.resolve(target)).map((root) => {
                const s = lib.scan(root);
                if (require('fs').existsSync(path.join(root, lib.CAP_FILE))) s.cap = lib.resolveCap(root, s.unlanded.length);
                return s;
            });
            if (json) console.log(JSON.stringify(scans));
            else for (const s of scans) {
                console.log(`${s.root}: ${s.unlanded.length} unlanded${s.cap ? ` (cap ${s.cap})` : ''}, ${s.prunable.length} prunable`);
                const f = lib.format(s); if (f) console.log(f.split('\n').slice(1).join('\n'));
            }
            return 0;
        }
        case 'stop': {
            const { run } = require('./unlanded-report');
            const r = run({ cwd: path.resolve(target), hook_event_name: 'Stop' });
            if (json) console.log(JSON.stringify({ blockers: r.blockers }));
            else if (r.blockers.length) console.error(`Reviewed+audited work has not landed:\n${r.blockers.map((w) => '  ' + w.path).join('\n')}\nLand it (/reconcile) or write a reason to <worktree>/${lib.HOLD}.`);
            return r.blockers.length ? 2 : 0;
        }
        default:
            console.error('usage: cli.js check|report|stop <dir> [--cap N] [--json] | add <repo> <git worktree add args>');
            return 1;
    }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
