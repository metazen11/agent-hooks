#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall env-guard hooks
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # install (symlinks + settings)
//    node install.js --uninstall  # remove symlinks + settings entry
//
//  Cross-platform: macOS, Linux, Windows (Node.js only, no bash)
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ───────────────────────────────────────────────────

const PACKAGE_DIR = __dirname;
const HOME        = os.homedir();

const HOOK_FILES = ['env-guard.js', 'env-write.js'];

// Agent targets — add new agents here
const TARGETS = {
  claude: {
    hooksDir:     path.join(HOME, '.claude', 'hooks'),
    settingsFile: path.join(HOME, '.claude', 'settings.json'),
    // The hook entry to inject into settings.json → hooks.PreToolUse[]
    hookEntry: {
      matcher: 'Read|Edit',
      hooks: [{
        type: 'command',
        command: 'node ~/.claude/hooks/env-guard.js',
        timeout: 10,
      }],
    },
  },
  // Future agents:
  // cursor: { hooksDir: ..., settingsFile: ... },
};

// ── Helpers ──────────────────────────────────────────────────

const LOG_PREFIX = '  ';
const ok   = (msg) => console.log(`${LOG_PREFIX}✓  ${msg}`);
const skip = (msg) => console.log(`${LOG_PREFIX}·  ${msg}`);
const warn = (msg) => console.log(`${LOG_PREFIX}⚠  ${msg}`);
const err  = (msg) => console.error(`${LOG_PREFIX}✗  ${msg}`);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ok(`Created ${dir}`);
  }
}

function symlink(src, dest) {
  // Remove existing (file, symlink, or broken link)
  try { fs.unlinkSync(dest); } catch {}

  fs.symlinkSync(src, dest);
  ok(`${path.basename(dest)}  →  ${src}`);
}

function removeSymlink(dest) {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(dest);
      ok(`Removed ${path.basename(dest)}`);
    } else {
      warn(`${path.basename(dest)} is not a symlink — skipped`);
    }
  } catch {
    skip(`${path.basename(dest)} not found — nothing to remove`);
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

function addHookEntry(settingsFile, entry) {
  const settings = readSettings(settingsFile);

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  // Check if already installed (match by command string)
  const cmd = entry.hooks[0].command;
  const exists = settings.hooks.PreToolUse.some(
    (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
  );

  if (exists) {
    skip(`Hook already in ${path.basename(settingsFile)}`);
    return;
  }

  settings.hooks.PreToolUse.push(entry);
  writeSettings(settingsFile, settings);
  ok(`Added PreToolUse hook to ${path.basename(settingsFile)}`);
}

function removeHookEntry(settingsFile, entry) {
  if (!fs.existsSync(settingsFile)) {
    skip(`${path.basename(settingsFile)} not found`);
    return;
  }

  const settings = readSettings(settingsFile);
  const arr = settings.hooks?.PreToolUse;
  if (!arr) { skip('No PreToolUse hooks to remove'); return; }

  const cmd = entry.hooks[0].command;
  const before = arr.length;
  settings.hooks.PreToolUse = arr.filter(
    (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
  );

  if (settings.hooks.PreToolUse.length === before) {
    skip(`Hook not found in ${path.basename(settingsFile)}`);
    return;
  }

  writeSettings(settingsFile, settings);
  ok(`Removed hook from ${path.basename(settingsFile)}`);
}

// ── Install / Uninstall ──────────────────────────────────────

function install() {
  console.log('');
  console.log('env-guard — installing');
  console.log('─'.repeat(40));

  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`\n  ${name}:`);

    ensureDir(target.hooksDir);

    // Symlink hook files
    for (const file of HOOK_FILES) {
      const src  = path.join(PACKAGE_DIR, file);
      const dest = path.join(target.hooksDir, file);
      symlink(src, dest);
    }

    // Patch settings
    if (target.settingsFile && target.hookEntry) {
      addHookEntry(target.settingsFile, target.hookEntry);
    }
  }

  console.log('');
  console.log('─'.repeat(40));
  console.log('  Done. Restart Claude Code to activate.');
  console.log('');
}

function uninstall() {
  console.log('');
  console.log('env-guard — uninstalling');
  console.log('─'.repeat(40));

  for (const [name, target] of Object.entries(TARGETS)) {
    console.log(`\n  ${name}:`);

    // Remove symlinks
    for (const file of HOOK_FILES) {
      const dest = path.join(target.hooksDir, file);
      removeSymlink(dest);
    }

    // Remove settings entry
    if (target.settingsFile && target.hookEntry) {
      removeHookEntry(target.settingsFile, target.hookEntry);
    }
  }

  console.log('');
  console.log('─'.repeat(40));
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
