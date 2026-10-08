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
 *   - Integration trunk = dev (or develop)
 *   - Routine agent work lands on the integration trunk via the `reconciler`
 *     specialist / `/reconcile` skill — no GitHub PR.
 *   - PRs are ONLY for `integration-trunk → production-trunk`. That is the
 *     single human-review gate.
 *
 * This hook enforces rule #3 at tool-call time. A `gh pr create` invocation
 * is refused unless:
 *
 *   1. --base is the production trunk (main or master), AND
 *   2. --head is the integration trunk (dev or develop)
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
 * The allowed (base, head) pairs. Defaults are production trunks × integration
 * trunks. A project config (`allowed: [{base, head}]`, head "*" = any) ADDS
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
    for (const b of PROD_TRUNKS) for (const h of INTEGRATION_TRUNKS) pairs.push({ base: b, head: h });
    if (targetsOtherRepo || !cwd) return { pairs };

    let root;
    try { root = git(cwd, 'rev-parse', '--show-toplevel').trim(); } catch (e) { return { pairs }; }

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
    if (raw === null) return { pairs };

    const where = `${PROJECT_CONFIG} @ ${ref}`;
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return { error: `${where} is not valid JSON (${e.message})` }; }
    const ok = cfg && Array.isArray(cfg.allowed) && cfg.allowed.every(
        (p) => p && typeof p.base === 'string' && p.base && typeof p.head === 'string' && p.head && p.base !== ANY);
    if (!ok) return { error: `${where}: "allowed" must be an array of {base, head} non-empty strings (base may not be "*")` };
    pairs.push(...cfg.allowed);
    return { pairs };
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    const input = readHookInput();
    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const cmd = toolInput.command || '';

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
            'reconcile-gate: gh pr create requires --base and --head explicitly. ' +
            'The branching contract permits PRs only for integration-trunk → ' +
            'production-trunk (e.g. --base main --head dev). See global ' +
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
            'The branching contract permits PRs only for integration-trunk → ' +
            'production-trunk. For routine agent work, use the reconciler ' +
            'specialist or /reconcile skill to land on the integration trunk ' +
            'without a PR. Override with --force-anyway if intentional.'
        );
    }

    return allow();
}

main();
