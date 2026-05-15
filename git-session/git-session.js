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

    // Only for Edit, Write, and destructive Bash commands
    const destructiveTools = ['Edit', 'Write', 'NotebookEdit'];
    if (!destructiveTools.includes(toolName)) {
        // Also check for destructive bash commands
        if (toolName === 'Bash') {
            const cmd = toolInput.command || '';
            const destructivePatterns = [
                /\brm\s+(-rf?|--recursive)?\s/i,
                /\bgit\s+(reset|revert|checkout|clean)/i,
                /\bmv\s+/,
                />\s*[^|]/, // Redirect overwrite (not pipe)
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
