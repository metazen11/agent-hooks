#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall the iron-rules hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # symlink + wire (default: it is a reminder)
//    node install.js --no-wire    # symlink only, do not touch settings.json
//    node install.js --uninstall  # remove symlink + settings entries
//    node install.js --every N    # set cadence (writes env.IRON_RULES_EVERY)
//
//  Unlike the strict-block gates (hf-launch-gate, reconcile-gate), iron-rules
//  only APPENDS context — it can never block a tool call or fail a turn. So
//  wiring is the default here rather than an opt-in; --no-wire is available
//  for operators who want to review settings.json first.
//
//  Wires two entries:
//    SessionStart      → inject once at session start
//    UserPromptSubmit  → inject every IRON_RULES_EVERY turns (default 10)
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['iron-rules.js'];

const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const HOOKS_DIR = path.join(HOME, '.claude', 'hooks');

const ENTRIES = [
    {
        event: 'SessionStart',
        entry: {
            hooks: [{ type: 'command', command: 'node ~/.claude/hooks/iron-rules.js --session-start', timeout: 5 }],
        },
    },
    {
        event: 'UserPromptSubmit',
        entry: {
            hooks: [{ type: 'command', command: 'node ~/.claude/hooks/iron-rules.js --user-prompt', timeout: 5 }],
        },
    },
];

// ── Logging ──────────────────────────────────────────────────

const ok = (m) => console.log(`  ✓  ${m}`);
const skip = (m) => console.log(`  ·  ${m}`);
const warn = (m) => console.log(`  ⚠  ${m}`);

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
        if (fs.lstatSync(dest).isSymbolicLink()) {
            fs.unlinkSync(dest);
            ok(`Removed ${path.basename(dest)}`);
        } else {
            warn(`${path.basename(dest)} is not a symlink — skipped`);
        }
    } catch {
        skip(`${path.basename(dest)} not found`);
    }
}

// ── Settings patching (atomic, idempotent) ───────────────────

function readSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function writeSettings(obj) {
    // Cheap insurance against a lost read-modify-write race on a file that
    // holds every plugin + preference. Not a lock; a recovery point.
    try {
        if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.bak');
    } catch { /* best effort */ }
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8'));   // re-parse before swap
    fs.renameSync(tmp, SETTINGS_FILE);
}

/** Does this hook group reference our script at all (any flags, any variant)? */
function isOurs(group) {
    return !!group.hooks && group.hooks.some((h) => (h.command || '').includes('iron-rules.js'));
}

function addEntries(every) {
    const s = readSettings();
    s.hooks = s.hooks || {};
    let changed = false;

    for (const { event, entry } of ENTRIES) {
        s.hooks[event] = s.hooks[event] || [];
        const cmd = entry.hooks[0].command;

        // Exact match: already correct, leave it.
        if (s.hooks[event].some((e) => e.hooks && e.hooks.some((h) => h.command === cmd))) {
            // A DIFFERENT variant may still be lurking beside it — drop those.
            const before = s.hooks[event].length;
            s.hooks[event] = s.hooks[event].filter(
                (e) => !isOurs(e) || e.hooks.some((h) => h.command === cmd)
            );
            if (s.hooks[event].length !== before) {
                warn(`${event}: removed ${before - s.hooks[event].length} stale iron-rules entry(s)`);
                changed = true;
            } else {
                skip(`${event} already wired`);
            }
            continue;
        }

        // A drifted variant (older install, missing flag) — replace it.
        const stale = s.hooks[event].filter(isOurs).length;
        if (stale > 0) {
            s.hooks[event] = s.hooks[event].filter((e) => !isOurs(e));
            warn(`${event}: replaced ${stale} stale iron-rules entry(s)`);
        }
        s.hooks[event].push(entry);
        ok(`Wired ${event}`);
        changed = true;
    }

    if (every) {
        s.env = s.env || {};
        if (s.env.IRON_RULES_EVERY !== String(every)) {
            s.env.IRON_RULES_EVERY = String(every);
            ok(`Set IRON_RULES_EVERY=${every}`);
            changed = true;
        }
        // Record provenance so --uninstall knows this value is ours to remove.
        s.env.IRON_RULES_EVERY_SETBY = 'iron-rules-installer';
    }

    if (changed) writeSettings(s);
    else skip('settings.json unchanged');
}

function removeEntries() {
    if (!fs.existsSync(SETTINGS_FILE)) { skip('settings.json not found'); return; }
    const s = readSettings();
    let changed = false;

    for (const { event, entry } of ENTRIES) {
        const arr = s.hooks?.[event];
        if (!arr) continue;
        const cmd = entry.hooks[0].command;
        const before = arr.length;
        s.hooks[event] = arr.filter((e) => !(e.hooks && e.hooks.some((h) => h.command === cmd)));
        if (s.hooks[event].length !== before) { ok(`Unwired ${event}`); changed = true; }
    }
    // Only remove the cadence if WE set it — never revert an operator's own value.
    if (s.env && s.env.IRON_RULES_EVERY_SETBY === 'iron-rules-installer') {
        delete s.env.IRON_RULES_EVERY;
        delete s.env.IRON_RULES_EVERY_SETBY;
        ok('Removed IRON_RULES_EVERY (set by this installer)');
        changed = true;
    } else if (s.env && 'IRON_RULES_EVERY' in s.env) {
        skip('IRON_RULES_EVERY left in place (not set by this installer)');
    }

    if (changed) writeSettings(s);
    else skip('nothing wired');
}

// ── Install / Uninstall ──────────────────────────────────────

function install(wire, every) {
    console.log('\niron-rules — installing' + (wire ? ' (+ wiring)' : ' (symlink only)'));
    console.log('─'.repeat(52));
    ensureDir(HOOKS_DIR);
    for (const f of HOOK_FILES) {
        symlink(path.join(PACKAGE_DIR, f), path.join(HOOKS_DIR, f));
    }
    if (wire) addEntries(every);
    else skip('settings.json not modified — pass without --no-wire to enable');

    console.log('─'.repeat(52));
    console.log('  Done. Restart Claude Code to activate.');
    console.log(`  Rules text: ${path.join(PACKAGE_DIR, 'IRON-RULES.md')}`);
    console.log(`  Cadence:    every ${every || process.env.IRON_RULES_EVERY || 10} user turns\n`);
}

function uninstall() {
    console.log('\niron-rules — uninstalling');
    console.log('─'.repeat(52));
    for (const f of HOOK_FILES) removeSymlink(path.join(HOOKS_DIR, f));
    removeEntries();
    console.log('─'.repeat(52));
    console.log('  Done.\n');
}

// ── CLI ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const everyIdx = args.indexOf('--every');
const every = everyIdx !== -1 ? parseInt(args[everyIdx + 1], 10) : null;

if (every !== null && (!Number.isFinite(every) || every < 1)) {
    console.error('--every requires a positive integer');
    process.exit(1);
}

if (args.includes('--uninstall') || args.includes('-u')) uninstall();
else if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node install.js [--no-wire] [--every N] [--uninstall]');
} else install(!args.includes('--no-wire'), every);
