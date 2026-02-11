#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall git-session hooks
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # install (symlinks + settings)
//    node install.js --uninstall  # remove symlinks + settings entry
//
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ───────────────────────────────────────────────────

const PACKAGE_DIR = __dirname;
const HOME        = os.homedir();

const HOOK_FILES = ['git-session.js'];

// Agent targets
const TARGETS = {
  claude: {
    hooksDir:     path.join(HOME, '.claude', 'hooks'),
    settingsFile: path.join(HOME, '.claude', 'settings.json'),
    hookEntries: [
      {
        event: 'SessionStart',
        entry: {
          hooks: [{
            type: 'command',
            command: 'node ~/.claude/hooks/git-session.js --session-start',
            timeout: 30,
          }],
        },
      },
      {
        event: 'SessionEnd',
        entry: {
          hooks: [{
            type: 'command',
            command: 'node ~/.claude/hooks/git-session.js --session-end',
            timeout: 60,
          }],
        },
      },
      {
        event: 'PreToolUse',
        entry: {
          matcher: 'Edit|Write|NotebookEdit|Bash',
          hooks: [{
            type: 'command',
            command: 'node ~/.claude/hooks/git-session.js --pre-edit',
            timeout: 15,
          }],
        },
      },
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────

const LOG_PREFIX = '  ';
const ok   = (msg) => console.log(`${LOG_PREFIX}+  ${msg}`);
const skip = (msg) => console.log(`${LOG_PREFIX}.  ${msg}`);
const warn = (msg) => console.log(`${LOG_PREFIX}!  ${msg}`);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ok(`Created ${dir}`);
  }
}

function symlink(src, dest) {
  try { fs.unlinkSync(dest); } catch {}
  fs.symlinkSync(src, dest);
  ok(`${path.basename(dest)}  ->  ${src}`);
}

function removeSymlink(dest) {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(dest);
      ok(`Removed ${path.basename(dest)}`);
    } else {
      warn(`${path.basename(dest)} is not a symlink -- skipped`);
    }
  } catch {
    skip(`${path.basename(dest)} not found -- nothing to remove`);
  }
}

// ── Settings patching ────────────────────────────────────────

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSettings(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function addHookEntries(settingsFile, hookEntries) {
  const settings = readSettings(settingsFile);
  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  for (const { event, entry } of hookEntries) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const cmd = entry.hooks[0].command;
    const exists = settings.hooks[event].some(
      (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
    );

    if (exists) {
      skip(`${event} hook already in settings`);
      continue;
    }

    settings.hooks[event].push(entry);
    ok(`Added ${event} hook to settings`);
    changed = true;
  }

  if (changed) {
    writeSettings(settingsFile, settings);
  }
}

function removeHookEntries(settingsFile, hookEntries) {
  if (!fs.existsSync(settingsFile)) {
    skip(`${path.basename(settingsFile)} not found`);
    return;
  }

  const settings = readSettings(settingsFile);
  let changed = false;

  for (const { event, entry } of hookEntries) {
    const arr = settings.hooks?.[event];
    if (!arr) continue;

    const cmd = entry.hooks[0].command;
    const before = arr.length;
    settings.hooks[event] = arr.filter(
      (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
    );

    if (settings.hooks[event].length < before) {
      ok(`Removed ${event} hook from settings`);
      changed = true;
    }
  }

  if (changed) {
    writeSettings(settingsFile, settings);
  }
}

// ── Install / Uninstall ──────────────────────────────────────

function install() {
  console.log('');
  console.log('git-session -- installing');
  console.log('-'.repeat(40));

  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`\n  ${name}:`);

    ensureDir(target.hooksDir);

    for (const file of HOOK_FILES) {
      const src  = path.join(PACKAGE_DIR, file);
      const dest = path.join(target.hooksDir, file);
      symlink(src, dest);
    }

    if (target.settingsFile && target.hookEntries) {
      addHookEntries(target.settingsFile, target.hookEntries);
    }
  }

  console.log('');
  console.log('-'.repeat(40));
  console.log('  Done. Restart Claude Code to activate.');
  console.log('');
}

function uninstall() {
  console.log('');
  console.log('git-session -- uninstalling');
  console.log('-'.repeat(40));

  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`\n  ${name}:`);

    for (const file of HOOK_FILES) {
      const dest = path.join(target.hooksDir, file);
      removeSymlink(dest);
    }

    if (target.settingsFile && target.hookEntries) {
      removeHookEntries(target.settingsFile, target.hookEntries);
    }
  }

  console.log('');
  console.log('-'.repeat(40));
  console.log('  Done. Hooks removed.');
  console.log('');
}

// ── CLI ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--uninstall') || args.includes('-u')) {
  uninstall();
} else if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node install.js [--uninstall]');
} else {
  install();
}
