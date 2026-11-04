'use strict';
/**
 * Shell-aware extraction of `git worktree add` targets from a Bash command.
 * Returns { targets: [dir...], unresolved: bool }.
 *  - splits on ; && || | & newline outside quotes; strips ( ) { } grouping
 *  - tracks `cd X` across segments; handles ~, quotes, backslashes
 *  - skips env assignments and wrappers (env, sudo, command, exec, time, nohup)
 *  - skips git global options: -C <p>, -c <kv>, --git-dir[=] , --work-tree[=],
 *    --namespace, --exec-path, --no-pager/-p/--bare/--no-replace-objects/...
 *  - recurses into `bash|sh|zsh -c '<script>'` and `eval`
 *  - unresolved=true when a matched `git worktree add` has a target dir that
 *    cannot be resolved statically ($VAR, backticks, $(...)): caller fails closed.
 */
const os = require('os');
const path = require('path');

function tokenize(cmd) {
    const segs = [];
    let words = [], cur = '', has = false, q = null;
    const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
    const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
        if (q === '"') {
            if (c === '"') q = null;
            else if (c === '\\' && i + 1 < cmd.length) cur += cmd[++i];
            else cur += c;
            continue;
        }
        if (c === "'" || c === '"') { q = c; has = true; continue; }
        if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
        if (c === ';' || c === '\n' || c === '|' || c === '&') { endSeg(); continue; }
        if (c === '(' || c === ')' || c === '{' || c === '}') { endWord(); continue; }
        if (c === ' ' || c === '\t') { endWord(); continue; }
        cur += c; has = true;
    }
    endSeg();
    return segs;
}

const dynamic = (s) => /[$`]/.test(s);
const expandTilde = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'builtin']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const OPT_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

function scan(cmd, cwd0, out, depth) {
    let cwd = cwd0; // null once a dynamic cd makes it unknowable
    for (const w of tokenize(cmd)) {
        let i = 0;
        while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(path.basename(w[i])))) i++;
        const prog = w[i] ? path.basename(w[i]) : '';
        if (prog === 'cd' || prog === 'pushd') {
            const t = w[i + 1];
            cwd = t === undefined ? os.homedir() : (cwd === null || dynamic(t) || t === '-') ? null : path.resolve(cwd, expandTilde(t));
            continue;
        }
        if (depth < 4 && SHELLS.has(prog)) {
            const ci = w.findIndex((x, k) => k > i && /^-[a-z]*c[a-z]*$/.test(x));
            if (ci >= 0 && w[ci + 1] !== undefined) scan(w[ci + 1], cwd, out, depth + 1);
            continue;
        }
        if (depth < 4 && prog === 'eval') { scan(w.slice(i + 1).join(' '), cwd, out, depth + 1); continue; }
        if (prog !== 'git') continue;
        let j = i + 1, target = cwd, unresolved = cwd === null, gitDir = null;
        for (; j < w.length && w[j].startsWith('-'); j++) {
            const o = w[j];
            const eq = o.indexOf('=');
            const name = eq > 0 ? o.slice(0, eq) : o;
            let val = eq > 0 ? o.slice(eq + 1) : null;
            if (OPT_WITH_ARG.has(name) && val === null) val = w[++j];
            if (val === undefined) { unresolved = true; break; }
            if (name === '-C') {
                if (dynamic(val) || target === null) { unresolved = true; target = null; }
                else target = path.resolve(target, expandTilde(val));
            } else if ((name === '--git-dir' || name === '--work-tree') && val !== null) {
                if (dynamic(val)) unresolved = true;
                else gitDir = path.resolve(target || cwd0, expandTilde(val));
            }
        }
        if (w[j] === 'worktree' && w[j + 1] === 'add') {
            if (gitDir) target = path.basename(gitDir) === '.git' ? path.dirname(gitDir) : gitDir;
            out.targets.push(unresolved && !gitDir ? null : target);
            if (unresolved && !gitDir) out.unresolved = true;
        }
    }
}

function worktreeAddTargets(cmd, cwd) {
    const out = { targets: [], unresolved: false };
    scan(String(cmd), cwd, out, 0);
    return out;
}

module.exports = { worktreeAddTargets, tokenize };
