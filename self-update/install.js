#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall the self-update hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # symlink + wire SessionStart
//    node install.js --no-wire    # symlink only
//    node install.js --uninstall  # remove symlink + settings entry
//    node install.js --hours N    # throttle window (default 24)
//
//  The hook is NOTIFY-ONLY: it fetches (read-only) and, when a configured
//  repo is behind, prints a prompt asking the user whether to update. It
//  never merges on its own. Repos live in repos.json beside this file.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['self-update.js'];
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const HOOKS_DIR = path.join(HOME, '.claude', 'hooks');

const ENTRIES = [
    {
        event: 'SessionStart',
        entry: {
            hooks: [{ type: 'command', command: 'node ~/.claude/hooks/self-update.js --session-start', timeout: 60 }],
        },
    },
];

const ok = (m) => console.log(`  ✓  ${m}`);
const skip = (m) => console.log(`  ·  ${m}`);
const warn = (m) => console.log(`  ⚠  ${m}`);

function ensureDir(d) { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); ok(`Created ${d}`); } }
function symlink(src, dest) { try { fs.unlinkSync(dest); } catch {} fs.symlinkSync(src, dest); ok(`${path.basename(dest)}  →  ${src}`); }
function removeSymlink(dest) {
    try {
        if (fs.lstatSync(dest).isSymbolicLink()) { fs.unlinkSync(dest); ok(`Removed ${path.basename(dest)}`); }
        else warn(`${path.basename(dest)} is not a symlink — skipped`);
    } catch { skip(`${path.basename(dest)} not found`); }
}

function readSettings() { return fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {}; }
function writeSettings(o) {
    // Cheap insurance against a lost read-modify-write race on a file that
    // holds every plugin + preference. Not a lock; a recovery point.
    try {
        if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.bak');
    } catch { /* best effort */ }
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
    fs.renameSync(tmp, SETTINGS_FILE);
}

function addEntries(hours) {
    const s = readSettings();
    s.hooks = s.hooks || {};
    let changed = false;
    for (const { event, entry } of ENTRIES) {
        s.hooks[event] = s.hooks[event] || [];
        const cmd = entry.hooks[0].command;
        if (s.hooks[event].some((e) => e.hooks && e.hooks.some((h) => h.command === cmd))) { skip(`${event} already wired`); continue; }
        s.hooks[event].push(entry); ok(`Wired ${event}`); changed = true;
    }
    if (hours != null) {
        s.env = s.env || {};
        if (s.env.SELF_UPDATE_EVERY_HOURS !== String(hours)) { s.env.SELF_UPDATE_EVERY_HOURS = String(hours); ok(`Set SELF_UPDATE_EVERY_HOURS=${hours}`); changed = true; }
    }
    if (changed) writeSettings(s); else skip('settings.json unchanged');
}

function removeEntries() {
    if (!fs.existsSync(SETTINGS_FILE)) { skip('settings.json not found'); return; }
    const s = readSettings();
    let changed = false;
    for (const { event, entry } of ENTRIES) {
        const arr = s.hooks?.[event]; if (!arr) continue;
        const cmd = entry.hooks[0].command, before = arr.length;
        s.hooks[event] = arr.filter((e) => !(e.hooks && e.hooks.some((h) => h.command === cmd)));
        if (s.hooks[event].length !== before) { ok(`Unwired ${event}`); changed = true; }
    }
    if (s.env && 'SELF_UPDATE_EVERY_HOURS' in s.env) { delete s.env.SELF_UPDATE_EVERY_HOURS; ok('Removed SELF_UPDATE_EVERY_HOURS'); changed = true; }
    if (changed) writeSettings(s); else skip('nothing wired');
}

function install(wire, hours) {
    console.log('\nself-update — installing' + (wire ? ' (+ wiring)' : ' (symlink only)'));
    console.log('─'.repeat(52));
    ensureDir(HOOKS_DIR);
    for (const f of HOOK_FILES) symlink(path.join(PACKAGE_DIR, f), path.join(HOOKS_DIR, f));
    if (wire) addEntries(hours); else skip('settings.json not modified');
    console.log('─'.repeat(52));
    console.log('  Done. Restart Claude Code to activate.');
    console.log(`  Repos:  ${path.join(PACKAGE_DIR, 'repos.json')}`);
    console.log('  Mode:   NOTIFY ONLY — prompts, never merges on its own.');
    console.log('  Manual: node self-update.js --check   /   --apply --now\n');
}

function uninstall() {
    console.log('\nself-update — uninstalling');
    console.log('─'.repeat(52));
    for (const f of HOOK_FILES) removeSymlink(path.join(HOOKS_DIR, f));
    removeEntries();
    console.log('─'.repeat(52));
    console.log('  Done.\n');
}

const args = process.argv.slice(2);
const hi = args.indexOf('--hours');
const hours = hi !== -1 ? parseFloat(args[hi + 1]) : null;
if (hours !== null && (!Number.isFinite(hours) || hours < 0)) { console.error('--hours requires a non-negative number'); process.exit(1); }

if (args.includes('--uninstall') || args.includes('-u')) uninstall();
else if (args.includes('--help') || args.includes('-h')) console.log('Usage: node install.js [--no-wire] [--hours N] [--uninstall]');
else install(!args.includes('--no-wire'), hours);
