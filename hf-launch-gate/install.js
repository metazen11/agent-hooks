#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js  —  Install/uninstall hf-launch-gate hook
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js              # symlink only (available, NOT wired)
//    node install.js --wire       # symlink + wire PreToolUse(Bash) entry
//    node install.js --uninstall  # remove symlink + any settings entry
//
//  hf-launch-gate REFUSES a paid Hugging Face Jobs launch (`hf jobs run`,
//  `hf jobs uv run`, or a launcher script invoked WITH `--launch`) unless
//  process preconditions are met: an approved originating GitHub issue with
//  acceptance criteria + a recorded auditor PASS (AC6 on
//  metazen11/agent-memory#55). Override with --force-anyway or
//  HF_LAUNCH_APPROVED=<issue#>. Dry-runs and read-only `hf jobs`
//  subcommands are NOT blocked.
//
//  By default this installer ONLY symlinks the hook — it does NOT touch
//  settings.json. Wiring a strict-block gate is an operator decision, and
//  by policy agents cannot modify settings.json without explicit approval
//  (and to avoid changing hook behavior mid-session). Pass --wire to add
//  the PreToolUse(Bash) entry, then restart Claude Code.
//
//  See hf-launch-gate.js / README.md for the full enforcement contract.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['hf-launch-gate.js'];

const TARGETS = {
    claude: {
        hooksDir: path.join(HOME, '.claude', 'hooks'),
        settingsFile: path.join(HOME, '.claude', 'settings.json'),
        entries: [
            {
                event: 'PreToolUse',
                entry: {
                    matcher: 'Bash',
                    hooks: [
                        {
                            type: 'command',
                            command: 'node ~/.claude/hooks/hf-launch-gate.js',
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

function install(wire) {
    console.log('');
    console.log(`hf-launch-gate — installing${wire ? ' (+ wiring)' : ' (symlink only)'}`);
    console.log('─'.repeat(40));
    for (const [name, target] of Object.entries(TARGETS)) {
        console.log(`\n  ${name}:`);
        ensureDir(target.hooksDir);
        for (const file of HOOK_FILES) {
            symlink(path.join(PACKAGE_DIR, file), path.join(target.hooksDir, file));
        }
        if (wire) {
            for (const { event, entry } of target.entries) {
                addHookEntry(target.settingsFile, event, entry);
            }
        } else {
            skip('settings.json not modified — pass --wire to enforce (operator decision)');
        }
    }
    console.log('');
    console.log('─'.repeat(40));
    console.log('  Done. Restart Claude Code to activate.');
    if (wire) {
        console.log('  The hook will REFUSE `hf jobs run`, `hf jobs uv run`, and');
        console.log('  launcher scripts run WITH --launch, unless authorized via');
        console.log('  --force-anyway or HF_LAUNCH_APPROVED=<issue#> (both logged).');
        console.log('  Dry-runs and `hf jobs logs|inspect|ls|ps|cancel` pass through.');
    } else {
        console.log('  Hook is available but INACTIVE. Re-run with --wire to enforce');
        console.log('  the paid-launch gate (PreToolUse matcher "Bash").');
    }
    console.log('');
}

function uninstall() {
    console.log('');
    console.log('hf-launch-gate — uninstalling');
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
    console.log('Usage: node install.js [--wire] [--uninstall]');
} else {
    install(args.includes('--wire'));
}
