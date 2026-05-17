#!/usr/bin/env node
/**
 * Git Session Hooks - User-Level Claude Code Integration
 *
 * Intelligent git workflow automation that works with ANY project.
 * Reads cwd from hook JSON input - fully dynamic.
 *
 * LOCATION: ~/.claude/hooks/git-session.js
 *
 * USAGE:
 *   node git-session.js --session-start   # Initialize git, create working branch
 *   node git-session.js --session-end     # Commit and push changes
 *   node git-session.js --pre-edit        # Checkpoint before Edit/Write tools
 *   node git-session.js --help            # Show help
 *
 * CONFIGURATION (environment variables):
 *   GIT_HOOK_PROTECTED_BRANCHES=main,master,dev,develop  # Auto-branch from these
 *   GIT_HOOK_BRANCH_PREFIX=claude                        # Prefix for auto-branches
 *   GIT_HOOK_AUTO_PUSH=true                              # Push on session end
 *   GIT_HOOK_AUTO_PULL=true                              # Pull on session start
 *   GIT_HOOK_CHECKPOINT=true                             # Checkpoint before edits
 *   GIT_HOOK_VERBOSE=true                                # Debug logging
 *
 * HOOK INPUT (via stdin):
 *   {
 *     "session_id": "abc123",
 *     "cwd": "/path/to/project",
 *     "hook_event_name": "SessionStart|SessionEnd|PreToolUse",
 *     "tool_name": "Edit|Write",           // For PreToolUse
 *     "tool_input": { "file_path": "..." } // For PreToolUse
 *   }
 *
 * PRE-EDIT CHECKPOINT SKIP CONDITIONS:
 *   The pre-edit hook tries hard NOT to race the agent's own git operations.
 *   The checkpoint is suppressed when any of these is true:
 *     1. tool_name === "Bash" and tool_input.command matches the git workflow
 *        pattern (commit/push/pull/fetch/rebase/cherry-pick/reset/revert/
 *        checkout/stash/merge/tag/am/format-patch/rev-parse/switch). Also
 *        opens a 60s window so subsequent edits in the same workflow skip.
 *     2. We are within the 60s window opened by a prior git workflow call.
 *     3. .git/.claude-busy exists and mtime < 5 minutes (explicit opt-in for
 *        orchestrators that want to bracket a multi-step git workflow).
 *     4. Existing skips: in-progress rebase/merge/cherry-pick, detached HEAD,
 *        recent branch switch/reset/rebase (10s reflog window), 30s cooldown.
 *
 *   Run `git-session/test-pre-edit-skips.sh` to verify these paths.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
    protectedBranches: (process.env.GIT_HOOK_PROTECTED_BRANCHES || 'main,master,dev,develop,staging').split(','),
    branchPrefix: process.env.GIT_HOOK_BRANCH_PREFIX || 'work',
    autoPush: process.env.GIT_HOOK_AUTO_PUSH !== 'false',
    autoPull: process.env.GIT_HOOK_AUTO_PULL !== 'false',
    checkpoint: process.env.GIT_HOOK_CHECKPOINT !== 'false',
    verbose: process.env.GIT_HOOK_VERBOSE === 'true'
};

// Track checkpoints to avoid excessive commits
const CHECKPOINT_COOLDOWN_MS = 30000; // 30 seconds between checkpoints
let lastCheckpointTime = 0;

// Skip-checkpoint window set when the agent is mid-git-workflow (e.g. just
// called `git commit`, `git rebase`, etc.). Multi-step git workflows that span
// several Bash calls will all see the skip flag for this long after the most
// recent git workflow command.
const GIT_WORKFLOW_SKIP_WINDOW_MS = 60_000;
let gitWorkflowSkipUntil = 0;

// Lock-file mechanism for cross-process / explicit-opt-in skip. If a workflow
// orchestrator (or the agent itself) creates `.git/.claude-busy`, every
// checkpoint inside the same repo is suppressed until the file is removed or
// goes stale. Stale = mtime older than this many ms.
const CLAUDE_BUSY_LOCKFILE = '.claude-busy';
const CLAUDE_BUSY_STALE_MS = 5 * 60_000;

// Commands whose presence in a Bash tool_input means "the agent is running its
// own git workflow next — do not race it with a checkpoint, and keep the skip
// window open for the multi-step tail (e.g. checkout → cherry-pick → commit)."
// Anchored matching against the first word after optional leading whitespace
// so we don't accidentally match `git_commit_helper` or `mygit commit`.
const GIT_WORKFLOW_PATTERN = /^\s*git\s+(commit|push|pull|fetch|rebase|cherry-pick|reset|revert|checkout|stash|merge|tag|am|format-patch|rev-parse|switch)\b/;

// =============================================================================
// Utilities
// =============================================================================

function log(msg) {
    if (CONFIG.verbose) {
        console.error(`[git-session] ${msg}`);
    }
}

function git(args, cwd, options = {}) {
    try {
        const result = execSync(`git ${args}`, {
            cwd,
            encoding: 'utf8',
            stdio: options.stdio || ['pipe', 'pipe', 'pipe'],
            timeout: 10000 // 10 second timeout
        });
        return { success: true, output: result.trim() };
    } catch (e) {
        return { success: false, output: e.stderr?.trim() || e.message };
    }
}

function readHookInput() {
    try {
        const stdin = fs.readFileSync(0, 'utf8');
        if (stdin) {
            return JSON.parse(stdin);
        }
    } catch (e) {
        // No stdin or invalid JSON
    }
    return {};
}

function getWorkingDir(hookInput) {
    return hookInput.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function isGitRepo(dir) {
    return git('rev-parse --git-dir', dir).success;
}

function getCurrentBranch(dir) {
    const result = git('rev-parse --abbrev-ref HEAD', dir);
    return result.success ? result.output : null;
}

function hasChanges(dir) {
    const status = git('status --porcelain', dir);
    return status.success && status.output.length > 0;
}

function hasStagedChanges(dir) {
    const result = git('diff --cached --quiet', dir);
    return !result.success; // Returns non-zero if there are staged changes
}

function hasRemote(dir) {
    const result = git('remote', dir);
    return result.success && result.output.includes('origin');
}

// Path to the busy-lock inside the repo's .git dir. Returns null if the dir
// is not a git repo or .git is unreadable (corrupted submodule, etc.).
function busyLockPath(dir) {
    const gitDir = git('rev-parse --git-dir', dir);
    if (!gitDir.success) return null;
    const resolved = path.isAbsolute(gitDir.output)
        ? gitDir.output
        : path.join(dir, gitDir.output);
    return path.join(resolved, CLAUDE_BUSY_LOCKFILE);
}

// Returns true if .git/.claude-busy exists and was touched within the stale
// window. The 5-minute window means a forgotten lock file does not silently
// disable checkpoints for the rest of the session.
function isClaudeBusy(dir) {
    const p = busyLockPath(dir);
    if (!p) return false;
    try {
        const stat = fs.statSync(p);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > CLAUDE_BUSY_STALE_MS) {
            log(`Lock file ${p} is stale (${Math.round(ageMs / 1000)}s old) — ignoring`);
            return false;
        }
        log(`Lock file ${p} present (${Math.round(ageMs / 1000)}s old) — skipping checkpoint`);
        return true;
    } catch (e) {
        return false;
    }
}

// Returns true when the next Bash tool call IS itself a git workflow command.
// We use this both to (a) skip the checkpoint that would race the git call and
// (b) refresh the skip window so subsequent edits in the same workflow are
// also covered.
function isGitWorkflowCommand(toolName, toolInput) {
    if (toolName !== 'Bash') return false;
    const cmd = (toolInput && toolInput.command) || '';
    return GIT_WORKFLOW_PATTERN.test(cmd);
}

function isInGitWorkflowWindow() {
    return Date.now() < gitWorkflowSkipUntil;
}

function openGitWorkflowWindow() {
    gitWorkflowSkipUntil = Date.now() + GIT_WORKFLOW_SKIP_WINDOW_MS;
}

function generateBranchName(sessionId, cwd) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const baseName = `${CONFIG.branchPrefix}/session-${date}`;

    // Check if base branch exists, if so add a suffix
    const baseExists = git(`rev-parse --verify ${baseName}`, cwd).success;
    if (!baseExists) {
        return baseName;
    }

    // Find next available suffix (a, b, c, ...)
    for (let i = 0; i < 26; i++) {
        const suffix = String.fromCharCode(97 + i); // a, b, c, ...
        const branchName = `${baseName}-${suffix}`;
        const exists = git(`rev-parse --verify ${branchName}`, cwd).success;
        if (!exists) {
            return branchName;
        }
    }

    // Fallback to random suffix if somehow 26 sessions in one day
    return `${baseName}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatChangeSummary(dir) {
    const status = git('status --porcelain', dir);
    if (!status.success) return 'Changes';

    const lines = status.output.split('\n').filter(Boolean);
    const stats = { modified: 0, added: 0, deleted: 0, untracked: 0 };

    for (const line of lines) {
        const code = line.slice(0, 2);
        if (code.includes('M')) stats.modified++;
        else if (code.includes('A')) stats.added++;
        else if (code.includes('D')) stats.deleted++;
        else if (code.includes('?')) stats.untracked++;
    }

    const parts = [];
    if (stats.modified) parts.push(`${stats.modified} modified`);
    if (stats.added) parts.push(`${stats.added} added`);
    if (stats.deleted) parts.push(`${stats.deleted} deleted`);
    if (stats.untracked) parts.push(`${stats.untracked} new`);

    return parts.join(', ') || 'Changes';
}

// Build the correct output JSON for Claude Code hooks
function outputResult(eventName, result) {
    // For PreToolUse: use permissionDecision allow/deny
    if (eventName === 'PreToolUse') {
        const out = {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow'
            }
        };
        if (result.systemMessage) {
            out.hookSpecificOutput.additionalContext = result.systemMessage;
        }
        console.log(JSON.stringify(out));
        process.exit(0);
    }

    // For SessionStart: hookSpecificOutput with additionalContext
    if (eventName === 'SessionStart') {
        const out = {};
        if (result.systemMessage) {
            out.systemMessage = result.systemMessage;
        }
        console.log(JSON.stringify(out));
        process.exit(0);
    }

    // For SessionEnd: no hookSpecificOutput, just top-level fields
    // SessionEnd cannot block termination, only perform cleanup
    if (result.systemMessage) {
        console.log(JSON.stringify({ systemMessage: result.systemMessage }));
    } else {
        console.log(JSON.stringify({}));
    }
    process.exit(0);
}

// =============================================================================
// Session Start Handler
// =============================================================================

function handleSessionStart(hookInput) {
    const cwd = getWorkingDir(hookInput);
    const sessionId = hookInput.session_id || '';

    log(`Session start in: ${cwd}`);

    // Skip on 'clear' reason
    if (hookInput.reason === 'clear') {
        log('Skipping - context clear');
        return outputResult('SessionStart', {});
    }

    // Check if directory exists
    if (!fs.existsSync(cwd)) {
        log(`Directory doesn't exist: ${cwd}`);
        return outputResult('SessionStart', {});
    }

    // Initialize git if not a repo
    if (!isGitRepo(cwd)) {
        log('Not a git repo - initializing');
        git('init', cwd);
        git('config user.email "claude@session.local"', cwd);
        git('config user.name "Claude Code"', cwd);

        if (hasChanges(cwd)) {
            git('add -A', cwd);
            git('commit -m "Initial commit"', cwd);
        }

        return outputResult('SessionStart', {
            systemMessage: `Initialized git repository in ${cwd}`
        });
    }

    // Get current branch
    const currentBranch = getCurrentBranch(cwd);
    log(`Current branch: ${currentBranch}`);

    // Collect messages for combined output
    const messages = [];

    // Step 1: Check for uncommitted changes on protected branch
    if (CONFIG.protectedBranches.includes(currentBranch) && hasChanges(cwd)) {
        log('Uncommitted changes on protected branch');
        messages.push(`Warning: Uncommitted changes on '${currentBranch}'. Consider committing before making changes.`);
        // Don't pull or branch if there are uncommitted changes
        return outputResult('SessionStart', {
            systemMessage: messages.join(' ')
        });
    }

    // Step 2: Pull latest if remote exists and no local changes
    if (CONFIG.autoPull && hasRemote(cwd) && !hasChanges(cwd)) {
        log(`Pulling latest from origin/${currentBranch}`);
        const pullResult = git(`pull --ff-only origin ${currentBranch}`, cwd);
        if (pullResult.success && pullResult.output && !pullResult.output.includes('Already up to date')) {
            const firstLine = pullResult.output.split('\n')[0];
            log(`Pulled updates: ${firstLine}`);
            messages.push(`Pulled latest from '${currentBranch}'.`);
        } else if (!pullResult.success) {
            log(`Pull failed (may need manual merge): ${pullResult.output}`);
            messages.push(`Pull failed (may need manual merge).`);
        }
    }

    // Step 3: Create working branch if on protected branch
    if (CONFIG.protectedBranches.includes(currentBranch)) {
        const newBranch = generateBranchName(sessionId, cwd);
        log(`On protected branch - creating '${newBranch}'`);

        const createResult = git(`checkout -b ${newBranch}`, cwd);
        if (createResult.success) {
            messages.push(`Created working branch '${newBranch}' from '${currentBranch}'.`);
        } else {
            log(`Could not create branch: ${createResult.output}`);
        }
    }

    // Step 4: Add branch + recent git log context with changed files
    const activeBranch = getCurrentBranch(cwd) || currentBranch;
    const recentLog = git('log --oneline --name-only -3', cwd);
    const statusSummary = hasChanges(cwd) ? ' (uncommitted changes)' : '';

    let gitContext = `Branch: ${activeBranch}${statusSummary}`;
    if (recentLog.success && recentLog.output) {
        gitContext += `\nRecent commits:\n${recentLog.output}`;
    }
    messages.push(gitContext);

    // Also write to stderr so it's visible in verbose mode (Ctrl+O)
    const fullContext = messages.join('\n');
    console.error(`[git-session] ${fullContext.replace(/\n/g, '\n[git-session] ')}`);

    return outputResult('SessionStart', {
        systemMessage: fullContext
    });
}

// =============================================================================
// Checkpoint Squash (session-end)
// =============================================================================

const CHECKPOINT_SUBJECT_RE = /^Checkpoint before editing /;

/**
 * Squash contiguous unpushed "Checkpoint before editing X" commits at HEAD
 * into a single commit. Safe by construction:
 *   - never touches protected branches
 *   - only squashes commits whose subject matches CHECKPOINT_SUBJECT_RE
 *   - stops at the first non-checkpoint commit (no interleave)
 *   - refuses if any candidate is already on the remote
 *   - writes refs/checkpoint-recovery/<timestamp> before rewriting history
 *   - bails on any error and leaves the branch untouched
 *
 * Returns { squashed: int, recoveryRef: string|null, message: string }
 */
function squashCheckpoints(cwd, branch) {
    // Never rewrite protected branches.
    if (CONFIG.protectedBranches.includes(branch)) {
        return { squashed: 0, recoveryRef: null, message: `protected branch ${branch}` };
    }

    // Working tree must be clean — otherwise reset --soft would clobber.
    if (hasChanges(cwd)) {
        return { squashed: 0, recoveryRef: null, message: 'working tree dirty' };
    }

    // Determine the boundary of "unpushed": @{upstream} if it exists, else
    // fall back to the merge-base with the first protected branch we find.
    let boundary = null;
    const upstream = git('rev-parse --abbrev-ref --symbolic-full-name @{upstream}', cwd);
    if (upstream.success && upstream.output && upstream.output !== '@{upstream}') {
        boundary = upstream.output;
    } else {
        for (const p of CONFIG.protectedBranches) {
            const mb = git(`merge-base HEAD ${p}`, cwd);
            if (mb.success && mb.output) {
                boundary = mb.output;
                break;
            }
        }
    }
    if (!boundary) {
        return { squashed: 0, recoveryRef: null, message: 'no upstream or protected-branch boundary' };
    }

    // List candidate commits from HEAD back to the boundary (exclusive).
    const range = git(`log ${boundary}..HEAD --pretty=format:%H%x09%s`, cwd);
    if (!range.success || !range.output) {
        return { squashed: 0, recoveryRef: null, message: 'no unpushed commits' };
    }

    // Walk from HEAD downward; collect contiguous checkpoints.
    const lines = range.output.split('\n');
    const checkpointShas = [];
    let stoppedAtNonCheckpoint = false;
    for (const line of lines) {
        const [sha, ...rest] = line.split('\t');
        const subject = rest.join('\t');
        if (CHECKPOINT_SUBJECT_RE.test(subject)) {
            checkpointShas.push(sha);
        } else {
            stoppedAtNonCheckpoint = true;
            break;
        }
    }

    // Nothing to do.
    if (checkpointShas.length < 2) {
        return { squashed: 0, recoveryRef: null, message: `only ${checkpointShas.length} contiguous checkpoint(s) at HEAD` };
    }

    // Refuse to rewrite anything that's already on the remote. The boundary
    // we used (upstream OR protected merge-base) only proves the candidates
    // are not behind a known stable point — it does NOT prove they're absent
    // from the remote. Be explicit: check each candidate against the actual
    // remote ref for this branch.
    if (hasRemote(cwd)) {
        const remoteRef = git(`rev-parse refs/remotes/origin/${branch}`, cwd);
        if (remoteRef.success && remoteRef.output) {
            for (const sha of checkpointShas) {
                const onRemote = git(`merge-base --is-ancestor ${sha} ${remoteRef.output}`, cwd);
                if (onRemote.success) {
                    return {
                        squashed: 0,
                        recoveryRef: null,
                        message: `checkpoint ${sha.slice(0, 12)} is already on origin/${branch}; refusing to rewrite published history`,
                    };
                }
            }
        }
    }

    // The squash target is the parent of the OLDEST checkpoint in our run.
    const oldestCheckpoint = checkpointShas[checkpointShas.length - 1];
    const parentLookup = git(`rev-parse ${oldestCheckpoint}^`, cwd);
    if (!parentLookup.success) {
        return { squashed: 0, recoveryRef: null, message: `cannot resolve parent of ${oldestCheckpoint}` };
    }
    const squashTarget = parentLookup.output;

    // Safety: make sure HEAD's tree is identical to whatever we'd reach by
    // resetting to squashTarget and re-applying everything. (It is, by
    // definition — all the commits are ancestors of HEAD.) We just sanity
    // check that squashTarget is reachable.
    const reachable = git(`merge-base --is-ancestor ${squashTarget} HEAD`, cwd);
    if (!reachable.success) {
        return { squashed: 0, recoveryRef: null, message: `${squashTarget} is not an ancestor of HEAD` };
    }

    // Write a recovery ref pointing at the current HEAD before we rewrite.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryRef = `refs/checkpoint-recovery/${branch}-${stamp}`;
    const headSha = git('rev-parse HEAD', cwd);
    if (!headSha.success) {
        return { squashed: 0, recoveryRef: null, message: 'cannot resolve HEAD' };
    }
    const refUpdate = git(`update-ref ${recoveryRef} ${headSha.output}`, cwd);
    if (!refUpdate.success) {
        return { squashed: 0, recoveryRef: null, message: `cannot write recovery ref: ${refUpdate.output}` };
    }

    // Derive a commit message. Cap file list at 10 entries.
    const filesChanged = git(`diff --name-only ${squashTarget}..HEAD`, cwd);
    const fileList = filesChanged.success
        ? filesChanged.output.split('\n').filter(Boolean)
        : [];
    const fileSummary = fileList.length === 0
        ? 'no files'
        : (fileList.length <= 10
            ? fileList.join(', ')
            : `${fileList.slice(0, 10).join(', ')} and ${fileList.length - 10} more`);
    const msgSubject = `chore(checkpoint): squash ${checkpointShas.length} auto-checkpoints`;
    const msgBody = [
        `Squashed ${checkpointShas.length} auto-checkpoint commits from session.`,
        '',
        `Files changed: ${fileSummary}`,
        '',
        `Recovery: pre-squash state at ${recoveryRef} (= ${headSha.output.slice(0, 12)}).`,
        `Restore with: git update-ref refs/heads/${branch} ${recoveryRef}`,
    ].join('\n');
    const fullMsg = `${msgSubject}\n\n${msgBody}`;

    // Soft-reset to the squash target, then commit.
    const reset = git(`reset --soft ${squashTarget}`, cwd);
    if (!reset.success) {
        // Roll back the recovery ref since we didn't actually rewrite.
        git(`update-ref -d ${recoveryRef}`, cwd);
        return { squashed: 0, recoveryRef: null, message: `reset failed: ${reset.output}` };
    }
    // Write the message to a tempfile and use -F so newlines are preserved
    // verbatim (JSON.stringify shell-escapes them as \n literals — wrong).
    const msgFile = path.join(cwd, '.git', `.checkpoint-squash-msg-${Date.now()}`);
    fs.writeFileSync(msgFile, fullMsg);
    const commit = git(`commit --no-verify -F ${JSON.stringify(msgFile)}`, cwd);
    try { fs.unlinkSync(msgFile); } catch (e) { /* best-effort */ }
    if (!commit.success) {
        // Best-effort restore.
        git(`reset --hard ${recoveryRef}`, cwd);
        return { squashed: 0, recoveryRef: null, message: `commit failed: ${commit.output}` };
    }

    return {
        squashed: checkpointShas.length,
        recoveryRef,
        message: stoppedAtNonCheckpoint
            ? `squashed ${checkpointShas.length} (stopped at non-checkpoint commit)`
            : `squashed ${checkpointShas.length}`,
    };
}

// =============================================================================
// Session End Handler
// =============================================================================

function handleSessionEnd(hookInput) {
    const cwd = getWorkingDir(hookInput);

    log(`Session end in: ${cwd}`);

    // Skip on 'clear' reason
    if (hookInput.reason === 'clear') {
        log('Skipping - context clear');
        return outputResult('SessionEnd', {});
    }

    // Skip if not a git repo
    if (!isGitRepo(cwd)) {
        log('Not a git repo - skipping');
        return outputResult('SessionEnd', {});
    }

    const currentBranch = getCurrentBranch(cwd);
    const messages = [];

    // 1) If there are uncommitted changes, make a final session-end commit.
    if (hasChanges(cwd)) {
        const changeSummary = formatChangeSummary(cwd);
        git('add -A', cwd);
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const commitMsg = `Claude session end: ${changeSummary}\n\nAuto-committed at ${timestamp}`;
        const commitResult = git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`, cwd);
        if (!commitResult.success) {
            log(`Final commit failed: ${commitResult.output}`);
            // Don't squash if we couldn't commit — state is suspect.
            return outputResult('SessionEnd', {});
        }
        log(`Committed final session-end snapshot: ${changeSummary}`);
        messages.push(`Final session commit: ${changeSummary}`);
    } else {
        log('No uncommitted changes at session end');
    }

    // 2) Squash any contiguous auto-checkpoints below HEAD into one commit.
    //    Controlled by GIT_HOOK_SQUASH_CHECKPOINTS (default: true).
    const squashEnabled = process.env.GIT_HOOK_SQUASH_CHECKPOINTS !== 'false';
    if (squashEnabled) {
        const squashResult = squashCheckpoints(cwd, currentBranch);
        if (squashResult.squashed > 0) {
            log(`Squashed ${squashResult.squashed} checkpoint commits (recovery: ${squashResult.recoveryRef})`);
            messages.push(`Squashed ${squashResult.squashed} auto-checkpoints. Recovery ref: ${squashResult.recoveryRef}`);
        } else {
            log(`Squash skipped: ${squashResult.message}`);
        }
    }

    // 3) Push if configured and safe.
    if (CONFIG.autoPush && hasRemote(cwd) && !CONFIG.protectedBranches.includes(currentBranch)) {
        log(`Pushing to origin/${currentBranch}`);
        // After a squash, history was rewritten. Use --force-with-lease so we
        // never clobber someone else's work, but allow our own rewrite to land.
        const pushResult = git(`push --force-with-lease -u origin ${currentBranch}`, cwd);
        if (!pushResult.success) {
            log(`Push failed: ${pushResult.output}`);
            messages.push(`Push failed (likely needs manual review): ${pushResult.output.split('\n')[0]}`);
        }
    }

    if (messages.length > 0) {
        console.error(`[git-session] ${messages.join(' | ')}`);
    }
    return outputResult('SessionEnd', {});
}

// =============================================================================
// Pre-Edit Checkpoint Handler
// =============================================================================

function handlePreEdit(hookInput) {
    if (!CONFIG.checkpoint) {
        return outputResult('PreToolUse', {});
    }

    const cwd = getWorkingDir(hookInput);
    const toolName = hookInput.tool_name;
    const toolInput = hookInput.tool_input || {};

    log(`Pre-edit checkpoint: ${toolName}`);

    // ─ Skip when the agent is about to run its own git workflow. ─
    // If the next Bash call IS a git workflow command, we must not race it
    // with a checkpoint commit. Open a 60s window so any edits the agent
    // makes between this step and the rest of the workflow (e.g. resolve a
    // merge conflict, then `git commit`) also skip.
    if (isGitWorkflowCommand(toolName, toolInput)) {
        const cmd = (toolInput.command || '').slice(0, 80);
        log(`Git workflow command detected (${cmd}) — opening 60s skip window`);
        openGitWorkflowWindow();
        return outputResult('PreToolUse', {});
    }

    // Already in a git workflow window opened by a recent git workflow call.
    if (isInGitWorkflowWindow()) {
        log('Within git workflow skip window — skipping checkpoint');
        return outputResult('PreToolUse', {});
    }

    // Lock-file skip — for cross-process orchestrators or explicit opt-in.
    // Honored before the file-type filter so a busy lock suppresses checkpoints
    // even on Edit/Write tools that would otherwise unconditionally trigger.
    if (isClaudeBusy(cwd)) {
        return outputResult('PreToolUse', {});
    }

    // Only for Edit, Write, and a narrow set of destructive Bash commands.
    // Git workflow commands are handled above and explicitly NOT in this
    // pattern list — they're skipped, not checkpointed.
    const destructiveTools = ['Edit', 'Write', 'NotebookEdit'];
    if (!destructiveTools.includes(toolName)) {
        if (toolName === 'Bash') {
            const cmd = toolInput.command || '';
            const destructivePatterns = [
                /\brm\s+(-rf?|--recursive)?\s/i,
                /\bmv\s+\S+\s+\S+/, // mv with two args, not `git mv` (handled by workflow skip)
                /^\s*>\s*\S/,        // shell redirect-overwrite at start of command
            ];
            const isDestructive = destructivePatterns.some(p => p.test(cmd));
            if (!isDestructive) {
                return outputResult('PreToolUse', {});
            }
            log(`Destructive bash command detected: ${cmd.slice(0, 50)}`);
        } else {
            return outputResult('PreToolUse', {});
        }
    }

    // Skip if not a git repo
    if (!isGitRepo(cwd)) {
        return outputResult('PreToolUse', {});
    }

    // Skip during rebase / merge / cherry-pick / detached HEAD — committing
    // here strands work on a non-branch ref and breaks history.
    const gitDir = git('rev-parse --git-dir', cwd).output.trim() || '.git';
    const inProgressMarkers = [
        'rebase-merge', 'rebase-apply',
        'MERGE_HEAD', 'CHERRY_PICK_HEAD',
        'BISECT_LOG', 'REVERT_HEAD',
    ];
    for (const marker of inProgressMarkers) {
        try {
            if (require('fs').existsSync(require('path').join(cwd, gitDir, marker))) {
                log(`Skipping checkpoint - git operation in progress (${marker})`);
                return outputResult('PreToolUse', {});
            }
        } catch (e) { /* best-effort */ }
    }
    const branchRef = git('symbolic-ref -q HEAD', cwd);
    if (!branchRef.success || !branchRef.output.trim()) {
        log('Skipping checkpoint - detached HEAD');
        return outputResult('PreToolUse', {});
    }

    // Skip if a branch switch / reset / rebase happened in the last 10 seconds.
    // Checkpointing right after a switch can land work on the wrong branch
    // when the working tree carries unstaged changes across the switch.
    const reflog = git('reflog --date=unix HEAD -10', cwd);
    if (reflog.success) {
        const nowSec = Math.floor(Date.now() / 1000);
        const lines = reflog.output.split('\n').slice(0, 10);
        for (const line of lines) {
            const m = line.match(/HEAD@\{(\d+)\}:\s+(checkout|reset|rebase)/);
            if (m) {
                const ts = parseInt(m[1], 10);
                if (nowSec - ts < 10) {
                    log(`Skipping checkpoint - recent ${m[2]} (${nowSec - ts}s ago)`);
                    return outputResult('PreToolUse', {});
                }
                break;
            }
        }
    }

    // Rate limit checkpoints
    const now = Date.now();
    if (now - lastCheckpointTime < CHECKPOINT_COOLDOWN_MS) {
        log('Checkpoint cooldown - skipping');
        return outputResult('PreToolUse', {});
    }

    // Skip if no changes
    if (!hasChanges(cwd)) {
        return outputResult('PreToolUse', {});
    }

    // Get the file being edited
    const targetFile = toolInput.file_path;
    const shortFile = targetFile ? path.basename(targetFile) : 'files';

    // Create checkpoint commit
    git('add -A', cwd);

    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const commitMsg = `Checkpoint before editing ${shortFile}\n\nAuto-checkpoint at ${timestamp}`;

    const commitResult = git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`, cwd);
    if (commitResult.success) {
        lastCheckpointTime = now;
        log(`Checkpoint created before editing ${shortFile}`);
    }

    return outputResult('PreToolUse', {});
}

// =============================================================================
// CLI
// =============================================================================

function showHelp() {
    console.log(`
Git Session Hooks - User-Level Claude Code Integration

LOCATION: ~/.claude/hooks/git-session.js

USAGE:
  node git-session.js [command]

COMMANDS:
  --session-start    Initialize git, create working branch if on main/dev
  --session-end      Commit and push all changes
  --pre-edit         Create checkpoint commit before destructive operations
  --help             Show this help

ENVIRONMENT VARIABLES:
  GIT_HOOK_PROTECTED_BRANCHES  Branches to auto-branch from (default: main,master,dev,develop)
  GIT_HOOK_BRANCH_PREFIX       Auto-branch prefix (default: claude)
  GIT_HOOK_AUTO_PUSH           Push on session end (default: true)
  GIT_HOOK_AUTO_PULL           Pull on session start (default: true)
  GIT_HOOK_CHECKPOINT          Checkpoint before edits (default: true)
  GIT_HOOK_VERBOSE             Debug logging (default: false)

BEHAVIOR:
  Session Start:
    - Initialize git if not a repo
    - Pull latest from remote (if no local changes)
    - Create working branch if on protected branch

  Session End:
    - Commit all changes with summary
    - Push to remote (unless on protected branch)

  Pre-Edit:
    - Create checkpoint commit before destructive operations
    - Triggers on: Edit, Write, NotebookEdit, destructive Bash (rm, git reset, mv, >)
    - Rate-limited to avoid excessive commits (30s cooldown)

CONFIGURATION:
  Add to ~/.claude/settings.json:
  {
    "hooks": {
      "SessionStart": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/git-session.js --session-start" }] }],
      "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/git-session.js --session-end" }] }],
      "PreToolUse": [{ "matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/git-session.js --pre-edit" }] }]
    }
  }
`);
}

// Main
const args = process.argv.slice(2);
const hookInput = readHookInput();

if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
}

if (args.includes('--session-start')) {
    handleSessionStart(hookInput);
} else if (args.includes('--session-end')) {
    handleSessionEnd(hookInput);
} else if (args.includes('--pre-edit')) {
    handlePreEdit(hookInput);
} else {
    console.error('Unknown command. Use --help for usage.');
    process.exit(1);
}
