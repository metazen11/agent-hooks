#!/usr/bin/env node
/**
 * dispatch-gate — strict-block hook for orchestrator Task dispatch dedup.
 *
 * LOCATION: ~/.claude/hooks/dispatch-gate.js
 *
 * The dispatch contract (issue #710):
 *
 *   Before dispatching a sub-agent to fix GitHub issue #N, the orchestrator
 *   MUST check for an existing branch matching fix/<N>-*, feat/<N>-*, or
 *   work/<N>-* AND for an active worktree on such a branch. If any match,
 *   refuse the dispatch and surface the conflict so the operator can
 *   either reuse the existing agent or override explicitly.
 *
 * This hook runs on PreToolUse for the Task tool. It scans the dispatch
 * prompt for the canonical issue-reference patterns ("issue #N", "#N",
 * "GH#N", "fix #N", "closes #N", "Closes #N") and, when one is found,
 * checks the git worktree and branch state for a collision.
 *
 * The check runs `git` and `gh` synchronously. If either binary is missing
 * or returns non-zero, the hook fails open (allow with a stderr note) —
 * better to let the operator proceed than to block on hook flakiness.
 *
 * Bypass: set DISPATCH_GATE_DISABLE=true in the env for one dispatch.
 * Use only after asking the operator. Recorded in stderr for the audit.
 *
 * HOOK INPUT (stdin):
 *   {
 *     "hook_event_name": "PreToolUse",
 *     "tool_name": "Task",
 *     "tool_input": { "prompt": "...", "subagent_type": "...", ... }
 *   }
 *
 * Decision output: per PreToolUse hook contract (allow|deny via JSON
 * on stdout). Always exit 0.
 */

'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const VERBOSE = process.env.DISPATCH_GATE_VERBOSE === 'true';
const DISABLED = process.env.DISPATCH_GATE_DISABLE === 'true';

function dbg(msg) {
    if (VERBOSE) process.stderr.write(`[dispatch-gate] ${msg}\n`);
}

function allow() { process.exit(0); }

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

function readInput() {
    try {
        const raw = fs.readFileSync(0, 'utf8');
        if (!raw.trim()) return null;
        return JSON.parse(raw);
    } catch (e) {
        dbg(`stdin parse error: ${e.message}`);
        return null;
    }
}

// Extract candidate issue numbers from a dispatch prompt. We look for the
// well-known patterns the orchestrator uses when referencing GitHub issues.
function extractIssueNumbers(prompt) {
    if (!prompt || typeof prompt !== 'string') return [];
    const patterns = [
        /(?:issue|fix|fixes|close|closes|resolves?)\s+#(\d{1,6})\b/gi,
        /\bGH-?#?(\d{1,6})\b/g,
        /\bissue\s+(\d{2,6})\b/gi,
    ];
    const found = new Set();
    for (const rx of patterns) {
        let m;
        while ((m = rx.exec(prompt)) !== null) {
            found.add(m[1]);
        }
    }
    return Array.from(found);
}

// Check git/worktree state for a collision on the given issue number.
// Returns { kind, detail } on conflict, null on clean.
function detectConflict(issueNumber, cwd) {
    const opts = { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] };

    // 1. Existing local or remote branches matching fix/<N>-*, feat/<N>-*, work/<N>-*
    try {
        const out = execSync(
            `git branch -a --list 'fix/${issueNumber}-*' 'fix/${issueNumber}' 'feat/${issueNumber}-*' 'work/${issueNumber}-*'`,
            opts
        ).toString().trim();
        if (out) {
            return { kind: 'branch', detail: out };
        }
    } catch (e) {
        dbg(`git branch check failed: ${e.message}`);
    }

    // 2. Active worktree on such a branch
    try {
        const out = execSync('git worktree list --porcelain', opts).toString();
        const lines = out.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('branch refs/heads/')) {
                const branch = line.slice('branch refs/heads/'.length);
                if (new RegExp(`^(fix|feat|work)/${issueNumber}(-|$)`).test(branch)) {
                    return { kind: 'worktree', detail: `worktree on branch '${branch}'` };
                }
            }
        }
    } catch (e) {
        dbg(`git worktree check failed: ${e.message}`);
    }

    return null;
}

function main() {
    if (DISABLED) {
        dbg('disabled via DISPATCH_GATE_DISABLE');
        return allow();
    }

    const input = readInput();
    if (!input) return allow();

    const { tool_name: toolName, tool_input: toolInput, cwd } = input;
    if (toolName !== 'Task') return allow();

    const prompt = (toolInput && toolInput.prompt) || '';
    const issueNumbers = extractIssueNumbers(prompt);
    if (issueNumbers.length === 0) {
        dbg('no issue reference in dispatch — allow');
        return allow();
    }
    dbg(`dispatch references issues: ${issueNumbers.join(', ')}`);

    for (const n of issueNumbers) {
        const conflict = detectConflict(n, cwd || process.cwd());
        if (conflict) {
            return deny(
                `dispatch-gate: an existing branch or worktree already targets issue #${n}.\n` +
                `  conflict (${conflict.kind}): ${conflict.detail}\n` +
                `\n` +
                `FIX: either reuse the existing agent or, if you genuinely need a\n` +
                `second pass, finish/delete the existing branch and worktree first.\n` +
                `\n` +
                `If you are sure you need to dispatch concurrently anyway (rare —\n` +
                `usually a recipe for double-modified files and live-stack races),\n` +
                `set DISPATCH_GATE_DISABLE=true before the dispatch call. Record\n` +
                `the reason in the dispatch prompt for the audit trail.\n` +
                `\n` +
                `Background: issue #710 — two agents on #701 modified the same\n` +
                `four files and raced the live compose project. The cure is to\n` +
                `make the dispatcher aware of existing work for the same issue.`
            );
        }
    }

    dbg('no conflicts — allow');
    return allow();
}

try {
    main();
} catch (e) {
    process.stderr.write(`[dispatch-gate] internal error: ${e.stack || e.message}\n`);
    process.exit(0);  // fail open
}
