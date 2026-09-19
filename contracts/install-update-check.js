#!/usr/bin/env node
/**
 * install-update-check.js — Wiring for the contracts SessionStart update check
 *
 * Purpose:
 *   Small, importable installer module that the main `contracts/install.js`
 *   (written by a sibling agent) `require()`s to:
 *     - symlink update-check.js into <claudeHooksDir>/contracts/update-check.js
 *     - patch <settingsFile> to register a SessionStart hook that runs it
 *     - stamp <claudeHooksDir>/contracts/.version with the current repo SHA
 *
 * This module is intentionally scoped to *only* the update-check wiring.
 * The main install.js handles everything else (agent detection, other files,
 * uninstall of the main contracts hook, etc.).
 *
 * Exports:
 *   installUpdateCheck(claudeHooksDir, settingsFile)   → { installed, version }
 *   uninstallUpdateCheck(claudeHooksDir, settingsFile) → { removed }
 *
 * Both functions are idempotent and never throw on repeat invocations.
 * Errors during optional side-effects (version stamp) are logged but do not
 * abort the install — the SessionStart hook itself fails-open.
 */

'use strict';

const fs             = require('fs');
const path           = require('path');
const { execFileSync } = require('child_process');

// ── Constants ───────────────────────────────────────────────
//
// Kept as module-level constants (CONTRACT §1) so the same string is used
// for both install and uninstall matching. Changing the command string here
// changes both operations coherently.

const PACKAGE_DIR = __dirname;

/** Marker command string used to identify our SessionStart entry in settings.json. */
const HOOK_COMMAND = 'node ~/.claude/hooks/contracts/update-check.js';

/** SessionStart hook timeout, seconds. Small — the hook fail-opens quickly. */
const HOOK_TIMEOUT_SECONDS = 5;

// ── Small helpers (no ANSI — main install.js owns the UI) ───

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJSONAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function symlinkFile(src, dest) {
  ensureDir(path.dirname(dest));
  try { fs.unlinkSync(dest); } catch {}
  fs.symlinkSync(src, dest);
}

function removeIfSymlink(dest) {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(dest);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Read the current git SHA of the hooks repo containing this file.
 * Returns null if we can't determine one (not a git repo, git missing).
 * Used only for the .version stamp — non-fatal.
 */
function currentGitSha() {
  try {
    const out = execFileSync('git', ['-C', PACKAGE_DIR, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio:    ['ignore', 'pipe', 'ignore'],
      timeout:  2000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ── settings.json patching ──────────────────────────────────

/**
 * Return true if a SessionStart entry running HOOK_COMMAND already exists.
 * @param {object} settings - parsed settings.json.
 */
function hookAlreadyPresent(settings) {
  const arr = settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(arr)) return false;
  return arr.some(
    (e) => e && Array.isArray(e.hooks) && e.hooks.some((h) => h && h.command === HOOK_COMMAND),
  );
}

/**
 * Add the SessionStart entry, mutating `settings` in place.
 * Caller is responsible for writing.
 */
function addHookEntry(settings) {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
  settings.hooks.SessionStart.push({
    hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
  });
}

/**
 * Remove any SessionStart entries that reference HOOK_COMMAND.
 * Returns the number of entries removed.
 */
function removeHookEntry(settings) {
  const arr = settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(arr)) return 0;
  const before = arr.length;
  settings.hooks.SessionStart = arr.filter(
    (e) => !(e && Array.isArray(e.hooks) && e.hooks.some((h) => h && h.command === HOOK_COMMAND)),
  );
  return before - settings.hooks.SessionStart.length;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Install the SessionStart update-check hook.
 *
 * Steps:
 *   1. Symlink <PACKAGE_DIR>/update-check.js into
 *      <claudeHooksDir>/contracts/update-check.js.
 *   2. Add a SessionStart entry to <settingsFile> (idempotent — no-op if
 *      an entry with the same command already exists).
 *   3. Write <claudeHooksDir>/contracts/.version with the current repo SHA
 *      (best-effort; failures do not abort the install).
 *
 * @param {string} claudeHooksDir - typically `<home>/.claude/hooks`.
 * @param {string} settingsFile   - typically `<home>/.claude/settings.json`.
 * @returns {{ installed: boolean, version: string|null }}
 *   `installed` is false only if the hook was already present (nothing to do).
 */
function installUpdateCheck(claudeHooksDir, settingsFile) {
  if (typeof claudeHooksDir !== 'string' || !claudeHooksDir) {
    throw new Error('installUpdateCheck: claudeHooksDir is required');
  }
  if (typeof settingsFile !== 'string' || !settingsFile) {
    throw new Error('installUpdateCheck: settingsFile is required');
  }

  // 1) Symlink the hook script.
  const stateDir = path.join(claudeHooksDir, 'contracts');
  const src  = path.join(PACKAGE_DIR, 'update-check.js');
  const dest = path.join(stateDir, 'update-check.js');
  symlinkFile(src, dest);

  // 2) Patch settings.json (idempotent).
  const settings = readJSON(settingsFile);
  let added = false;
  if (!hookAlreadyPresent(settings)) {
    addHookEntry(settings);
    writeJSONAtomic(settingsFile, settings);
    added = true;
  }

  // 3) Stamp .version — best-effort only.
  const sha = currentGitSha();
  try {
    ensureDir(stateDir);
    fs.writeFileSync(
      path.join(stateDir, '.version'),
      JSON.stringify({ sha, installedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // Non-fatal: the update-check hook treats a missing .version as unknown
    // and still performs its tree-hash comparison.
  }

  return { installed: added, version: sha };
}

/**
 * Uninstall the SessionStart update-check hook.
 *
 * Steps:
 *   1. Remove <claudeHooksDir>/contracts/update-check.js symlink if present.
 *   2. Remove the SessionStart entry from <settingsFile>.
 *   3. Leave .version and .last-check on disk (they're cheap state; a
 *      subsequent reinstall reuses them). Caller can delete the containing
 *      directory if they want a clean slate.
 *
 * @param {string} claudeHooksDir - typically `<home>/.claude/hooks`.
 * @param {string} settingsFile   - typically `<home>/.claude/settings.json`.
 * @returns {{ removed: boolean }} true if either the symlink or the settings
 *   entry existed and was removed.
 */
function uninstallUpdateCheck(claudeHooksDir, settingsFile) {
  if (typeof claudeHooksDir !== 'string' || !claudeHooksDir) {
    throw new Error('uninstallUpdateCheck: claudeHooksDir is required');
  }
  if (typeof settingsFile !== 'string' || !settingsFile) {
    throw new Error('uninstallUpdateCheck: settingsFile is required');
  }

  const stateDir = path.join(claudeHooksDir, 'contracts');
  const dest = path.join(stateDir, 'update-check.js');
  const symlinkRemoved = removeIfSymlink(dest);

  let entryRemoved = 0;
  if (fs.existsSync(settingsFile)) {
    const settings = readJSON(settingsFile);
    entryRemoved = removeHookEntry(settings);
    if (entryRemoved > 0) {
      writeJSONAtomic(settingsFile, settings);
    }
  }

  return { removed: symlinkRemoved || entryRemoved > 0 };
}

module.exports = {
  installUpdateCheck,
  uninstallUpdateCheck,
  // Exposed for the main installer's --help / diagnostics, not for reuse:
  HOOK_COMMAND,
};
