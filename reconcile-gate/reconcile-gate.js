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

// ── Constants ────────────────────────────────────────────────

// Anchored start-of-command match for `gh pr create`. Tolerates leading
// whitespace, env-var prefixes are deliberately ignored (rare and easy to
// catch by reading the deny reason).
const GH_PR_CREATE_PATTERN = /^\s*gh\s+pr\s+create\b/;

const PROD_TRUNKS = new Set(['main', 'master']);
const INTEGRATION_TRUNKS = new Set(['dev', 'develop']);

const BYPASS_FLAG = '--force-anyway';

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
 * Returns { base, head, bypass } — any of which may be undefined / false.
 */
function parseArgs(tokens) {
    let base, head, bypass = false;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === BYPASS_FLAG) bypass = true;
        else if (t === '-B' || t === '--base') base = tokens[i + 1];
        else if (t === '-H' || t === '--head') head = tokens[i + 1];
        else if (t.startsWith('--base=')) base = t.slice('--base='.length);
        else if (t.startsWith('--head=')) head = t.slice('--head='.length);
    }
    return { base, head, bypass };
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
    const { base, head, bypass } = parseArgs(tokens);

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

    if (!PROD_TRUNKS.has(base)) {
        return deny(
            `reconcile-gate: PR --base "${base}" is not a production trunk. ` +
            `Allowed bases: ${[...PROD_TRUNKS].join(', ')}. ` +
            'The branching contract permits PRs only for integration-trunk → ' +
            'production-trunk. For routine agent work, use the reconciler ' +
            'specialist or /reconcile skill to land on the integration trunk ' +
            'without a PR. Override with --force-anyway if intentional.'
        );
    }

    if (!INTEGRATION_TRUNKS.has(head)) {
        return deny(
            `reconcile-gate: PR --head "${head}" is not an integration trunk. ` +
            `Allowed heads: ${[...INTEGRATION_TRUNKS].join(', ')}. ` +
            'The branching contract permits PRs only for integration-trunk → ' +
            'production-trunk (i.e. --head dev or --head develop). For routine ' +
            'work, the reconciler lands changes on the integration trunk first; ' +
            'a PR is only needed for the periodic integration → production batch. ' +
            'Override with --force-anyway if intentional.'
        );
    }

    return allow();
}

main();
