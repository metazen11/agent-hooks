#!/usr/bin/env node
/**
 * context-primer — keep required instruction files in context, time-based.
 *
 * LOCATION: ~/.claude/hooks/context-primer.js (symlinked by install.js)
 *
 * Three modes, wired as three settings entries:
 *
 *   1. --session-start  (SessionStart hook)
 *      Discovers the required instruction files for the current project and
 *      INJECTS their content into context via hookSpecificOutput.additionalContext.
 *      Records a per-session flag so the gate (mode 3) knows priming happened.
 *
 *   2. --user-prompt    (UserPromptSubmit hook)
 *      Counts user turns from the transcript. Every REPRIME_EVERY turns (50 by
 *      default) it RE-INJECTS the files so a long session doesn't drift away from
 *      the contracts. Every other turn it is a near-instant no-op.
 *
 *   3. (default)        (PreToolUse hook, matcher Edit|Write|NotebookEdit|Bash)
 *      SAFETY NET ONLY. Fires exactly when a session performs work but the
 *      SessionStart injection never ran for it (hook added mid-session, or a
 *      launch path that skipped SessionStart). In that one case it DENIES the
 *      first work call with the Read list, then goes silent for the session.
 *      It does NOT nag on every edit and does NOT re-fire on content changes —
 *      once SessionStart has primed the session, this gate is permanently quiet.
 *
 * Required files (discovered relative to the project root, see findProjectRoot):
 *   - Project instruction files:  CLAUDE.md, AGENTS.md, GEMINI.md
 *   - Coding requirements:        coding_requirements.md, CONTRIBUTING.md,
 *                                 docs/coding-standards.md, .autonomous.json
 *   - Autonomous-agents contracts (global, always): ~/.claude/CLAUDE.md
 *
 * Read-only tool calls (Read, Grep, Glob, LS, Task, etc.) are never gated.
 *
 * HOOK INPUT (stdin):
 *   {
 *     "hook_event_name": "SessionStart" | "UserPromptSubmit" | "PreToolUse",
 *     "tool_name": "Edit",
 *     "tool_input": { ... },
 *     "cwd": "/abs/project/path",
 *     "session_id": "…",
 *     "transcript_path": "/…/<session>.jsonl"   // present on UserPromptSubmit
 *   }
 *
 * The hook fails OPEN: any internal error allows the tool call / injects nothing
 * rather than wedging the session. Priming is a guardrail, not a tripwire.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Config ───────────────────────────────────────────────────

const HOME = os.homedir();

// Re-inject the files every N user turns during a long session.
const REPRIME_EVERY = 50;

// Global autonomous-agents contracts — always required, regardless of project.
const GLOBAL_REQUIRED = [path.join(HOME, '.claude', 'CLAUDE.md')];

// Project-relative candidates. Discovered at the project root and at the cwd.
// Only files that EXIST are required — a repo without coding_requirements.md is
// not forced to have one.
const PROJECT_CANDIDATES = [
    'CLAUDE.md',
    'AGENTS.md',
    'GEMINI.md',
    'coding_requirements.md',
    'CONTRIBUTING.md',
    path.join('docs', 'coding-standards.md'),
    '.autonomous.json',
];

// Tool calls that PERFORM WORK. Only these are eligible for the safety-net gate.
const GATED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);

// Per-session state (the "SessionStart primed" flag) lives here.
const STATE_DIR = path.join(os.tmpdir(), 'context-primer');

// Cap injected content so a giant CLAUDE.md can't blow the context budget.
const MAX_BYTES_PER_FILE = 24 * 1024;

// ── stdin / output ───────────────────────────────────────────

function readHookInput() {
    try {
        const stdin = fs.readFileSync(0, 'utf8');
        if (stdin) return JSON.parse(stdin);
    } catch {
        // no stdin / bad json → empty
    }
    return {};
}

function emitInject(eventName, additionalContext) {
    const out = { hookSpecificOutput: { hookEventName: eventName } };
    if (additionalContext) out.hookSpecificOutput.additionalContext = additionalContext;
    console.log(JSON.stringify(out));
    process.exit(0);
}

function allow() {
    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
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

// ── Discovery ────────────────────────────────────────────────

/**
 * Walk up from `start` looking for a repo root marker (.git). Falls back to
 * `start` itself if none is found, so non-git directories still get project
 * file discovery from the cwd.
 */
function findProjectRoot(start) {
    let dir = start;
    for (let i = 0; i < 64 && dir && dir !== path.dirname(dir); i++) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        dir = path.dirname(dir);
    }
    return start;
}

/**
 * Resolve the absolute, de-duplicated list of required files that EXIST for the
 * given cwd: global contracts + project candidates found at the repo root and
 * at the cwd (in case work happens in a subdir with its own CLAUDE.md/AGENTS.md).
 */
function resolveRequiredFiles(cwd) {
    const root = findProjectRoot(cwd);
    const searchDirs = root === cwd ? [root] : [root, cwd];

    const found = [];
    for (const base of GLOBAL_REQUIRED) {
        if (safeExists(base)) found.push(base);
    }
    for (const dir of searchDirs) {
        for (const rel of PROJECT_CANDIDATES) {
            const abs = path.join(dir, rel);
            if (safeExists(abs)) found.push(abs);
        }
    }
    // De-dup while preserving order.
    return [...new Set(found)];
}

function safeExists(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readClipped(p) {
    try {
        const buf = fs.readFileSync(p);
        if (buf.length <= MAX_BYTES_PER_FILE) return buf.toString('utf8');
        return buf.slice(0, MAX_BYTES_PER_FILE).toString('utf8') +
            `\n\n…[truncated at ${MAX_BYTES_PER_FILE} bytes — Read ${p} for the full file]`;
    } catch {
        return null;
    }
}

/**
 * Build the injected context block for the required files. `header` lets the
 * SessionStart and periodic-reprime injections label themselves differently.
 */
function buildInjection(files, header) {
    const blocks = [
        header,
        'The following project + autonomous-agents instruction files govern this',
        'work and are authoritative. The project-instruction precedence carve-out',
        'means a repo\'s own files win over global defaults where they conflict.',
        'Do not begin or continue work that contradicts them.',
        '',
    ];
    for (const f of files) {
        const content = readClipped(f);
        if (content == null) continue;
        blocks.push(`----- BEGIN ${f} -----`);
        blocks.push(content.trimEnd());
        blocks.push(`----- END ${f} -----`);
        blocks.push('');
    }
    return blocks.join('\n');
}

// ── Per-session state ────────────────────────────────────────

// The primed flag is keyed by BOTH the session id (when present) AND a cwd hash.
// session_id is not guaranteed to be present/consistent across every hook event
// (SessionStart vs PreToolUse can differ or omit it), so keying on it alone made
// the gate mis-match and re-fire on nearly every tool call. Writing + checking
// both keys makes the "already primed" lookup resilient: prime once under either
// key → the gate stays quiet regardless of which id a later event carries.
function stateKeys(input, cwd) {
    const keys = [];
    const sid = input.session_id || input.sessionId;
    if (sid) keys.push(String(sid).replace(/[^a-zA-Z0-9_-]/g, '_'));
    keys.push('cwd-' + crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16));
    return keys;
}

function statePathFor(key) {
    return path.join(STATE_DIR, key + '.json');
}

/** Record that SessionStart primed this session (the gate keys off this flag). */
function markPrimed(input, cwd, files) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const payload = JSON.stringify({ cwd, primed: true, files, ts: Date.now() });
        // Write under every key so any later event's lookup finds it.
        for (const key of stateKeys(input, cwd)) {
            fs.writeFileSync(statePathFor(key), payload);
        }
    } catch {
        // best-effort; a failed write just means the gate may fire its one time
    }
}

function isPrimed(input, cwd) {
    // Primed if ANY of the candidate keys has a valid flag (session id OR cwd).
    for (const key of stateKeys(input, cwd)) {
        try {
            const st = JSON.parse(fs.readFileSync(statePathFor(key), 'utf8'));
            if (st.primed === true) return true;
        } catch {
            // try the next key
        }
    }
    return false;
}

// ── Turn counting (for periodic reprime) ─────────────────────

/**
 * Count user turns in the transcript. Each `type:"user"` line is one turn.
 * Cheap: a single streamed read, no full parse of every field. Returns 0 if the
 * transcript is unavailable.
 */
function countUserTurns(transcriptPath) {
    if (!transcriptPath || !safeExists(transcriptPath)) return 0;
    let count = 0;
    try {
        const text = fs.readFileSync(transcriptPath, 'utf8');
        for (const line of text.split('\n')) {
            // Fast pre-filter before JSON.parse to keep this hot path light.
            if (line.indexOf('"type":"user"') === -1 && line.indexOf('"type": "user"') === -1) {
                continue;
            }
            try {
                if (JSON.parse(line).type === 'user') count++;
            } catch {
                // ignore malformed line
            }
        }
    } catch {
        return 0;
    }
    return count;
}

// ── Mode: SessionStart (prime once) ──────────────────────────

function handleSessionStart(input) {
    const cwd = input.cwd || process.cwd();
    const files = resolveRequiredFiles(cwd);
    if (files.length === 0) return emitInject('SessionStart', '');

    markPrimed(input, cwd, files);
    emitInject('SessionStart', buildInjection(files, '=== REQUIRED READING (context-primer, session start) ==='));
}

// ── Mode: UserPromptSubmit (reprime every N turns) ───────────

function handleUserPrompt(input) {
    const cwd = input.cwd || process.cwd();
    const turns = countUserTurns(input.transcript_path || input.transcriptPath);

    // Reprime on turns 50, 100, 150… Turn 0 and non-multiples are no-ops.
    if (turns <= 0 || turns % REPRIME_EVERY !== 0) {
        return emitInject('UserPromptSubmit', '');
    }

    const files = resolveRequiredFiles(cwd);
    if (files.length === 0) return emitInject('UserPromptSubmit', '');

    emitInject(
        'UserPromptSubmit',
        buildInjection(files, `=== REQUIRED READING (context-primer, turn ${turns} refresh) ===`),
    );
}

// ── Mode: PreToolUse (safety-net gate) ───────────────────────

function handlePreToolUse(input) {
    const toolName = input.tool_name;
    if (!GATED_TOOLS.has(toolName)) return allow();

    const cwd = input.cwd || process.cwd();

    // If SessionStart already primed this session, the gate is permanently
    // silent — no per-edit nagging, no re-fire on content edits.
    if (isPrimed(input, cwd)) return allow();

    const files = resolveRequiredFiles(cwd);
    if (files.length === 0) return allow();

    // Session performed work without ever being primed. Mark primed now so we
    // deny at most once, then deny THIS call with the explicit read list.
    markPrimed(input, cwd, files);

    const list = files.map((f) => `  - ${f}`).join('\n');
    deny(
        'context-primer: this session started work without loading its instruction ' +
        'files (the session-start injection did not run). Read these once so you ' +
        'are operating under the project + autonomous-agents contracts:\n' +
        list +
        '\n\n(They define branching/QA/deploy rules and the Definition-of-Done ' +
        'audit loop; the project\'s own files take precedence over global defaults ' +
        'where they conflict.) This is a one-time safety check — re-issue the call ' +
        'and it will pass.'
    );
}

// ── Main ─────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    const input = readHookInput();
    const event = input.hook_event_name;

    const isSessionStart = args.includes('--session-start') || event === 'SessionStart';
    const isUserPrompt = args.includes('--user-prompt') || event === 'UserPromptSubmit';

    try {
        if (isSessionStart) return handleSessionStart(input);
        if (isUserPrompt) return handleUserPrompt(input);
        return handlePreToolUse(input);
    } catch {
        // Fail OPEN — never wedge a session on a guardrail bug.
        if (isSessionStart) return emitInject('SessionStart', '');
        if (isUserPrompt) return emitInject('UserPromptSubmit', '');
        return allow();
    }
}

main();
