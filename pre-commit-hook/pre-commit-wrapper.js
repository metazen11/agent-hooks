#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// pre-commit-wrapper.js — Claude Code PreToolUse hook
// ─────────────────────────────────────────────────────────────
//
// Intercepts Bash tool calls containing `git commit` and runs
// the pre-commit quality check before allowing the commit.
//
// Protocol:
//   stdin:  { tool_name, tool_input: { command }, cwd }
//   stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
//
// Design: fail-open (if script missing or timeout, allow commit)
// ─────────────────────────────────────────────────────────────

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Constants ───────────────────────────────────────────────

const HOOK_EVENT = 'PreToolUse';
const TIMEOUT_MS = 55000;
const PRE_COMMIT_SCRIPT = path.resolve(__dirname, '..', 'pre-commit');

// ── Helpers ─────────────────────────────────────────────────

function allow() {
  const result = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'allow',
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

function deny(reason) {
  const result = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

function isGitCommitCommand(command) {
  if (!command) return false;
  // Match `git commit` but not `git commit --no-verify`
  if (/--no-verify/.test(command)) return false;
  return /\bgit\s+commit\b/.test(command);
}

function scriptExists() {
  try {
    fs.accessSync(PRE_COMMIT_SCRIPT, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────

function main(input) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    allow();
    return;
  }

  // Only intercept Bash tool
  if (data.tool_name !== 'Bash') {
    allow();
    return;
  }

  const command = data.tool_input?.command || '';

  // Only intercept git commit commands
  if (!isGitCommitCommand(command)) {
    allow();
    return;
  }

  // Verify pre-commit script exists
  if (!scriptExists()) {
    process.stderr.write(
      `[pre-commit-wrapper] WARNING: Script not found at ${PRE_COMMIT_SCRIPT} — allowing commit\n`
    );
    allow();
    return;
  }

  // Run pre-commit check
  const cwd = data.cwd || process.cwd();

  try {
    execSync(`bash "${PRE_COMMIT_SCRIPT}"`, {
      cwd,
      timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
    });
    // Exit 0 — checks passed
    allow();
  } catch (e) {
    if (e.killed) {
      // Timeout
      process.stderr.write(
        `[pre-commit-wrapper] WARNING: Pre-commit script timed out after ${TIMEOUT_MS}ms — allowing commit\n`
      );
      allow();
    } else {
      // Non-zero exit — checks failed
      const output = (e.stdout || '').toString().trim();
      const stderr = (e.stderr || '').toString().trim();
      const reason = [
        'Pre-commit quality checks FAILED. Fix errors before committing:',
        '',
        output,
        stderr ? `\nStderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      deny(reason);
    }
  }
}

// ── Read stdin ──────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { main(input); });

// Handle broken pipe gracefully
process.stdout.on('error', () => process.exit(0));
process.stderr.on('error', () => {});
