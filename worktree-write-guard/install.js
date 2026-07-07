#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall worktree-write-guard hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # install (symlink + settings)
//    node install.js --uninstall  # remove symlink + settings entry
//
//  Symlinks worktree-write-guard.js into ~/.claude/hooks/ and adds a
//  PreToolUse(Edit|Write|NotebookEdit|Bash) entry to
//  ~/.claude/settings.json. After install, a sub-agent dispatched into a
//  git worktree is blocked from writing to the MAIN worktree (or running
//  destructive Bash against paths outside its own worktree).
//
//  See worktree-write-guard.js for the enforcement contract and the
//  incident it prevents.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['worktree-write-guard.js'];

const TARGETS = {
    claude: {
        hooksDir: path.join(HOME, '.claude', 'hooks'),
        settingsFile: path.join(HOME, '.claude', 'settings.json'),
        entries: [
            {
                event: 'PreToolUse',
                entry: {
                    matcher: 'Edit|Write|NotebookEdit|Bash',
                    hooks: [
                        {
                            type: 'command',
                            command: 'node ~/.claude/hooks/worktree-write-guard.js',
                            timeout: 5,
                        },
                    ],
                },
            },
        ],
    },
};

// ── Logging ──────────────────────────────────────────────────

const LOG_PREFIX = '  ';
const ok = (msg) => console.log(`${LOG_PREFIX}✓  ${msg}`);
const skip = (msg) => console.log(`${LOG_PREFIX}·  ${msg}`);
const warn = (msg) => console.log(`${LOG_PREFIX}⚠  ${msg}`);

// ── FS helpers ───────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        ok(`Created ${dir}`);
    }
}

function symlink(src, dest) {
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

// ── Settings patching (atomic write, idempotent) ─────────────

function readSettings(file) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSettings(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

function addHookEntry(settingsFile, event, entry) {
    const settings = readSettings(settingsFile);
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const cmd = entry.hooks[0].command;
    const exists = settings.hooks[event].some(
        (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
    );
    if (exists) {
        skip(`${event} hook already in ${path.basename(settingsFile)}`);
        return;
    }
    settings.hooks[event].push(entry);
    writeSettings(settingsFile, settings);
    ok(`Added ${event} hook to ${path.basename(settingsFile)}`);
}

function removeHookEntry(settingsFile, event, entry) {
    if (!fs.existsSync(settingsFile)) {
        skip(`${path.basename(settingsFile)} not found`);
        return;
    }
    const settings = readSettings(settingsFile);
    const arr = settings.hooks?.[event];
    if (!arr) { skip(`No ${event} hooks to remove`); return; }

    const cmd = entry.hooks[0].command;
    const before = arr.length;
    settings.hooks[event] = arr.filter(
        (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
    );
    if (settings.hooks[event].length === before) {
        skip(`${event} hook not found in ${path.basename(settingsFile)}`);
        return;
    }
    writeSettings(settingsFile, settings);
    ok(`Removed ${event} hook from ${path.basename(settingsFile)}`);
}

// ── Install / Uninstall ──────────────────────────────────────

function install() {
    console.log('');
    console.log('worktree-write-guard — installing');
    console.log('─'.repeat(40));
    for (const [name, target] of Object.entries(TARGETS)) {
        console.log(`\n  ${name}:`);
        ensureDir(target.hooksDir);
        for (const file of HOOK_FILES) {
            symlink(path.join(PACKAGE_DIR, file), path.join(target.hooksDir, file));
        }
        for (const { event, entry } of target.entries) {
            addHookEntry(target.settingsFile, event, entry);
        }
    }
    console.log('');
    console.log('─'.repeat(40));
    console.log('  Done. Restart Claude Code to activate.');
    console.log('  Worktree-dispatched agents can no longer write the main tree.');
    console.log('');
}

function uninstall() {
    console.log('');
    console.log('worktree-write-guard — uninstalling');
    console.log('─'.repeat(40));
    for (const [name, target] of Object.entries(TARGETS)) {
        console.log(`\n  ${name}:`);
        for (const file of HOOK_FILES) {
            removeSymlink(path.join(target.hooksDir, file));
        }
        for (const { event, entry } of target.entries) {
            removeHookEntry(target.settingsFile, event, entry);
        }
    }
    console.log('');
    console.log('─'.repeat(40));
    console.log('  Done. Hook removed.');
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
