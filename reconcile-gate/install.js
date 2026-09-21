#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall reconcile-gate hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # install (symlink + settings)
//    node install.js --uninstall  # remove symlink + settings entry
//
//  Symlinks reconcile-gate.js into ~/.claude/hooks/ and adds a
//  PreToolUse(Bash) entry to ~/.claude/settings.json. After install,
//  every Bash tool call is screened — `gh pr create` invocations are
//  refused unless they target integration-trunk → production-trunk
//  (--base main --head dev or aliases). Bypass with --force-anyway.
//
//  See reconcile-gate.js for the full enforcement contract.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config ───────────────────────────────────────────────────

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();

const HOOK_FILES = ['reconcile-gate.js'];

const TARGETS = {
    claude: {
        hooksDir: path.join(HOME, '.claude', 'hooks'),
        settingsFile: path.join(HOME, '.claude', 'settings.json'),
        // PreToolUse entry — fires on every Bash tool call. The hook itself
        // fast-paths everything that isn't a `gh pr create` invocation, so
        // overhead on unrelated calls is negligible.
        hookEntry: {
            matcher: 'Bash',
            hooks: [
                {
                    type: 'command',
                    command: 'node ~/.claude/hooks/reconcile-gate.js',
                    timeout: 5,
                },
            ],
        },
    },
};

// ── Helpers (copied from env-guard/install.js for consistency) ──

const LOG_PREFIX = '  ';
const ok = (msg) => console.log(`${LOG_PREFIX}✓  ${msg}`);
const skip = (msg) => console.log(`${LOG_PREFIX}·  ${msg}`);
const warn = (msg) => console.log(`${LOG_PREFIX}⚠  ${msg}`);

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

// ── Settings patching (atomic write, idempotent) ──

function readSettings(file) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSettings(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
}

function addHookEntry(settingsFile, entry) {
    const settings = readSettings(settingsFile);
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

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
    ok(`Added PreToolUse(Bash) hook to ${path.basename(settingsFile)}`);
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

// ── Install / Uninstall ──

function install() {
    console.log('');
    console.log('reconcile-gate — installing');
    console.log('─'.repeat(40));
    for (const [name, target] of Object.entries(TARGETS)) {
        console.log(`\n  ${name}:`);
        ensureDir(target.hooksDir);
        for (const file of HOOK_FILES) {
            const src = path.join(PACKAGE_DIR, file);
            const dest = path.join(target.hooksDir, file);
            symlink(src, dest);
        }
        if (target.settingsFile && target.hookEntry) {
            addHookEntry(target.settingsFile, target.hookEntry);
        }
    }
    console.log('');
    console.log('─'.repeat(40));
    console.log('  Done. Restart Claude Code to activate.');
    console.log('  The hook will refuse `gh pr create` calls whose --base is');
    console.log('  not main/master AND --head is not dev/develop. Override with');
    console.log('  --force-anyway when intentional (the flag is logged).');
    console.log('');
}

function uninstall() {
    console.log('');
    console.log('reconcile-gate — uninstalling');
    console.log('─'.repeat(40));
    for (const [name, target] of Object.entries(TARGETS)) {
        console.log(`\n  ${name}:`);
        for (const file of HOOK_FILES) {
            const dest = path.join(target.hooksDir, file);
            removeSymlink(dest);
        }
        if (target.settingsFile && target.hookEntry) {
            removeHookEntry(target.settingsFile, target.hookEntry);
        }
    }
    console.log('');
    console.log('─'.repeat(40));
    console.log('  Done. Hook removed.');
    console.log('');
}

// ── CLI ──

const args = process.argv.slice(2);

if (args.includes('--uninstall') || args.includes('-u')) {
    uninstall();
} else if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node install.js [--uninstall]');
} else {
    install();
}
