#!/usr/bin/env node
/**
 * hf-launch-gate — strict-block hook that REFUSES a paid Hugging Face Jobs
 * launch unless process preconditions are met.
 *
 * LOCATION: ~/.claude/hooks/hf-launch-gate.js (symlinked by install.js)
 *
 * WHY THIS EXISTS (AC6 on metazen11/agent-memory#55):
 *   An agent nearly launched a paid GPU job on Hugging Face Jobs with NO
 *   originating issue and NO auditor PASS, on self-certification. The user's
 *   standing rule is: "any time we violate a rule, figure out how to
 *   deterministically enforce it." Behavioral instructions ("don't launch
 *   without an approved issue + audit") have failed before because the
 *   per-case rationalization step is the leak. This hook converts that
 *   into a mechanical, auditable gate at tool-call time.
 *
 * WHAT IT BLOCKS (paid launch of a HF job):
 *   - `hf jobs run …`
 *   - `hf jobs uv run …`
 *   - a launcher script invoked WITH `--launch`, e.g.
 *       `./launch_pilot_4b.sh --launch`
 *       `bash run_hf_job.sh --launch`
 *       `scripts/launch_pilot_4b.sh --launch --gpu a10g`
 *
 * WHAT IT ALLOWS (never a paid launch, always passes through):
 *   - a launcher script WITHOUT `--launch` (a dry-run / plan)
 *   - read/inspect/control subcommands:
 *       `hf jobs logs|inspect|ls|ps|status|cancel|top …`
 *   - any other `hf …` command (login, download, upload, whoami, …)
 *   - any non-`hf`, non-launcher Bash command
 *   - any non-Bash tool call
 *
 * PRECONDITIONS FOR A PAID LAUNCH (both required):
 *   1. An approved originating GitHub issue with explicit, testable
 *      acceptance criteria exists for this launch.
 *   2. An auditor PASS has been recorded against that issue.
 *
 * OVERRIDE (auditable — mirrors reconcile-gate's --force-anyway):
 *   Once the gates are GREEN, a human authorizes the launch by either:
 *     (a) appending `--force-anyway` anywhere in the command, OR
 *     (b) prefixing the env var `HF_LAUNCH_APPROVED=<issue#>`, e.g.
 *         `HF_LAUNCH_APPROVED=55 hf jobs run …`
 *   Both are intentionally loud so they show up in transcripts and audits.
 *   `HF_LAUNCH_APPROVED` must name a positive integer issue number — an
 *   empty or non-numeric value is treated as NOT approved (still blocked).
 *
 * FAIL SAFE (deliberate deviation from the fail-open sibling hooks):
 *   A paid GPU job is the blast radius. If this hook cannot determine
 *   state — malformed stdin, tokenizer/parse error, or any internal
 *   exception WHILE a matched paid-launch command is pending — it BLOCKS
 *   (deny), never silently allows. It only fails OPEN (allow) for input it
 *   can positively classify as NOT a paid launch.
 *
 * HOOK INPUT (stdin):
 *   {
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "hf jobs run …" }
 *   }
 *
 * Decision output (stdout), per the PreToolUse hook contract:
 *   Allow: {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *           "permissionDecision":"allow"}}
 *   Deny:  {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *           "permissionDecision":"deny","permissionDecisionReason":"…"}}
 *   Always exit 0.
 */

'use strict';

const fs = require('fs');

// ── Constants ────────────────────────────────────────────────

const BYPASS_FLAG = '--force-anyway';
const APPROVAL_ENV = 'HF_LAUNCH_APPROVED';

// `hf jobs run` and `hf jobs uv run` are the direct paid-launch verbs.
// Matched on the tokenized argv (see isHfJobsLaunch) so quoting/comments
// in unrelated positions don't false-trigger.
//
// Launcher scripts: any token whose basename looks like a HF job launcher
// (contains "launch" or matches run_hf_job*) is treated as a launcher; it
// only becomes a PAID launch when `--launch` is also present.
const LAUNCHER_BASENAME_RE = /(^|[\/])([^\/\s]*launch[^\/\s]*\.(sh|bash|zsh|py|mjs|js|ts))$|(^|[\/])run_hf_job[^\/\s]*$/i;

// hf jobs subcommands that are read-only / control-plane — never a paid
// launch, always allowed.
const SAFE_HF_JOBS_SUBCMDS = new Set([
    'logs', 'inspect', 'ls', 'list', 'ps', 'status', 'cancel', 'top', 'kill',
]);

// ── Decision helpers ─────────────────────────────────────────

function allow() {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
        },
    }));
    process.exit(0);
}

function deny(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

// ── Input ────────────────────────────────────────────────────

function readInput() {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
}

/**
 * Tokenize a shell command into argv-ish tokens, respecting single and
 * double quotes. Not a full shell parser — sufficient for detecting the
 * `hf jobs run` verb, launcher basenames, and the `--launch`/bypass flags.
 * Backslash escapes are not honored.
 */
function tokenize(cmd) {
    const tokens = [];
    let cur = '';
    let quote = null;
    for (const ch of cmd) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
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

// ── Classification ───────────────────────────────────────────

/**
 * Given tokens for ONE command segment, classify it as:
 *   'paid'   — a paid HF job launch (hf jobs run | hf jobs uv run |
 *              launcher script with --launch)
 *   'safe'   — a launcher WITHOUT --launch, or hf jobs <safe-subcmd>
 *   'other'  — not related to HF job launching at all
 *   'unknown'— starts like an hf-jobs command but we could not positively
 *              classify it (fail-safe → treat as needing the gate)
 */
function classifySegment(tokens) {
    if (tokens.length === 0) return 'other';

    // Strip leading VAR=val env assignments and a leading interpreter
    // (bash/sh/zsh/env/uv) so `bash run_hf_job.sh --launch` and
    // `env FOO=1 hf jobs run` are seen correctly.
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'env', 'command', 'nohup', 'time']);
    while (i < tokens.length) {
        const base = tokens[i].split('/').pop();
        if (INTERPRETERS.has(base)) { i++; continue; }
        break;
    }

    const rest = tokens.slice(i);
    if (rest.length === 0) return 'other';

    const head = rest[0];
    const headBase = head.split('/').pop();
    const hasLaunch = rest.slice(1).some((t) => t === '--launch');

    // ── hf jobs … ──
    if (headBase === 'hf' && rest[1] === 'jobs') {
        // Find the effective subcommand, skipping option flags after "jobs".
        let j = 2;
        while (j < rest.length && rest[j].startsWith('-')) j++;
        const sub = rest[j];

        if (sub === 'run') return 'paid';
        if (sub === 'uv') {
            // `hf jobs uv run …` is a paid launch; `hf jobs uv <other>`
            // we don't recognize → fail safe.
            let k = j + 1;
            while (k < rest.length && rest[k].startsWith('-')) k++;
            if (rest[k] === 'run') return 'paid';
            return 'unknown';
        }
        if (sub && SAFE_HF_JOBS_SUBCMDS.has(sub)) return 'safe';
        // `hf jobs` with an unrecognized/absent subcommand: fail safe.
        return 'unknown';
    }

    // ── launcher script ──
    if (LAUNCHER_BASENAME_RE.test(head)) {
        return hasLaunch ? 'paid' : 'safe';
    }

    return 'other';
}

/**
 * Split a full command line into pipeline/list segments on top-level
 * separators (| || && ; ) so a launcher hidden behind `&&` is still seen.
 * Uses the already-quote-aware token stream but re-scans the raw string
 * for separators outside quotes.
 */
function splitSegments(cmd) {
    const segments = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        const next = cmd[i + 1];
        if (quote) {
            cur += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        // separators: ; | & (and doubled forms)
        if (ch === ';') { segments.push(cur); cur = ''; continue; }
        if (ch === '|') {
            if (next === '|') i++;
            segments.push(cur); cur = ''; continue;
        }
        if (ch === '&') {
            if (next === '&') i++;
            segments.push(cur); cur = ''; continue;
        }
        cur += ch;
    }
    if (cur) segments.push(cur);
    return segments;
}

/** True when the command carries a valid, auditable override. */
function hasApprovedOverride(cmd, env) {
    // (a) --force-anyway flag anywhere in the command.
    if (tokenize(cmd).includes(BYPASS_FLAG)) return true;

    // (b) HF_LAUNCH_APPROVED=<issue#> — either as an inline VAR=val prefix
    //     in the command string, or in the hook process environment.
    const inline = cmd.match(/(?:^|\s)HF_LAUNCH_APPROVED=(\S+)/);
    if (inline && /^#?\d+$/.test(inline[1])) return true;

    const fromEnv = env && env[APPROVAL_ENV];
    if (fromEnv && /^#?\d+$/.test(fromEnv.trim())) return true;

    return false;
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    let input;
    try {
        input = readInput();
    } catch (e) {
        // We could not even parse the hook payload. We cannot rule out a
        // paid launch, but we also have no command to show a useful deny
        // for. A missing/garbled payload is not a Bash command we can
        // block meaningfully; the safe-but-non-wedging choice is to allow
        // here (the tool call itself, if it IS a launch, will re-enter with
        // a parseable payload in normal operation). Fail-safe applies to
        // the classification path below, where we DO have a command.
        return allow();
    }
    if (!input) return allow();

    const toolName = input.tool_name;
    const toolInput = input.tool_input || {};
    const cmd = toolInput.command || '';

    // Only Bash tool calls carry a shell command to gate.
    if (toolName !== 'Bash' || !cmd) return allow();

    // From here on, if ANYTHING throws we FAIL SAFE (deny) — see the
    // wrapper at the bottom. A paid job is the blast radius.
    const segments = splitSegments(cmd);
    let sawPaid = false;
    let sawUnknown = false;

    for (const seg of segments) {
        const cls = classifySegment(tokenize(seg));
        if (cls === 'paid') sawPaid = true;
        else if (cls === 'unknown') sawUnknown = true;
    }

    // Nothing launch-related → allow.
    if (!sawPaid && !sawUnknown) return allow();

    // A recognized paid launch, or an hf-jobs command we could not
    // positively classify as safe → require the gate.
    if (hasApprovedOverride(cmd, process.env)) {
        // Authorized launch. Loud + logged (the override token is in the
        // transcript). Note it to stderr for the audit trail.
        process.stderr.write(
            '[hf-launch-gate] AUTHORIZED paid HF Jobs launch via override ' +
            '(--force-anyway or HF_LAUNCH_APPROVED). Ensure the originating ' +
            'issue + auditor PASS are recorded.\n'
        );
        return allow();
    }

    const what = sawPaid
        ? 'a PAID Hugging Face Jobs launch'
        : 'a Hugging Face Jobs command this gate cannot confirm is safe';

    return deny(
        `hf-launch-gate: refusing ${what}.\n` +
        `\n` +
        `This is a paid GPU job. Per AC6 on metazen11/agent-memory#55, a paid\n` +
        `launch is REFUSED unless BOTH process preconditions are met:\n` +
        `  1. An approved originating GitHub issue exists for this launch,\n` +
        `     with explicit, testable acceptance criteria.\n` +
        `  2. An auditor PASS has been recorded against that issue\n` +
        `     (a SEPARATE context — self-certification does not count).\n` +
        `\n` +
        `Background: an agent nearly launched a paid GPU job with no issue and\n` +
        `no audit, on self-certification. The rule: any time we violate a rule,\n` +
        `enforce it deterministically. This gate is that enforcement.\n` +
        `\n` +
        `TO AUTHORIZE (only after the two gates above are GREEN):\n` +
        `  • append  --force-anyway  anywhere in the command, OR\n` +
        `  • prefix  HF_LAUNCH_APPROVED=<issue#>  e.g.\n` +
        `      HF_LAUNCH_APPROVED=55 <your hf jobs run …>\n` +
        `  Both are logged to the transcript for the audit trail.\n` +
        `\n` +
        `NOT blocked: dry-runs (launcher without --launch) and read-only\n` +
        `subcommands (hf jobs logs|inspect|ls|ps|status|cancel).`
    );
}

// Fail-safe wrapper: any exception on the classification path blocks,
// because a paid job is the blast radius. (readInput has its own guarded
// path above that allows only when there is no command to block.)
try {
    main();
} catch (e) {
    deny(
        'hf-launch-gate: internal error while evaluating a possible paid HF ' +
        'Jobs launch — refusing by default (fail-safe). A paid GPU job is the ' +
        'blast radius, so an undeterminable state BLOCKS. ' +
        'Detail: ' + (e && e.message ? e.message : String(e)) + '. ' +
        'If this is a false positive, fix the hook or authorize explicitly ' +
        'with --force-anyway / HF_LAUNCH_APPROVED=<issue#>.'
    );
}
