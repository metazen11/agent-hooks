#!/usr/bin/env node
/*
 * self-improve — nudges the continuous-improvement / tool-extraction loop that is
 * documented in CLAUDE.md but otherwise relies on the agent remembering to do it.
 *
 * LOCATION: ~/.claude/hooks/self-improve.js (symlink) -> ~/_CODING/hooks/self-improve/self-improve.js
 * CANONICAL SOURCE: ~/_CODING/hooks (git). Do not hand-edit the symlink target's install copy.
 *
 * GLOBAL — wired in ~/.claude/settings.json, applies to every project.
 *
 * Two roles, selected by flag:
 *
 *   --post-tool   (PostToolUse, all tools)
 *       Counts tool calls per session in a small state file. Non-blocking, silent.
 *       This is the odometer the Stop hook reads.
 *
 *   --stop        (Stop)
 *       When a session ends, evaluates three documented rules and, if triggered,
 *       injects a reminder via hookSpecificOutput.additionalContext:
 *         (A) "5+ tools rule": many tool calls this session but no new artifact
 *             created under scripts/ or skills/  -> remind to extract one.
 *         (B) "sprint-close rule": code/config changed but durable docs (HANDOFF,
 *             CHANGELOG, docs/) untouched -> remind to run /sprint-close + /improve.
 *         (C) "capture-lessons rule": substantive session (many tools + real edits)
 *             that saved NO agent-memory lesson/memory -> remind to record what was
 *             learned via the agent-memory MCP so it is recalled next session.
 *       Advisory only. NEVER blocks. Fails SAFE by staying silent on any error.
 *
 * Design notes:
 *   - A reminder is a nudge, not a gate. It cannot stop the agent; it only adds
 *     context so the loop is not silently skipped. This matches the org rule
 *     "update the system so it can't recur" without over-policing.
 *   - Git is the source of truth for "what changed this session" (cheap, accurate).
 *   - Per-session state lives in os.tmpdir()/self-improve keyed by session_id.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(os.tmpdir(), 'self-improve');
const TOOL_THRESHOLD = 6; // ">5 tools" per the documented rule

function readInput() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return {};
    }
}

function stateFile(sessionId, cwd) {
    const key = sessionId
        ? String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')
        : 'cwd-' + crypto.createHash('sha256').update(String(cwd || '')).digest('hex').slice(0, 16);
    return path.join(STATE_DIR, key + '.json');
}

function loadState(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return { tools: 0 };
    }
}

function saveState(file, state) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state));
    } catch {
        /* best-effort */
    }
}

function git(cwd, args) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

function emit(additionalContext) {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'Stop',
                additionalContext,
            },
        })
    );
}

// --- PostToolUse: increment the per-session tool counter, stay silent. ---
// Only real work moves this odometer. A conversational turn with no tool calls
// leaves tools===0, which is how the Stop hook knows to stay quiet.
function runPostTool(input) {
    const file = stateFile(input.session_id, input.cwd);
    const state = loadState(file);
    state.tools = (state.tools || 0) + 1;
    // A turn that edited/wrote files is "substantive"; a turn of only reads/greps
    // is not. Track mutating tools separately so idle Q&A never trips the nudge.
    const mutating = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
    if (mutating.has(input.tool_name)) state.mutations = (state.mutations || 0) + 1;
    // Track whether a durable lesson/memory was captured this session, so the Stop
    // hook can nudge when substantive work ended without recording a lesson. Match
    // the agent-memory MCP tools by name (create_lesson / save_memory) regardless of
    // MCP server prefix, so the check survives server-name changes.
    if (/(^|__)(create_lesson|save_memory)$/.test(String(input.tool_name || ''))) {
        state.lessons = (state.lessons || 0) + 1;
    }
    saveState(file, state);
    process.exit(0);
}

// --- Stop: evaluate the documented rules and nudge if triggered. ---
function runStop(input) {
    const cwd = input.cwd || process.cwd();
    const file = stateFile(input.session_id, cwd);
    const state = loadState(file);

    // GUARD 1 — debounce: nudge at most ONCE per session. Without this, every
    // idle Stop re-reads git status and re-fires (the spam bug).
    if (state.nudged) process.exit(0);

    // GUARD 2 — require this-session activity. If no MUTATING tool ran this
    // session, this Stop is a conversational/idle turn — stay silent even if the
    // working tree has pre-existing uncommitted changes from earlier.
    if ((state.mutations || 0) === 0) process.exit(0);

    // Only reason about a real git repo; otherwise nothing to compare.
    const inRepo = git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
    const changed = inRepo
        ? git(cwd, ['status', '--porcelain'])
              .split('\n')
              .map((l) => l.slice(3).trim())
              .filter(Boolean)
        : [];

    const messages = [];
    const mutations = state.mutations || 0;

    // Rule A — tool-extraction ("5+ tools rule"). Only when this session did real
    // repeatable work (many tools) and shipped no reusable artifact.
    const createdArtifact = changed.some((f) => /(^|\/)(scripts|skills)\//.test(f));
    if ((state.tools || 0) >= TOOL_THRESHOLD && mutations >= 3 && !createdArtifact) {
        messages.push(
            `${state.tools} tool calls this session, no new artifact under scripts/ or skills/. ` +
                `Per the "5+ tools rule": if a discrete repeatable task took >5 tools, extract a reusable script/skill. ` +
                `If nothing here was repeatable, disregard.`
        );
    }

    // Rule B — sprint-close ("docs are part of done"). Require a SUBSTANTIVE change
    // set (>=3 mutating edits) so a one-line fix or a conversational edit never trips
    // it. Only fires once per session (debounced above).
    const codeOrConfigChanged = changed.some((f) =>
        /\.(js|ts|tsx|py|sh|sql|ya?ml|tf|ps1|ipynb)$/i.test(f) || /(^|\/)(pipelines|src|fabric)\//i.test(f)
    );
    const docsChanged = changed.some((f) => /HANDOFF\.md|CHANGELOG|(^|\/)docs\//i.test(f));
    if (mutations >= 3 && codeOrConfigChanged && !docsChanged) {
        messages.push(
            `Code/config changed (${mutations} edits) but HANDOFF.md / CHANGELOG / docs/ were not updated. ` +
                `Per "docs are part of done": update the relevant doc, then consider /sprint-close + /improve. ` +
                `If the change was trivial, disregard.`
        );
    }

    // Rule C — capture-lessons ("don't forget agent-memory"). A substantive session
    // (many tools + real edits) that recorded NO durable lesson/memory almost always
    // learned something worth recalling next time. Nudge to write it. Fires on the
    // same debounce so it's shown at most once per session.
    if ((state.tools || 0) >= TOOL_THRESHOLD && mutations >= 3 && (state.lessons || 0) === 0) {
        messages.push(
            `${state.tools} tool calls and ${mutations} edits this session, but no agent-memory lesson/memory was saved. ` +
                `If anything non-obvious was learned (a root cause, a gotcha, a durable decision, a workflow), ` +
                `save it now via the agent-memory MCP (create_lesson for a proactive rule, save_memory for a fact) ` +
                `so it is recalled next session. If nothing here was durable, disregard.`
        );
    }

    // Debounce: mark that we've evaluated/nudged this session so subsequent idle
    // Stops stay silent. Keep the state file (don't delete) so `nudged` persists.
    if (messages.length) {
        state.nudged = true;
        saveState(file, state);
        emit('=== SELF-IMPROVE (advisory, non-blocking, shown once) ===\n' + messages.map((m) => '- ' + m).join('\n'));
    }
    process.exit(0);
}

function main() {
    const mode = process.argv.includes('--stop') ? 'stop' : process.argv.includes('--post-tool') ? 'post' : null;
    if (!mode) process.exit(0);
    const input = readInput();
    try {
        if (mode === 'post') return runPostTool(input);
        return runStop(input);
    } catch {
        // Fail safe: never block a session end on a bug in this advisory hook.
        process.exit(0);
    }
}

main();
