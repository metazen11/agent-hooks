#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall context-primer hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # install (symlink + settings)
//    node install.js --uninstall  # remove symlink + settings entries
//
//  Symlinks context-primer.js into ~/.claude/hooks/ and adds THREE entries to
//  ~/.claude/settings.json:
//    • SessionStart     → injects required instruction files at session start
//    • UserPromptSubmit → re-injects them every 50 user turns (drift guard)
//    • PreToolUse(Edit|Write|NotebookEdit|Bash) → one-time safety net that fires
//      only if a work session never got the SessionStart injection
//
//  See context-primer.js for the full contract.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['context-primer.js'];

const TARGETS = {
    claude: {
        hooksDir: path.join(HOME, '.claude', 'hooks'),
        settingsFile: path.join(HOME, '.claude', 'settings.json'),
        entries: [
            {
                event: 'SessionStart',
                entry: {
                    hooks: [
                        {
                            type: 'command',
                            command: 'node ~/.claude/hooks/context-primer.js --session-start',
                            timeout: 15,
                        },
                    ],
                },
            },
            {
                event: 'UserPromptSubmit',
                entry: {
                    hooks: [
                        {
                            type: 'command',
                            command: 'node ~/.claude/hooks/context-primer.js --user-prompt',
                            timeout: 10,
                        },
                    ],
                },
            },
            {
                event: 'PreToolUse',
                entry: {
                    matcher: 'Edit|Write|NotebookEdit|Bash',
                    hooks: [
                        {
                            type: 'command',
                            command: 'node ~/.claude/hooks/context-primer.js',
                            timeout: 10,
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
    console.log('context-primer — installing');
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
    console.log('  • SessionStart injects project + global instruction files.');
    console.log('  • Every 50 user turns they are re-injected (drift guard).');
    console.log('  • Edit/Write/Bash gate is a one-time safety net only —');
    console.log('    it stays silent once SessionStart has primed the session.');
    console.log('');
}

function uninstall() {
    console.log('');
    console.log('context-primer — uninstalling');
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
