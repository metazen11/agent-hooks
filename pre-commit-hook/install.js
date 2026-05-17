#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js — Multi-agent pre-commit hook installer
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js                          # Interactive wizard
//    node install.js --agent=claude,git       # Non-interactive
//    node install.js --all                    # All detected agents
//    node install.js --uninstall              # Remove all
//    node install.js --project=/path/to/repo  # Target project
//    node install.js --help
//
// ─────────────────────────────────────────────────────────────

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

// ── Config ──────────────────────────────────────────────────

const PACKAGE_DIR       = __dirname;
const HOME              = os.homedir();
const PRE_COMMIT_SCRIPT = path.resolve(PACKAGE_DIR, '..', 'pre-commit');
const MARKER_START      = '<!-- pre-commit-hook-start -->';
const MARKER_END        = '<!-- pre-commit-hook-end -->';

const AGENTS = ['git', 'claude', 'codex', 'gemini', 'anvil'];

// ── Helpers ─────────────────────────────────────────────────

const ok   = (msg) => console.log(`  \x1b[32m+\x1b[0m  ${msg}`);
const skip = (msg) => console.log(`  \x1b[90m.\x1b[0m  ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m  ${msg}`);
const err  = (msg) => console.error(`  \x1b[31mx\x1b[0m  ${msg}`);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ok(`Created ${dir}`);
  }
}

function symlinkFile(src, dest) {
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
      warn(`${path.basename(dest)} is not a symlink — skipped`);
    }
  } catch {
    skip(`${path.basename(dest)} not found`);
  }
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return null; // Don't backup our own symlinks
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.pre-commit-backup-${ts}`;
  fs.copyFileSync(filePath, backup);
  warn(`Backed up existing ${path.basename(filePath)} to ${path.basename(backup)}`);
  return backup;
}

// ── Settings.json patching (Claude Code) ────────────────────

function readJSON(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(`Failed to parse ${file}: ${e.message}`);
    process.exit(1);
  }
}

function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function addClaudeHook(settingsFile) {
  const settings = readJSON(settingsFile);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const cmd = 'node ~/.claude/hooks/pre-commit-wrapper.js';
  const exists = settings.hooks.PreToolUse.some(
    (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
  );

  if (exists) {
    skip('PreToolUse hook already in settings.json');
    return;
  }

  settings.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: cmd, timeout: 60 }],
  });

  writeJSONAtomic(settingsFile, settings);
  ok('Added PreToolUse hook to settings.json');
}

function removeClaudeHook(settingsFile) {
  if (!fs.existsSync(settingsFile)) { skip('settings.json not found'); return; }

  const settings = readJSON(settingsFile);
  const arr = settings.hooks?.PreToolUse;
  if (!arr) { skip('No PreToolUse hooks to remove'); return; }

  const cmd = 'node ~/.claude/hooks/pre-commit-wrapper.js';
  const before = arr.length;
  settings.hooks.PreToolUse = arr.filter(
    (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
  );

  if (settings.hooks.PreToolUse.length === before) {
    skip('Hook not found in settings.json');
    return;
  }

  writeJSONAtomic(settingsFile, settings);
  ok('Removed PreToolUse hook from settings.json');
}

// ── Marker-based file patching (Codex/Gemini/Anvil) ─────────

function appendMarkerBlock(filePath, content) {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }

  if (existing.includes(MARKER_START)) {
    skip(`Marker block already exists in ${path.basename(filePath)}`);
    return;
  }

  const block = '\n' + content.trim() + '\n';
  fs.writeFileSync(filePath, existing + block, 'utf8');
  ok(`Appended instruction block to ${path.basename(filePath)}`);
}

function removeMarkerBlock(filePath) {
  if (!fs.existsSync(filePath)) { skip(`${path.basename(filePath)} not found`); return; }

  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(MARKER_START)) {
    skip(`No marker block in ${path.basename(filePath)}`);
    return;
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (endIdx === -1) {
    warn(`Found start marker but no end marker in ${path.basename(filePath)} — skipping`);
    return;
  }

  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + MARKER_END.length).replace(/^\n+/, '');
  const result = before + (after ? '\n' + after : '') + '\n';

  fs.writeFileSync(filePath, result, 'utf8');
  ok(`Removed instruction block from ${path.basename(filePath)}`);
}

function loadTemplate(name) {
  const tplPath = path.join(PACKAGE_DIR, 'instructions', name);
  const tpl = fs.readFileSync(tplPath, 'utf8');
  return tpl.replace(/\{\{PRECOMMIT_PATH\}\}/g, PRE_COMMIT_SCRIPT);
}

// ── Agent Detection ─────────────────────────────────────────

function detectAgents(projectDir) {
  return {
    git:    fs.existsSync(path.join(projectDir, '.git')),
    claude: fs.existsSync(path.join(HOME, '.claude')),
    codex:  fs.existsSync(path.join(HOME, '.codex')),
    gemini: fs.existsSync(path.join(HOME, '.gemini')),
    anvil:  fs.existsSync(path.join(HOME, '.anvil')),
  };
}

// ── Per-Agent Installers ────────────────────────────────────

function installGit(projectDir) {
  console.log('\n  \x1b[36mgit:\x1b[0m');
  const hooksDir = path.join(projectDir, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    err('.git/hooks not found — is this a git repository?');
    return;
  }

  const dest = path.join(hooksDir, 'pre-commit');
  backupFile(dest);
  symlinkFile(PRE_COMMIT_SCRIPT, dest);
  try { fs.chmodSync(dest, 0o755); } catch {}
}

function uninstallGit(projectDir) {
  console.log('\n  \x1b[36mgit:\x1b[0m');
  const dest = path.join(projectDir, '.git', 'hooks', 'pre-commit');
  removeSymlink(dest);
}

function installClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  ensureDir(hooksDir);

  // Symlink wrapper
  const wrapperSrc = path.join(PACKAGE_DIR, 'pre-commit-wrapper.js');
  const wrapperDest = path.join(hooksDir, 'pre-commit-wrapper.js');
  symlinkFile(wrapperSrc, wrapperDest);

  // Symlink bash script (so wrapper can resolve it via __dirname/..)
  const scriptDest = path.join(hooksDir, 'pre-commit-check.sh');
  symlinkFile(PRE_COMMIT_SCRIPT, scriptDest);

  // Patch settings.json
  addClaudeHook(settingsFile);
}

function uninstallClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  removeSymlink(path.join(hooksDir, 'pre-commit-wrapper.js'));
  removeSymlink(path.join(hooksDir, 'pre-commit-check.sh'));
  removeClaudeHook(settingsFile);
}

function installCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  const target = path.join(projectDir, 'AGENTS.md');
  const content = loadTemplate('agents.md.tpl');
  appendMarkerBlock(target, content);
}

function uninstallCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'AGENTS.md'));
}

function installGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  const target = path.join(projectDir, 'GEMINI.md');
  const content = loadTemplate('gemini.md.tpl');
  appendMarkerBlock(target, content);
}

function uninstallGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'GEMINI.md'));
}

function installAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');
  const anvilDir = path.join(projectDir, '.anvil');
  ensureDir(anvilDir);
  const target = path.join(anvilDir, 'instructions.md');
  const content = loadTemplate('anvil.md.tpl');
  appendMarkerBlock(target, content);
}

function uninstallAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');
  const target = path.join(projectDir, '.anvil', 'instructions.md');
  removeMarkerBlock(target);
}

// ── Interactive Prompt ──────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptAgentSelection(detected) {
  console.log('\n  Detected agents:');
  for (const agent of AGENTS) {
    const status = detected[agent] ? '\x1b[32m*\x1b[0m' : '\x1b[90m-\x1b[0m';
    const label = detected[agent] ? '' : ' (not found)';
    console.log(`    ${status} ${agent}${label}`);
  }

  const available = AGENTS.filter((a) => detected[a]);
  const defaultStr = available.join(',');

  console.log('');
  const answer = await ask(`  Install for [${defaultStr}]: `);

  if (!answer) return available;
  return answer.split(',').map((s) => s.trim().toLowerCase()).filter((a) => AGENTS.includes(a));
}

// ── Orchestration ───────────────────────────────────────────

function install(agents, projectDir) {
  console.log('');
  console.log('pre-commit-hook — installing');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  // Verify pre-commit script exists
  if (!fs.existsSync(PRE_COMMIT_SCRIPT)) {
    err(`Pre-commit script not found at: ${PRE_COMMIT_SCRIPT}`);
    err('Make sure you are running this from the hooks repo.');
    process.exit(1);
  }

  for (const agent of agents) {
    switch (agent) {
      case 'git':    installGit(projectDir); break;
      case 'claude': installClaude(); break;
      case 'codex':  installCodex(projectDir); break;
      case 'gemini': installGemini(projectDir); break;
      case 'anvil':  installAnvil(projectDir); break;
    }
  }

  console.log('');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');
  console.log('  Done. Restart agents to activate.');
  console.log('');
}

function uninstall(agents, projectDir) {
  console.log('');
  console.log('pre-commit-hook — uninstalling');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  for (const agent of agents) {
    switch (agent) {
      case 'git':    uninstallGit(projectDir); break;
      case 'claude': uninstallClaude(); break;
      case 'codex':  uninstallCodex(projectDir); break;
      case 'gemini': uninstallGemini(projectDir); break;
      case 'anvil':  uninstallAnvil(projectDir); break;
    }
  }

  console.log('');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');
  console.log('  Done. Hooks removed.');
  console.log('');
}

// ── CLI ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    uninstall: false,
    all: false,
    agents: null,
    project: null,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--uninstall' || arg === '-u') opts.uninstall = true;
    else if (arg === '--all' || arg === '-a') opts.all = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--agent=')) opts.agents = arg.slice(8).split(',').map((s) => s.trim());
    else if (arg.startsWith('--project=')) opts.project = arg.slice(10);
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
  pre-commit-hook installer

  Usage:
    node install.js                          Interactive wizard
    node install.js --agent=claude,git       Install for specific agents
    node install.js --all                    Install for all detected agents
    node install.js --uninstall              Remove all installations
    node install.js --project=/path          Target project directory
    node install.js --help                   Show this help

  Agents: git, claude, codex, gemini, anvil
`);
    process.exit(0);
  }

  const projectDir = opts.project ? path.resolve(opts.project) : process.cwd();
  const detected = detectAgents(projectDir);

  let agents;

  if (opts.agents) {
    agents = opts.agents.filter((a) => AGENTS.includes(a));
  } else if (opts.all) {
    agents = AGENTS.filter((a) => detected[a]);
  } else {
    agents = await promptAgentSelection(detected);
  }

  if (agents.length === 0) {
    warn('No agents selected.');
    process.exit(0);
  }

  if (opts.uninstall) {
    uninstall(agents, projectDir);
  } else {
    install(agents, projectDir);
  }
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
