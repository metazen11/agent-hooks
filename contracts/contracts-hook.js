#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// contracts-hook.js — Claude Code PreToolUse dispatcher
// ─────────────────────────────────────────────────────────────
//
// Loads each mechanical check module from ./checks/ and runs it
// against the incoming tool call. First check that returns
// `{ allow: false, reason }` short-circuits the dispatch and
// denies the tool call with that reason. Otherwise the call is
// allowed.
//
// Protocol:
//   stdin:  { tool_name, tool_input, cwd }
//   stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason? } }
//
// Design: fail-open on parse errors and unknown check failures.
// A broken dispatcher must not block the operator's work — it
// logs to stderr and allows the call. Blocking behavior is
// reserved for actual contract violations detected by a check.
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

const HOOK_EVENT = 'PreToolUse';
const CHECKS_DIR = path.resolve(__dirname, 'checks');
const CHECK_FILE_RE = /^s\d+.*\.js$/;

/**
 * Build an "allow" response payload for the Claude Code hook protocol.
 * @returns {object} hookSpecificOutput envelope with permissionDecision=allow.
 */
function allowPayload() {
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'allow',
    },
  };
}

/**
 * Build a "deny" response payload for the Claude Code hook protocol.
 * @param {string} reason Human-readable explanation shown to the agent.
 * @returns {object} hookSpecificOutput envelope with permissionDecision=deny.
 */
function denyPayload(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Write a JSON payload to stdout and exit 0.
 *
 * We always exit 0 even on deny: the deny is expressed in the payload,
 * not the exit code. Non-zero exit is reserved for hook infrastructure
 * failure (which fails-open on the Claude Code side anyway).
 *
 * @param {object} payload The response envelope.
 */
function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

/**
 * Load every check module from the checks directory.
 *
 * Each module must export a `check(toolName, toolInput)` function that
 * returns `{ allow: true }` or `{ allow: false, reason: string }`.
 *
 * Modules whose file name does not match /^s\d+.*\.js$/ are ignored so
 * that stray files (fixtures, .test.js siblings) do not run as checks.
 *
 * @param {string} [dir] Directory to scan. Defaults to ./checks.
 * @returns {Array<{ id: string, check: Function }>} Loaded check handles.
 */
function loadChecks(dir) {
  const target = dir || CHECKS_DIR;
  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch (e) {
    process.stderr.write(
      `[contracts] Failed to read checks dir ${target}: ${e.message}\n`
    );
    return [];
  }

  const checks = [];
  for (const name of entries.sort()) {
    if (!CHECK_FILE_RE.test(name)) continue;
    const full = path.join(target, name);
    try {
      const mod = require(full);
      if (mod && typeof mod.check === 'function') {
        checks.push({ id: name, check: mod.check });
      } else {
        process.stderr.write(
          `[contracts] ${name} does not export a check(fn) — skipped\n`
        );
      }
    } catch (e) {
      process.stderr.write(
        `[contracts] Failed to load ${name}: ${e.message}\n`
      );
    }
  }
  return checks;
}

/**
 * Run every check against the tool call. Returns the first denial or
 * an allow envelope if all checks pass.
 *
 * A check that throws is logged and treated as an allow — a broken
 * check must not block work.
 *
 * @param {Array<{ id: string, check: Function }>} checks Loaded check handles.
 * @param {string} toolName Claude Code tool name (e.g. "Write", "Bash").
 * @param {object} toolInput Tool-specific input payload.
 * @returns {object} A hookSpecificOutput envelope.
 */
function dispatch(checks, toolName, toolInput) {
  for (const entry of checks) {
    let result;
    try {
      result = entry.check(toolName, toolInput);
    } catch (e) {
      process.stderr.write(
        `[contracts] ${entry.id} threw: ${e.message}\n`
      );
      continue;
    }
    if (result && result.allow === false) {
      const reason = typeof result.reason === 'string' && result.reason.length > 0
        ? result.reason
        : `Blocked by ${entry.id}`;
      return denyPayload(reason);
    }
  }
  return allowPayload();
}

/**
 * Parse the stdin JSON payload and dispatch. Fail-open on malformed
 * input (allow the tool call and log the parse error to stderr).
 *
 * @param {string} raw Raw stdin contents.
 */
function main(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `[contracts] Failed to parse hook input: ${e.message}\n`
    );
    respond(allowPayload());
    return;
  }

  const toolName = data && typeof data.tool_name === 'string' ? data.tool_name : '';
  const toolInput = data && data.tool_input && typeof data.tool_input === 'object'
    ? data.tool_input
    : {};

  const checks = loadChecks();
  if (checks.length === 0) {
    respond(allowPayload());
    return;
  }

  respond(dispatch(checks, toolName, toolInput));
}

// ── stdin plumbing ─────────────────────────────────────────

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => { main(input); });

  // Broken-pipe handling: if the consumer went away before we finished
  // writing, exit quietly rather than crashing the hook host.
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
  });
  process.stderr.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
  });
}

module.exports = {
  allowPayload,
  denyPayload,
  loadChecks,
  dispatch,
  main,
  CHECKS_DIR,
};
