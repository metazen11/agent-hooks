#!/usr/bin/env node
/**
 * worktree-write-guard — Block Edit/Write/NotebookEdit tool calls when an
 * agent dispatched into a git worktree tries to write to the main worktree
 * instead of its own. Same idea for destructive Bash commands operating on
 * paths outside the agent's worktree.
 *
 * INCIDENT THIS PREVENTS:
 *   reports/2026-05-24-runaway-subagent-postmortem.md and Lane B's report
 *   2026-05-24: a sub-agent dispatched into .claude/worktrees/agent-XXX/
 *   used absolute paths like /Users/mz/_CODING/psde_mz_test/Makefile (copied
 *   from issue bodies, CLAUDE.md, tool result outputs) and edited the MAIN
 *   worktree's files instead of its assigned worktree. git-session.js caught
 *   the resulting commit on develop and redirected, but only after the edit
 *   had been made. This hook stops the edit BEFORE it happens.
 *
 * CONTRACT:
 *   - Input via stdin: { cwd, tool_name, tool_input }
 *   - Trigger: PreToolUse with matcher "Edit|Write|NotebookEdit|Bash"
 *   - If $cwd is under <repo-root>/.claude/worktrees/agent-XXX/ AND the
 *     tool would write to a path NOT under that worktree → deny.
 *   - Bash heuristic: scan the command string for absolute paths matching
 *     <repo-root>/... that are NOT under the worktree, and that appear in
 *     a write-like context (>, >>, tee, rm, mv, git commit -F, gh issue
 *     comment --body-file, etc.). Pure-read bash (cat, grep, ls, find,
 *     git log) is allowed.
 *   - For all other CWDs (orchestrator session in the main repo, normal
 *     dev work) → allow silently. The hook is a no-op outside agent
 *     worktrees.
 *
 * EXIT:
 *   - Always exit 0. Decision is communicated via JSON on stdout per the
 *     PreToolUse hook contract (permissionDecision: "deny"|"allow").
 *   - If anything goes wrong inside the hook itself, fail open (allow) and
 *     log to stderr — better than blocking the agent on a hook bug.
 *
 * ENV:
 *   - WORKTREE_GUARD_VERBOSE=true → debug logging to stderr
 *   - WORKTREE_GUARD_DISABLE=true → bypass entirely (emergency switch)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VERBOSE = process.env.WORKTREE_GUARD_VERBOSE === 'true';
const DISABLED = process.env.WORKTREE_GUARD_DISABLE === 'true';

function dbg(msg) {
    if (VERBOSE) process.stderr.write(`[worktree-write-guard] ${msg}\n`);
}

function allow() {
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

// Detect whether $cwd is inside an agent worktree of the form
// <repo>/.claude/worktrees/agent-<id>/
// Returns { worktreeRoot, repoRoot, agentId } or null.
//
// Verifies that the worktree directory actually EXISTS on disk (issue
// #723): when the orchestrator inherits a stale cwd from a dead/cleaned
// sub-agent, the path matches the regex but the directory is gone. In
// that case we treat it as not-in-a-worktree so the hook doesn't
// false-positive on the orchestrator's own subsequent writes. The
// CLAUDE_IS_ORCHESTRATOR=1 env var is honored as an explicit operator
// bypass for cases where the worktree still exists but the running
// session is the orchestrator (e.g. session resumed mid-cleanup).
function detectAgentWorktree(cwd) {
    if (process.env.CLAUDE_IS_ORCHESTRATOR === '1') {
        dbg('CLAUDE_IS_ORCHESTRATOR=1 — bypass');
        return null;
    }
    if (!cwd) return null;
    const norm = path.resolve(cwd);
    // Walk up to find ".claude/worktrees/agent-..." in the path
    const m = norm.match(/^(.+)\/\.claude\/worktrees\/(agent-[A-Za-z0-9_-]+)(?:\/.*)?$/);
    if (!m) return null;
    const worktreeRoot = path.join(m[1], '.claude', 'worktrees', m[2]);
    // If the worktree directory is gone, the cwd is stale (a dead sub-agent's
    // path inherited by the orchestrator session). Skip enforcement so the
    // orchestrator isn't pinned to a path that no longer exists.
    try {
        const st = fs.statSync(worktreeRoot);
        if (!st.isDirectory()) {
            dbg(`worktree ${worktreeRoot} is not a directory — stale cwd; bypass`);
            return null;
        }
    } catch (e) {
        dbg(`worktree ${worktreeRoot} missing (stale cwd from dead sub-agent) — bypass`);
        return null;
    }
    return {
        repoRoot: m[1],
        agentId: m[2],
        worktreeRoot,
    };
}

// Is `target` (absolute or worktree-relative) inside the worktreeRoot?
function isInsideWorktree(target, worktreeRoot) {
    if (!target) return true; // missing path: let the actual tool error
    let abs = target;
    if (!path.isAbsolute(abs)) {
        // Relative paths are resolved against cwd — and cwd IS the worktree,
        // so relative paths are always inside it.
        return true;
    }
    abs = path.resolve(abs);
    const root = path.resolve(worktreeRoot);
    return abs === root || abs.startsWith(root + path.sep);
}

// Sanctioned cross-worktree scripts that lanes are explicitly allowed to invoke
// even though they live in the main repo's scripts/ dir (issue #725). The
// canonical list lives here so the guard is the single source of truth.
//
// Each entry is matched as a path suffix — e.g. "scripts/reconcile_lock.sh"
// matches any path that ends with that segment. Add carefully; every entry
// is a tiny widening of the worktree-isolation contract.
const SANCTIONED_SUFFIXES = [
    'scripts/reconcile_lock.sh',           // inter-lane serialization for /reconcile
    'scripts/detect_runaway_subagents.sh', // pre-flight runaway detector
];

function isSanctionedPath(absPath) {
    return SANCTIONED_SUFFIXES.some(suffix => absPath.endsWith('/' + suffix));
}

// For Bash: extract candidate write-target paths and detect write intent.
// We don't try to parse bash — we look for the common patterns.
function scanBashForOutOfWorktreeWrites(command, repoRoot, worktreeRoot) {
    if (!command || typeof command !== 'string') return null;

    // Find all absolute paths beginning with the repo root (the dangerous case).
    // We DON'T flag paths under the worktree; those are fine.
    const repoPathPattern = new RegExp(
        repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\/.claude\\/worktrees\\/)[^\\s\\\'\"]*',
        'g'
    );
    const matches = command.match(repoPathPattern);
    if (!matches || matches.length === 0) return null;

    // De-dup, then drop any sanctioned coordination scripts (issue #725).
    // These are intentionally invoked across worktree boundaries (e.g.
    // `scripts/reconcile_lock.sh release` to serialize parallel lane
    // reconciles into the integration trunk).
    const offending = Array.from(new Set(matches)).filter(p => !isSanctionedPath(p));
    if (offending.length === 0) return null;

    // Heuristic: if NONE of the bash verbs that are obviously write-like appear,
    // allow (e.g., `cat /Users/mz/.../foo.md` to read a file outside the worktree
    // is fine — agents legitimately need to read source-of-truth files).
    const writeVerbs = [
        /\brm\s/, /\bmv\s/, /\bcp\s+(?:-\w+\s+)?[^\s]+\s/, /\btouch\s/, /\bmkdir\s/, /\brmdir\s/,
        /\bsed\s+(?:-\w+\s+)?-i\b/, /\bperl\s+-pi\b/,
        /\btee\s/, />\s*(?!&)/, />>\s*/,
        /\bgit\s+(?:commit|add|stage|stash|reset|checkout|restore|rebase|merge|cherry-pick|am|apply)\b/,
        /\bgh\s+(?:issue|pr)\s+(?:close|reopen|comment|edit|create)\b/,
        /\bdocker\s+exec\b/, /\bdocker\s+compose\s+up/, /\bdocker\s+compose\s+down/,
        /\bmake\s+(?:up|down|init|airbyte-|vf-|index|migrate)/,
    ];
    const hasWriteIntent = writeVerbs.some(rx => rx.test(command));
    if (!hasWriteIntent) {
        dbg(`no write verbs in command — allowing read of: ${offending.join(', ')}`);
        return null;
    }

    return {
        offending,
        commandSnippet: command.length > 200 ? command.slice(0, 200) + '...' : command,
    };
}

function main() {
    if (DISABLED) {
        dbg('disabled via WORKTREE_GUARD_DISABLE');
        return allow();
    }

    const input = readInput();
    if (!input) {
        dbg('no input — allow');
        return allow();
    }

    const { cwd, tool_name: toolName, tool_input: toolInput } = input;
    dbg(`event tool=${toolName} cwd=${cwd}`);

    const wt = detectAgentWorktree(cwd);
    if (!wt) {
        // Not in an agent worktree — orchestrator or human session, no enforcement.
        return allow();
    }

    dbg(`in worktree ${wt.worktreeRoot} (repo=${wt.repoRoot})`);

    if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
        const filePath = toolInput && (toolInput.file_path || toolInput.notebook_path);
        if (!filePath) return allow();
        if (isInsideWorktree(filePath, wt.worktreeRoot)) return allow();
        return deny(
            `worktree-write-guard: ${toolName} target is outside this agent's worktree.\n` +
            `  agent worktree: ${wt.worktreeRoot}\n` +
            `  attempted path: ${filePath}\n` +
            `\n` +
            `FIX: rewrite the path to be relative to your worktree, or use the ` +
            `absolute worktree path. Example: instead of\n` +
            `  ${wt.repoRoot}/Makefile\n` +
            `use:\n` +
            `  ${wt.worktreeRoot}/Makefile\n` +
            `\n` +
            `Background: per reports/2026-05-24-runaway-subagent-postmortem.md, ` +
            `sub-agents that edit via absolute paths to the main worktree silently ` +
            `contaminate the orchestrator's working tree. This hook (issue #708) ` +
            `prevents that.`
        );
    }

    if (toolName === 'Bash') {
        const command = toolInput && toolInput.command;
        const scan = scanBashForOutOfWorktreeWrites(command, wt.repoRoot, wt.worktreeRoot);
        if (!scan) return allow();
        return deny(
            `worktree-write-guard: Bash command writes to paths outside this agent's worktree.\n` +
            `  agent worktree: ${wt.worktreeRoot}\n` +
            `  offending path(s): ${scan.offending.join(', ')}\n` +
            `  command: ${scan.commandSnippet}\n` +
            `\n` +
            `FIX: rewrite paths to be relative to your worktree (preferred) or use\n` +
            `the absolute worktree path under ${wt.worktreeRoot}/.\n` +
            `\n` +
            `If this is a legitimate cross-worktree read (cat, grep, ls only), the\n` +
            `hook auto-allows reads — this fired because a write verb was detected.\n` +
            `If you genuinely need a write outside your worktree (rare), set\n` +
            `WORKTREE_GUARD_DISABLE=true in front of the command after asking\n` +
            `the orchestrator.\n` +
            `\n` +
            `Background: reports/2026-05-24-runaway-subagent-postmortem.md, #708.`
        );
    }

    return allow();
}

try {
    main();
} catch (e) {
    // Fail open. Better to allow a tool call than to block the agent on a bug here.
    process.stderr.write(`[worktree-write-guard] internal error: ${e.stack || e.message}\n`);
    process.exit(0);
}
