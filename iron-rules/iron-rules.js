#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// iron-rules.js  —  periodic injection of non-negotiable rules
// ─────────────────────────────────────────────────────────────
//
//  Modes (by flag):
//    --session-start     inject once at session start
//    --user-prompt       inject every IRON_RULES_EVERY user turns
//
//  Markdown in CLAUDE.md is advisory and gets skipped on autopilot; a hook
//  fires deterministically. See agent-memory lesson
//  "feedback_deterministic_enforcement".
//
//  The rules TEXT is not in this file — it lives in IRON-RULES.md beside it,
//  so the rules can be edited without touching code. This hook parses the
//  "## Digest" section (lines starting "- ") and injects those, plus a path
//  to the full document.
//
//  Cadence: IRON_RULES_EVERY (default 10) user turns. Turn counting mirrors
//  context-primer.js — each `type:"user"` line in the transcript is one turn.
//
//  Contract: stdout is appended to model context. ALWAYS exits 0 — a reminder
//  must never block the user's turn. Every failure path degrades to silence.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DEFAULT_EVERY = 10;
// Strict: only a clean positive integer overrides. '1e9', '-5', '3.7' and 'abc'
// all fall back to the default rather than degrading toward every-turn spam.
const EVERY = (() => {
    const raw = process.env.IRON_RULES_EVERY;
    if (!raw || !/^\d+$/.test(raw.trim())) return DEFAULT_EVERY;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 1 ? n : DEFAULT_EVERY;
})();

// Resolve through the symlink so we read the doc next to the REAL file in the
// source repo, not next to the symlink in ~/.claude/hooks.
function rulesFile() {
    let self = __filename;
    try { self = fs.realpathSync(self); } catch { /* use as-is */ }
    return path.join(path.dirname(self), 'IRON-RULES.md');
}

/** Parse the "## Digest" section: lines starting "- ". Empty array on any failure. */
function readDigest(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }

    const out = [];
    let inDigest = false;
    for (const line of text.split('\n')) {
        if (/^##\s+Digest\s*$/i.test(line)) { inDigest = true; continue; }
        if (inDigest && /^##\s+/.test(line)) break;   // next section ends it
        if (inDigest && /^\s*[-*]\s+/.test(line)) out.push(line.replace(/^\s*[-*]\s+/, '').trim());
    }
    return out;
}

/**
 * Count REAL user turns in the transcript.
 *
 * Claude Code writes every TOOL RESULT as a `"type":"user"` line, and injects
 * `isMeta` lines of its own. A naive count of `type:"user"` therefore overcounts
 * badly and NON-UNIFORMLY — measured on a real 50MB transcript: 2251 lines vs
 * 243 actual prompts (9.3x), advancing by however many tools the last turn used.
 * That made the throttle fire three turns in a row, then go silent for 31.
 *
 * So: a line counts only when it is type "user", carries NO toolUseResult, and
 * is not isMeta. Returns 0 when unavailable, making the caller a no-op rather
 * than firing every turn.
 */
function countUserTurns(transcriptPath) {
    if (!transcriptPath) return 0;
    let text;
    try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return 0; }

    let count = 0;
    for (const line of text.split('\n')) {
        // Fast pre-filter before JSON.parse to keep this hot path light.
        if (line.indexOf('"type":"user"') === -1 && line.indexOf('"type": "user"') === -1) continue;
        try {
            const o = JSON.parse(line);
            if (o.type !== 'user') continue;
            if (o.toolUseResult !== undefined) continue;   // tool result, not a turn
            if (o.isMeta) continue;                        // system-injected
            count++;
        } catch { /* malformed line */ }
    }
    return count;
}

function readStdin() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function emit(rules, file, label) {
    const body = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    process.stdout.write(
        `<iron-rules${label ? ' ' + label : ''}>\n${body}\n\nFull text: ${file}\n</iron-rules>\n`
    );
}

function main() {
    const args = process.argv.slice(2);
    const file = rulesFile();
    const rules = readDigest(file);
    if (rules.length === 0) return;   // nothing to say; stay silent

    if (args.includes('--session-start')) {
        return emit(rules, file, 'session start');
    }

    if (args.includes('--user-prompt')) {
        const input = readStdin();
        const turns = countUserTurns(input.transcript_path || input.transcriptPath);
        // Fire on turns EVERY, 2*EVERY, ... Turn 0 and non-multiples are no-ops.
        if (turns <= 0 || turns % EVERY !== 0) return;
        return emit(rules, file, `turn ${turns}`);
    }

    // Explicit manual inspection.
    if (args.includes('--probe')) return emit(rules, file, '');

    // No recognized flag: SILENCE. This binary is wired as a per-turn hook, so
    // an entry that lost its flag (or an older install) must degrade to quiet,
    // never to injecting on every single turn.

}

try { main(); } catch { /* a broken reminder must never break the session */ }
process.exit(0);
