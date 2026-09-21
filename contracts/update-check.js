#!/usr/bin/env node
/**
 * update-check.js — Claude Code SessionStart hook for contracts pack
 *
 * Purpose:
 *   Notify the operator (across multiple machines) when the `contracts/`
 *   hook package in the local `hooks` git repo diverges from `origin/main`.
 *   Prints a one-line banner as SessionStart additional context so the
 *   operator sees it at session boot and can `git pull && node install.js --all`.
 *
 * Behavior:
 *   - Reads the installed contracts version from <claudeHooksDir>/contracts/.version
 *     (written by install-update-check.js at install time; presence not required
 *     for the check — only used as a fallback comparison anchor).
 *   - If the hooks repo root is a git repo, runs a bounded `git fetch --quiet`
 *     (3s timeout) against origin, then compares the tree hash of the local
 *     `contracts/` directory with `origin/<branch>:contracts` tree hash.
 *   - Prints an update banner when they differ; prints nothing when they match.
 *   - Rate-limited: only rechecks every UPDATE_CHECK_INTERVAL_MS (4 hours).
 *   - Fail-open on every error path so the SessionStart hook never blocks or
 *     stalls a session (including offline / VPN / DNS failure).
 *
 * Hook I/O contract:
 *   stdin  = JSON { session_id, cwd, hook_event_name, reason, ... }
 *   stdout = JSON { systemMessage?: string }
 *
 * Configuration surface (env, per CONTRACT §1):
 *   CONTRACTS_HOOKS_REPO       Absolute path to hooks git repo (default:
 *                              <homedir>/_CODING/hooks). Set on machines
 *                              where the repo lives elsewhere.
 *   CONTRACTS_UPDATE_INTERVAL  Recheck interval in ms (default 4h).
 *   CONTRACTS_FETCH_TIMEOUT    Git fetch timeout in ms (default 3000).
 *   CONTRACTS_UPDATE_VERBOSE   "true" to log to stderr for debugging.
 */

'use strict';

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execFileSync } = require('child_process');

// ── Configuration ───────────────────────────────────────────

const HOME             = os.homedir();
const HOOKS_REPO       = process.env.CONTRACTS_HOOKS_REPO
                          || path.join(HOME, '_CODING', 'hooks');
const CLAUDE_HOOKS_DIR = path.join(HOME, '.claude', 'hooks');
const STATE_DIR        = path.join(CLAUDE_HOOKS_DIR, 'contracts');
const VERSION_FILE     = path.join(STATE_DIR, '.version');
const LAST_CHECK_FILE  = path.join(STATE_DIR, '.last-check');

const FOUR_HOURS_MS    = 4 * 60 * 60 * 1000;
const UPDATE_INTERVAL  = parseInt(process.env.CONTRACTS_UPDATE_INTERVAL || '', 10)
                          || FOUR_HOURS_MS;
const FETCH_TIMEOUT_MS = parseInt(process.env.CONTRACTS_FETCH_TIMEOUT || '', 10)
                          || 3000;
const VERBOSE          = process.env.CONTRACTS_UPDATE_VERBOSE === 'true';

const CONTRACTS_SUBDIR = 'contracts';

// ── Utilities ───────────────────────────────────────────────

function log(msg) {
  if (VERBOSE) console.error(`[contracts/update-check] ${msg}`);
}

/**
 * Emit an empty SessionStart response and exit 0.
 * Called on every fail-open path so the hook never blocks session start.
 */
function silent() {
  try { process.stdout.write(JSON.stringify({})); } catch {}
  process.exit(0);
}

/**
 * Emit a SessionStart response with a systemMessage banner and exit 0.
 * @param {string} message - One-line banner to surface to the operator.
 */
function banner(message) {
  try {
    process.stdout.write(JSON.stringify({ systemMessage: message }));
  } catch {}
  process.exit(0);
}

/**
 * Run git with a bounded timeout, capturing stdout. Never throws upward —
 * returns null on any failure (non-zero exit, timeout, missing binary).
 * @param {string[]} args - git args (no leading "git").
 * @param {number} timeoutMs - kill signal after this many ms.
 * @returns {string|null} trimmed stdout, or null on failure.
 */
function gitCapture(args, timeoutMs) {
  try {
    const out = execFileSync('git', ['-C', HOOKS_REPO, ...args], {
      encoding: 'utf8',
      stdio:    ['ignore', 'pipe', 'pipe'],
      timeout:  timeoutMs,
    });
    return out.trim();
  } catch (e) {
    log(`git ${args.join(' ')} failed: ${e.message}`);
    return null;
  }
}

function readJSONSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJSONSafe(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    log(`could not write ${file}: ${e.message}`);
  }
}

// ── Recheck rate-limit ──────────────────────────────────────

/**
 * Read the last-check timestamp file. Returns 0 if missing/unreadable so
 * the first invocation always performs a real check.
 */
function readLastCheck() {
  const data = readJSONSafe(LAST_CHECK_FILE);
  if (!data || typeof data.ts !== 'number') return 0;
  return data.ts;
}

function writeLastCheck(status, extra = {}) {
  writeJSONSafe(LAST_CHECK_FILE, { ts: Date.now(), status, ...extra });
}

// ── Read stdin (hook payload; we don't actually need it, but consume it) ─

function drainStdin() {
  try { fs.readFileSync(0, 'utf8'); } catch {}
}

// ── Main check ──────────────────────────────────────────────

/**
 * Compare the local `contracts/` tree hash to origin/<branch>:contracts.
 * Returns a status object; never throws.
 *   { status: 'up-to-date' | 'update-available' | 'skipped', reason?, local?, remote? }
 */
function compareContractsTree() {
  // Is the hooks repo present and a git repo?
  if (!fs.existsSync(HOOKS_REPO)) {
    return { status: 'skipped', reason: `repo not found: ${HOOKS_REPO}` };
  }
  const gitDir = gitCapture(['rev-parse', '--git-dir'], 2000);
  if (!gitDir) {
    return { status: 'skipped', reason: 'not a git repo' };
  }

  // Determine which branch origin tracks. We compare against origin's default
  // remote-tracked branch when possible, otherwise fall back to `main`.
  const upstream = gitCapture(['rev-parse', '--abbrev-ref', 'origin/HEAD'], 2000)
                    || 'origin/main';
  const remoteBranch = upstream.replace(/^origin\//, '');

  // Bounded fetch. If it times out or fails, we skip (offline / no network).
  const fetched = gitCapture(['fetch', '--quiet', 'origin', remoteBranch], FETCH_TIMEOUT_MS);
  if (fetched === null) {
    return { status: 'skipped', reason: 'fetch failed or timed out' };
  }

  // Tree hash of local contracts/ (HEAD, not working tree — matches what an
  // installer would ship).
  const localTree = gitCapture(['rev-parse', `HEAD:${CONTRACTS_SUBDIR}`], 2000);
  const remoteTree = gitCapture(
    ['rev-parse', `origin/${remoteBranch}:${CONTRACTS_SUBDIR}`],
    2000,
  );

  if (!localTree || !remoteTree) {
    return { status: 'skipped', reason: 'could not resolve tree hashes' };
  }

  if (localTree === remoteTree) {
    return { status: 'up-to-date', local: localTree, remote: remoteTree };
  }
  return { status: 'update-available', local: localTree, remote: remoteTree };
}

/**
 * Entry point. Always exits 0 with either {} or {systemMessage: ...}.
 * Any error → silent().
 */
function main() {
  drainStdin();

  try {
    // Rate-limit: cached recent result → replay banner if it was
    // update-available; otherwise stay silent.
    const lastCheckTs = readLastCheck();
    const cache = readJSONSafe(LAST_CHECK_FILE);
    const now = Date.now();

    if (lastCheckTs && (now - lastCheckTs) < UPDATE_INTERVAL) {
      log(`within recheck window (${Math.round((now - lastCheckTs) / 1000)}s ago)`);
      if (cache && cache.status === 'update-available') {
        return banner(buildBanner());
      }
      return silent();
    }

    // Perform real check.
    const result = compareContractsTree();
    log(`check result: ${result.status} (${result.reason || ''})`);
    writeLastCheck(result.status, {
      local:  result.local  || null,
      remote: result.remote || null,
    });

    if (result.status === 'update-available') {
      return banner(buildBanner());
    }
    return silent();
  } catch (e) {
    log(`unexpected error: ${e.message}`);
    return silent();
  }
}

/**
 * Build the one-line banner surfaced to the operator. Uses `~` in the path
 * because it's a hint, not a path passed to `cd` programmatically.
 */
function buildBanner() {
  // Note: also embeds installed version if we have one, purely as context.
  const version = readJSONSafe(VERSION_FILE);
  const suffix = version && version.sha
    ? ` (installed ${version.sha.slice(0, 7)})`
    : '';
  return `contracts hook has updates available${suffix} — `
       + 'run: cd ~/_CODING/hooks && git pull && node contracts/install.js --all';
}

main();
