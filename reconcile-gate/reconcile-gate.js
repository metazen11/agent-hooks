#!/usr/bin/env node
/**
 * reconcile-gate — strict-block hook for the branching contract.
 *
 * LOCATION: ~/.claude/hooks/reconcile-gate.js (symlinked by install.js)
 *
 * The branching contract (see global CLAUDE.md → "Branching & Integration
 * Process"):
 *
 *   - Production trunk = main (or master)
 *   - Global default: feature branch → squash PR → main, gated by CI,
 *     independent code review and auditor PASS. A human approval gate is opt-in
 *     per repo via GitHub branch protection.
 *   - This hook enforces that only where a repo has opted in (marker on main);
 *     otherwise it keeps the two-trunk rule: PRs ONLY for
 *     `integration-trunk → production-trunk`.
 *
 * A `gh pr create` invocation is refused unless:
 *
 *   1. --base is the production trunk (main or master), AND
 *   2. --head is the integration trunk (dev or develop), UNLESS the repo
 *      opted into single-trunk with `{"model":"single-trunk"}` in
 *      .reconcile-gate.json on the SHA-verified origin/main (any head allowed)
 *
 * Config is trusted only when origin names the repo gh targets. Every segment of a
 * chained command (`;`, `&&`, `||`, `|`, newline) is inspected.
 * Also always denied: `gh pr merge --admin[=..]`, `git push` to main/master
 * (refspec, bare/current-branch, --all/--mirror).
 * NOT covered: MCP tools (e.g. anvil create_pr / git_push) bypass this hook.
 *
 * A repo may add allowed (base, head) pairs via `.reconcile-gate.json`
 * committed on its production trunk (see README → Per-project override);
 * a broken config fails closed.
 *
 * Bypass requires `--force-anyway` anywhere in the command. The bypass is
 * intentionally ugly so it shows up in transcripts and audits.
 *
 * HOOK INPUT (stdin):
 *   {
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "gh pr create --base main --head dev" }
 *   }
 *
 * Decision output (stdout):
 *   Allow:
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *      "permissionDecision":"allow"}}
 *   Deny:
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *      "permissionDecision":"deny",
 *      "permissionDecisionReason":"<explanation>"}}
 *
 * The hook inspects only `gh pr create`, `gh pr merge --admin` and `git push`
 * segments (programs must be exactly `gh`/`git`, so `mygh pr create` or text
 * in comments/quotes is not matched). Everything else passes through.
 *
 * Known limits (accidental-misuse threat model): not a shell parser. Not
 * understood: `bash -c "..."`, `$(...)`, backticks, wrappers (`env`, `sudo`),
 * aliases. `cd` targets and relative `-C` paths are NOT followed for repo
 * state: branch/upstream/origin checks use the hook's cwd (or an absolute
 * `-C`), not the directory the chained command moves to.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

// ── Constants ────────────────────────────────────────────────

const PROD_TRUNKS = new Set(['main', 'master']);
const INTEGRATION_TRUNKS = new Set(['dev', 'develop']);

const BYPASS_FLAG = '--force-anyway';

// Per-project override: `.reconcile-gate.json` at the repo root, read ONLY
// from the committed production-trunk ref (never the working tree) so that
// widening the gate requires a human-reviewed merge to the production trunk.
// Project rules take precedence over the global default (CLAUDE.md carve-out),
// e.g. a repo whose own contract requires feature-branch → dev PRs.
const PROJECT_CONFIG = '.reconcile-gate.json';
// Remote-tracking refs only: local branches are agent-writable.
const TRUNK_REFS = ['origin/main', 'origin/master'];
const ANY = '*';
const SINGLE_TRUNK = 'single-trunk';
const GH_TIMEOUT_MS = 1500;

// ── Helpers ──────────────────────────────────────────────────

function readHookInput() {
    try {
        const stdin = fs.readFileSync(0, 'utf8');
        if (stdin) return JSON.parse(stdin);
    } catch (e) {
        // No stdin or invalid JSON
    }
    return {};
}

function allow() {
    console.log(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
        },
    }));
    process.exit(0);
}

function deny(reason) {
    console.log(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

/**
 * Split a shell command into segments (on `;`, `&&`, `||`, `|`, `&`, newline;
 * quote-aware) and tokenize each, respecting single and double quotes. Not a
 * full shell parser: backslash escapes, `$(...)`, backticks, `bash -c "..."`,
 * wrappers (`env`, `sudo`) and aliases are NOT understood. The threat model is
 * accidental misuse, not an adversary (who can always use --force-anyway).
 */
function splitSegments(cmd) {
    cmd = stripNonExecutableHereDocs(cmd);
    const segs = [];
    let tokens = [], cur = '', has = false, quote = null;
    const endTok = () => { if (cur !== '' || has) tokens.push(cur); cur = ''; has = false; };
    const endSeg = () => { endTok(); if (tokens.length) segs.push(tokens); tokens = []; };
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === quote) quote = null; else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch; has = true;
        } else if (ch === ';' || ch === '\n') {
            endSeg();
        } else if (ch === '&' || ch === '|') {
            if (cmd[i + 1] === ch) i++;
            endSeg();
        } else if (/\s/.test(ch)) {
            endTok();
        } else {
            cur += ch;
        }
    }
    endSeg();
    return segs;
}

// A quoted note passed to `cat <<EOF` is data, not a second shell program.
// Keep executable heredocs (bash/sh/zsh/node) visible to the normal parser.
function stripNonExecutableHereDocs(cmd) {
    const lines = String(cmd || '').split('\n');
    const out = [];
    let delimiter = null;
    for (const line of lines) {
        if (delimiter) {
            if (line.trim() === delimiter) delimiter = null;
            continue;
        }
        const marker = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
        if (marker) {
            const before = line.slice(0, marker.index).trim();
            const first = before.split(/\s+/)[0];
            if (['cat', 'echo', 'printf', 'tee'].includes(first)) {
                delimiter = marker[2];
            }
        }
        out.push(line);
    }
    return out.join('\n');
}

/**
 * Reduce one segment to { prog, args, repo, dir }: strip leading VAR=val
 * assignments and git/gh global options (`git -C <dir> -c k=v`, `gh -R <repo>`
 * / `--repo <repo>`). Returns null unless the program is git or gh.
 */
function normalize(tokens) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const prog = tokens[i];
    if (prog !== 'git' && prog !== 'gh') return null;
    i++;
    let repo, dir;
    while (i < tokens.length) {
        const t = tokens[i];
        if (prog === 'git') {
            if (t === '-C') { dir = tokens[i + 1]; i += 2; continue; }
            if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
            if (t.startsWith('-')) { i++; continue; }
        } else {
            if (t === '-R' || t === '--repo') { repo = tokens[i + 1]; i += 2; continue; }
            if (t.startsWith('--repo=')) { repo = t.slice('--repo='.length); i++; continue; }
            if (/^-R./.test(t)) { repo = t.slice(2); i++; continue; }
        }
        break;
    }
    return { prog, args: tokens.slice(i), repo, dir };
}

/**
 * Extract `--base` and `--head` from tokenized argv. Supports both
 * `--base main` (two tokens) and `--base=main` (one token) forms.
 * Returns { base, head, bypass, repo } — any of which may be undefined / false.
 */
function parseArgs(tokens) {
    let base, head, bypass = false, repo;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === BYPASS_FLAG) bypass = true;
        else if (t === '-R' || t === '--repo') repo = tokens[i + 1];
        else if (t.startsWith('--repo=')) repo = t.slice('--repo='.length);
        else if (/^-R./.test(t)) repo = t.slice(2);
        else if (t === '-B' || t === '--base') base = tokens[i + 1];
        else if (t === '-H' || t === '--head') head = tokens[i + 1];
        else if (/^-B./.test(t)) base = t.slice(2);
        else if (/^-H./.test(t)) head = t.slice(2);
        else if (t.startsWith('--base=')) base = t.slice('--base='.length);
        else if (t.startsWith('--head=')) head = t.slice('--head='.length);
    }
    return { base, head, bypass, repo };
}

// The host kills this hook at 5s; keep total git work well under that.
const GIT_TIMEOUT_MS = 500;
const LS_REMOTE_TIMEOUT_MS = 1200;

function git(cwd, ...args) {
    const last = args[args.length - 1];
    const timeout = typeof last === 'number' ? args.pop() : GIT_TIMEOUT_MS;
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout,
    });
}

// owner/repo (lowercased) from a GitHub URL, `HOST/OWNER/REPO` or `OWNER/REPO`.
function ownerRepo(str) {
    const parts = String(str || '').trim().replace(/\.git\/?$/, '').replace(/\/+$/, '').split(/[/:]+/);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase() : null;
}

/**
 * True only when origin's URL names the same GitHub owner/repo gh will target
 * (the -R/--repo value, else `gh repo view`). Any failure, timeout or
 * mismatch is false => two-trunk (fail closed).
 */
function originIsGhTarget(root, repoFlag) {
    try {
        const url = git(root, 'config', '--get', 'remote.origin.url').trim();
        if (!/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]/i.test(url)) return false;
        let target = repoFlag;
        if (!target) {
            target = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
                { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GH_TIMEOUT_MS });
        }
        const a = ownerRepo(url), b = ownerRepo(target);
        return !!a && a === b;
    } catch (e) { return false; }
}

/**
 * The allowed (base, head) pairs. The default is ALWAYS two-trunk (production
 * trunks × integration trunks). Single-trunk is a POSITIVE opt-in: the
 * project config declares `{"model":"single-trunk"}` (or the equivalent
 * `allowed: [{base:"main", head:"*"}]`). Absence of a dev branch never implies
 * it: offline, shallow clones and forged refs all look like "no dev".
 * A project config (`allowed: [{base, head}]`, head "*" = any) ADDS
 * pairs — it never widens bases and heads independently, so allowing
 * feature → dev does not also allow feature → main.
 *
 * The config is trusted only when committed on the production trunk, found
 * via the git toplevel of cwd, and the command does not target another repo
 * (`--repo`). Fails closed: a config that exists but is unparsable or
 * mistyped returns { error } rather than reverting to the defaults.
 */
function resolveRules(cwd, repoFlag) {
    const pairs = [];
    let singleTrunk = false;
    for (const b of PROD_TRUNKS) for (const h of INTEGRATION_TRUNKS) pairs.push({ base: b, head: h });
    if (!cwd) return { pairs, singleTrunk };

    let root;
    try { root = git(cwd, 'rev-parse', '--show-toplevel').trim(); } catch (e) { return { pairs, singleTrunk }; }

    // Per candidate trunk: resolve the fully-qualified tracking ref to a sha
    // ONCE, confirm it equals what the real remote holds (refs/remotes/* is
    // locally writable), then read the blob BY THAT SHA so nothing can change
    // between check and read. Untrusted/unreachable candidates are skipped;
    // with none trusted the stricter defaults apply.
    let raw = null, ref = null;
    for (const r of TRUNK_REFS) {
        let sha;
        const branch = r.slice('origin/'.length);
        try { sha = git(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/${r}^{commit}`).trim(); }
        catch (e) { continue; } // this trunk ref does not exist: try the next
        // First EXISTING trunk ref is authoritative: a stale origin/master must
        // never be consulted when origin/main exists but is unverifiable.
        try {
            const remote = git(root, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`, LS_REMOTE_TIMEOUT_MS)
                .split(/\s/)[0];
            if (sha && sha === remote) {
                raw = git(root, 'show', `${sha}:${PROJECT_CONFIG}`);
                ref = r;
            }
        } catch (e) { /* no config / untrusted / offline: two-trunk defaults */ }
        break;
    }
    if (raw === null) return { pairs, singleTrunk };
    // origin could have been repointed (`git remote set-url`) at a repo the
    // agent controls; only trust config when origin names the repo gh targets.
    if (!originIsGhTarget(root, repoFlag)) return { pairs, singleTrunk };

    const where = `${PROJECT_CONFIG} @ ${ref}`;
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return { error: `${where} is not valid JSON (${e.message})` }; }
    if (!cfg || typeof cfg !== 'object') return { error: `${where} must be a JSON object` };
    const hasModel = cfg.model !== undefined;
    if (hasModel && cfg.model !== SINGLE_TRUNK) {
        return { error: `${where}: "model" must be "${SINGLE_TRUNK}" (got ${JSON.stringify(cfg.model)})` };
    }
    const allowed = cfg.allowed === undefined && hasModel ? [] : cfg.allowed;
    const ok = Array.isArray(allowed) && allowed.every(
        (p) => p && typeof p.base === 'string' && p.base && typeof p.head === 'string' && p.head && p.base !== ANY);
    if (!ok) return { error: `${where}: "allowed" must be an array of {base, head} non-empty strings (base may not be "*")` };
    if (hasModel) for (const b of PROD_TRUNKS) pairs.push({ base: b, head: ANY });
    pairs.push(...allowed);
    singleTrunk = hasModel || allowed.some((p) => PROD_TRUNKS.has(p.base) && p.head === ANY);
    return { pairs, singleTrunk };
}

// Why a `git push` must be denied, or null. `rest` = args after `push`.
// Denies --all/--mirror outright; any refspec whose destination is main/master
// (`main`, `HEAD:main`, `+x:refs/heads/master`, `:refs/heads/main`), regardless
// of remote name; and pushes that land on the CURRENT branch when it is (or its
// push target is) main/master: bare push, `git push origin`, `... HEAD`,
// `--tags`. Branch/upstream resolution failure (detached HEAD, no upstream) is
// fail-closed. Flags that take a value (`-o x`) may shift positional parsing,
// which errs toward inspecting more.
function pushDenyReason(rest, cwd) {
    if (rest.some((t) => t === '--all' || t === '--mirror')) {
        return 'git push --all/--mirror can update main/master and is never allowed.';
    }
    const pos = rest.filter((t) => !t.startsWith('-'));
    const remote = pos[0], specs = pos.slice(1);
    let usesCurrent = specs.length === 0;
    for (const spec of specs) {
        if (spec === 'HEAD' || spec === '+HEAD') { usesCurrent = true; continue; }
        const dst = spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
        if (PROD_TRUNKS.has(dst)) return 'direct git push to main/master is never allowed.';
    }
    if (!usesCurrent) return null;
    const fix = ' Push an explicit feature branch (git push -u origin HEAD:<branch>) and open a PR.';
    let branch;
    try { branch = git(cwd, 'symbolic-ref', '--short', 'HEAD').trim(); }
    catch (e) { return 'cannot resolve the current branch (detached HEAD or not a repo), failing closed.' + fix; }
    if (PROD_TRUNKS.has(branch)) return `the current branch is ${branch}; pushing it is never allowed.` + fix;
    if (specs.length === 0) {
        // No refspec: the push target comes from config (push.default=upstream
        // sends `git push origin` to the upstream branch). With no explicit
        // remote an unresolvable target fails closed; with one, only a
        // resolved main/master target denies.
        let up = null;
        try { up = git(cwd, 'rev-parse', '--abbrev-ref', '@{push}').trim(); }
        catch (e) { if (!remote) return 'cannot resolve the push target of a bare git push, failing closed.' + fix; }
        if (up && PROD_TRUNKS.has(up.slice(up.indexOf('/') + 1))) return `the push target is ${up}; never allowed.` + fix;
    }
    return null;
}

const MERGE_ADMIN = 'reconcile-gate: gh pr merge --admin overrides branch protection and is never allowed. ' +
    'Merge only after required checks and reviews pass, without --admin.';

// Gate a `gh pr create` segment. Returns a deny reason or null.
function prCreateDenyReason(args, seg, cwd) {
    const { base, head, bypass, repo } = parseArgs(args);
    // Explicit bypass is allowed but loud — the flag appears in transcripts.
    if (bypass) return null;
    // Both --base and --head are required for the gate to evaluate; without
    // them `gh pr create` would prompt interactively, which an agent cannot answer.
    if (!base || !head) {
        return 'reconcile-gate: gh pr create requires --base and --head explicitly ' +
            '(e.g. --base main --head <your-branch>). See global ' +
            'CLAUDE.md → "Branching & Integration Process".';
    }
    const rules = resolveRules(cwd, seg.repo || repo);
    if (rules.error) {
        return `reconcile-gate: invalid project override — ${rules.error}. ` +
            'Fix the file on the production trunk or remove it; the gate fails closed on a broken config.';
    }
    const matches = (p) => p.base === base && (p.head === ANY || p.head === head);
    if (rules.pairs.some(matches)) return null;
    const allowed = rules.pairs.map((p) => `${p.head}→${p.base}`).join(', ');
    return `reconcile-gate: PR ${head}→${base} is not an allowed pair. Allowed: ${allowed}. ` +
        (rules.singleTrunk
            ? 'This repo is single-trunk: PR from your feature branch to main/master, or an allowed pair. '
            : 'Two-trunk rule applies (no single-trunk marker verified on origin/main for the repo gh targets; ' +
              'offline, shallow, repointed-origin or unverifiable git also lands here, fail closed): PRs are ' +
              'allowed only integration-trunk → production-trunk. To opt in to single-trunk, merge ' +
              '{"model":"single-trunk"} as .reconcile-gate.json to main. ') +
        'Override with --force-anyway if intentional.';
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    const input = readHookInput();
    const toolInput = input.tool_input || {};
    if (input.tool_name !== 'Bash') return allow();

    // Every segment of a chained command is inspected (`cd x && gh pr merge --admin`).
    const segs = splitSegments(toolInput.command || '').map(normalize).filter(Boolean);

    // Hard denies first, even with --force-anyway: these bypass the review gate.
    for (const seg of segs) {
        const [a0, a1] = seg.args;
        if (seg.prog === 'gh' && a0 === 'pr' && a1 === 'merge' &&
            seg.args.some((t) => t === '--admin' || t.startsWith('--admin='))) {
            return deny(MERGE_ADMIN);
        }
        if (seg.prog === 'git' && a0 === 'push') {
            const why = pushDenyReason(seg.args.slice(1), seg.dir || input.cwd);
            if (why) return deny(`reconcile-gate: ${why}`);
        }
    }
    for (const seg of segs) {
        if (seg.prog === 'gh' && seg.args[0] === 'pr' && seg.args[1] === 'create') {
            const why = prCreateDenyReason(seg.args.slice(2), seg, input.cwd);
            if (why) return deny(why);
        }
    }
    return allow();
}

main();
