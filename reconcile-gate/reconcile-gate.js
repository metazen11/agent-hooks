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
 * Also always denied: `gh pr merge --admin` and `git push` to main/master.
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
 * The hook intentionally only inspects `gh pr create` invocations. Other
 * `gh` commands and other Bash calls pass through unchanged. Pattern is
 * anchored at the start of the command so `mygh pr create ...` or comments
 * mentioning the string are not blocked.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

// ── Constants ────────────────────────────────────────────────

// Anchored start-of-command match for `gh pr create`. Tolerates leading
// whitespace, env-var prefixes are deliberately ignored (rare and easy to
// catch by reading the deny reason).
const GH_PR_CREATE_PATTERN = /^\s*gh\s+pr\s+create\b/;

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
const GH_PR_MERGE_PATTERN = /^\s*gh\s+pr\s+merge\b/;
const GIT_PUSH_PATTERN = /^\s*git\s+push\b/;

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
 * Tokenize a shell command into argv-ish tokens, respecting single and
 * double quotes. Not a full shell parser — sufficient for `gh pr create`
 * argument detection where complex quoting is rare. Backslash escapes are
 * not honored.
 */
function tokenize(cmd) {
    const tokens = [];
    let cur = '';
    let quote = null;
    for (const ch of cmd) {
        if (quote) {
            if (ch === quote) { quote = null; }
            else { cur += ch; }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (/\s/.test(ch)) {
            if (cur) { tokens.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) tokens.push(cur);
    return tokens;
}

/**
 * Extract `--base` and `--head` from tokenized argv. Supports both
 * `--base main` (two tokens) and `--base=main` (one token) forms.
 * Returns { base, head, bypass, repo } — any of which may be undefined / false.
 */
function parseArgs(tokens) {
    let base, head, bypass = false, repo = false;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === BYPASS_FLAG) bypass = true;
        else if (t.startsWith('-R') || t === '--repo' || t.startsWith('--repo=')) repo = true;
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
function resolveRules(cwd, targetsOtherRepo) {
    const pairs = [];
    let singleTrunk = false;
    for (const b of PROD_TRUNKS) for (const h of INTEGRATION_TRUNKS) pairs.push({ base: b, head: h });
    if (targetsOtherRepo || !cwd) return { pairs, singleTrunk };

    let root;
    try { root = git(cwd, 'rev-parse', '--show-toplevel').trim(); } catch (e) { return { pairs, singleTrunk }; }

    // Per candidate trunk: resolve the fully-qualified tracking ref to a sha
    // ONCE, confirm it equals what the real remote holds (refs/remotes/* is
    // locally writable), then read the blob BY THAT SHA so nothing can change
    // between check and read. Untrusted/unreachable candidates are skipped;
    // with none trusted the stricter defaults apply.
    let raw = null, ref = null;
    for (const r of TRUNK_REFS) {
        try {
            const branch = r.slice('origin/'.length);
            const sha = git(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/${r}^{commit}`).trim();
            const remote = git(root, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`, LS_REMOTE_TIMEOUT_MS)
                .split(/\s/)[0];
            if (!sha || sha !== remote) continue;
            raw = git(root, 'show', `${sha}:${PROJECT_CONFIG}`);
            ref = r;
            break;
        } catch (e) { /* no config / untrusted / offline: try next */ }
    }
    if (raw === null) return { pairs, singleTrunk };

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

// True when any refspec of a `git push` targets a production trunk, e.g.
// `main`, `HEAD:main`, `+x:refs/heads/master`, `:refs/heads/main` (delete).
// First positional is the remote; flags are skipped (a flag taking a value,
// e.g. `-o x`, may shift this by one: that errs toward inspecting more).
function pushesToProdTrunk(tokens) {
    const pos = tokens.slice(2).filter((t) => !t.startsWith('-'));
    return pos.slice(1).some((spec) => {
        const dst = spec.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
        return PROD_TRUNKS.has(dst);
    });
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    const input = readHookInput();
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const cmd = toolInput.command || '';

    if (toolName === 'Bash') {
        // Always denied, even with --force-anyway: these bypass the review gate.
        const t = tokenize(cmd);
        if (GH_PR_MERGE_PATTERN.test(cmd) && t.includes('--admin')) {
            return deny('reconcile-gate: gh pr merge --admin overrides branch protection and is never allowed. ' +
                'Merge only after required checks and reviews pass, without --admin.');
        }
        if (GIT_PUSH_PATTERN.test(cmd) && pushesToProdTrunk(t)) {
            return deny('reconcile-gate: direct git push to main/master is never allowed. ' +
                'Push a feature branch and open a PR (gh pr create --base main --head <branch>).');
        }
    }

    // Pass through everything that is not a `gh pr create` Bash call.
    if (toolName !== 'Bash' || !GH_PR_CREATE_PATTERN.test(cmd)) {
        return allow();
    }

    const tokens = tokenize(cmd);
    const { base, head, bypass, repo } = parseArgs(tokens);

    // Explicit bypass is allowed but loud — the flag appears in transcripts.
    if (bypass) {
        return allow();
    }

    // Both --base and --head are required for the gate to evaluate. If they
    // are missing, `gh pr create` would prompt interactively for them anyway,
    // which is a different failure mode (agent can't answer prompts). Refuse
    // with a clear message.
    if (!base || !head) {
        return deny(
            'reconcile-gate: gh pr create requires --base and --head explicitly ' +
            '(e.g. --base main --head <your-branch>). See global ' +
            'CLAUDE.md → "Branching & Integration Process".'
        );
    }

    const rules = resolveRules(input.cwd, repo);
    if (rules.error) {
        return deny(
            `reconcile-gate: invalid project override — ${rules.error}. ` +
            'Fix the file on the production trunk or remove it; the gate fails closed on a broken config.'
        );
    }

    const matches = (p) => p.base === base && (p.head === ANY || p.head === head);
    if (!rules.pairs.some(matches)) {
        const allowed = rules.pairs.map((p) => `${p.head}→${p.base}`).join(', ');
        return deny(
            `reconcile-gate: PR ${head}→${base} is not an allowed pair. Allowed: ${allowed}. ` +
            (rules.singleTrunk
                ? 'This repo is single-trunk: PR from your feature branch to main/master, or an allowed pair. '
                : 'Two-trunk rule applies (no single-trunk marker verified on origin/main; offline, ' +
                  'shallow or unverifiable git also lands here, fail closed): PRs are allowed only ' +
                  'integration-trunk → production-trunk. To opt in to single-trunk, merge ' +
                  '{"model":"single-trunk"} as .reconcile-gate.json to main. ') +
            'Override with --force-anyway if intentional.'
        );
    }

    return allow();
}

main();
