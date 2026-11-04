#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js — Install/uninstall worktree-cap for Claude, Codex, Anvil
// ─────────────────────────────────────────────────────────────
//   node install.js                       # symlink only (available, INACTIVE)
//   node install.js --wire                # + Claude settings: PreToolUse, SessionStart, Stop
//   node install.js --codex               # + Codex exec-policy rule forbidding direct `git worktree add`
//   node install.js --anvil <projectDir>  # + marker block in <projectDir>/.anvil/CONTRACTS.md (advisory)
//   node install.js --uninstall           # reverse all of the above that are present
//
// Strict-block gate => wiring is an explicit operator decision (like dispatch-gate).
// Honors $HOME so tests can run against a scratch home.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_DIR = __dirname;
const HOME = os.homedir();
const HOOK_FILES = ['lib.js', 'cli.js', 'worktree-cap.js', 'unlanded-report.js', 'landing-ready.js', 'parse-git.js'];
const HOOKS_DIR = path.join(HOME, '.claude', 'hooks');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CODEX_RULES = path.join(HOME, '.codex', 'rules', 'default.rules');
const CLI = path.join(PACKAGE_DIR, 'cli.js');

const CLAUDE_ENTRIES = [
    ['PreToolUse', { matcher: 'Bash|Agent|Task', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/worktree-cap.js', timeout: 10 }] }],
    ['SessionStart', { hooks: [{ type: 'command', command: 'node ~/.claude/hooks/unlanded-report.js', timeout: 15 }] }],
    ['Stop', { hooks: [{ type: 'command', command: 'node ~/.claude/hooks/unlanded-report.js', timeout: 15 }] }],
];

const START = (n) => `# worktree-cap-start (${n})`;
const END = (n) => `# worktree-cap-end (${n})`;
const JUST = `worktree-cap: use 'node ${CLI} add <repo> <path> -b <branch>' (refuses at the unlanded-worktree cap)`;
// Prefix rules can only match a fixed argv prefix, so forms with a free-form value before
// `worktree` (`git -C <dir>`, `-c k=v`) cannot be expressed; those stay covered by the Claude hook only.
const CODEX_RULE = [
    ['git', 'worktree', 'add'],
    ['git', '--no-pager', 'worktree', 'add'],
    ['git', '-p', 'worktree', 'add'],
    ['git', '--bare', 'worktree', 'add'],
    ['git', '--no-replace-objects', 'worktree', 'add'],
].map((pat) => `prefix_rule(pattern=${JSON.stringify(pat)}, decision="forbidden", justification=${JSON.stringify(JUST)})`).join('\n');
const AGENT_TEXT = `## Worktree cap (worktree-cap)

Before \`git worktree add\`, run \`node ${CLI} check <repo>\` (exit 2 = at cap: land with /reconcile or delete a worktree first), or create worktrees only via \`node ${CLI} add <repo> <path> -b <branch>\`. At session start run \`node ${CLI} report <dir>\`. After independent review+audit PASS run \`node ${path.join(PACKAGE_DIR, 'landing-ready.js')} <worktree>\`; before stopping run \`node ${CLI} stop <dir>\` (exit 2 = reviewed work not landed; land it or write <worktree>/.landing-hold with a reason).`;

const log = (m) => console.log(`  ${m}`);

function patchBlock(file, name, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.includes(START(name))) {
        if (cur.includes(body)) { log(`· ${name} block already in ${file}`); return; }
        stripBlock(file, name); // body changed since last install: refresh
        return patchBlock(file, name, body);
    }
    fs.writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${START(name)}\n${body}\n${END(name)}\n`);
    log(`✓ ${name} block added to ${file}`);
}

function stripBlock(file, name) {
    if (!fs.existsSync(file)) return;
    const cur = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`${START(name).replace(/[()]/g, '\\$&')}[\\s\\S]*?${END(name).replace(/[()]/g, '\\$&')}\\n?`);
    if (!re.test(cur)) return;
    fs.writeFileSync(file, cur.replace(re, ''));
    log(`✓ ${name} block removed from ${file}`);
}

function readSettings() { return fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {}; }
function writeSettings(o) {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS + '.tmp', JSON.stringify(o, null, 2) + '\n');
    fs.renameSync(SETTINGS + '.tmp', SETTINGS);
}

function install(opts) {
    console.log('\nworktree-cap — installing');
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    for (const f of HOOK_FILES) {
        const dest = path.join(HOOKS_DIR, f);
        try { fs.unlinkSync(dest); } catch { /* absent */ }
        fs.symlinkSync(path.join(PACKAGE_DIR, f), dest);
        log(`✓ ${f} → ${path.join(PACKAGE_DIR, f)}`);
    }
    if (opts.wire) {
        const s = readSettings();
        s.hooks = s.hooks || {};
        for (const [event, entry] of CLAUDE_ENTRIES) {
            s.hooks[event] = s.hooks[event] || [];
            const cmd = entry.hooks[0].command;
            if (s.hooks[event].some((e) => (e.hooks || []).some((h) => h.command === cmd))) log(`· ${event} already wired`);
            else { s.hooks[event].push(entry); log(`✓ wired ${event}`); }
        }
        writeSettings(s);
    } else log('· settings.json untouched — pass --wire to enforce on Claude (operator decision)');
    if (opts.codex) patchBlock(CODEX_RULES, 'codex', CODEX_RULE);
    if (opts.project) patchBlock(path.join(opts.project, 'AGENTS.md'), 'codex-agents', AGENT_TEXT);
    if (opts.anvil) patchBlock(path.join(opts.anvil, '.anvil', 'CONTRACTS.md'), 'anvil', AGENT_TEXT);
    console.log('\n  Restart Claude Code to load hook changes.\n');
}

function uninstall(opts) {
    console.log('\nworktree-cap — uninstalling');
    for (const f of HOOK_FILES) { try { fs.unlinkSync(path.join(HOOKS_DIR, f)); log(`✓ removed ${f}`); } catch { /* absent */ } }
    if (fs.existsSync(SETTINGS)) {
        const s = readSettings();
        for (const [event, entry] of CLAUDE_ENTRIES) {
            const cmd = entry.hooks[0].command;
            if (s.hooks && s.hooks[event]) s.hooks[event] = s.hooks[event].filter((e) => !(e.hooks || []).some((h) => h.command === cmd));
        }
        writeSettings(s);
    }
    stripBlock(CODEX_RULES, 'codex');
    if (opts.project) stripBlock(path.join(opts.project, 'AGENTS.md'), 'codex-agents');
    if (opts.anvil) stripBlock(path.join(opts.anvil, '.anvil', 'CONTRACTS.md'), 'anvil');
}

const a = process.argv.slice(2);
const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? path.resolve(a[i + 1] || '.') : null; };
const opts = { wire: a.includes('--wire'), codex: a.includes('--codex'), anvil: val('--anvil'), project: val('--project') };
if (a.includes('--help') || a.includes('-h')) console.log('Usage: node install.js [--wire] [--codex [--project DIR]] [--anvil DIR] [--uninstall]');
else if (a.includes('--uninstall') || a.includes('-u')) uninstall(opts);
else install(opts);
