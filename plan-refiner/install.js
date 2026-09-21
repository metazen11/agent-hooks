#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js — Multi-agent plan refiner hook installer
// ─────────────────────────────────────────────────────────────
//
//  Usage:
//    node install.js                          # Interactive wizard
//    node install.js --agent=claude,anvil     # Non-interactive
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

const PACKAGE_DIR    = __dirname;
const HOME           = os.homedir();
const MARKER_START   = '<!-- plan-refiner-start -->';
const MARKER_END     = '<!-- plan-refiner-end -->';

const AGENTS = ['claude', 'anvil', 'codex', 'gemini'];

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

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  ok(`Copied ${path.basename(dest)}`);
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

  const cmd = 'node ~/.claude/hooks/plan-refiner-hook.js';
  const exists = settings.hooks.PreToolUse.some(
    (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
  );

  if (exists) {
    skip('PreToolUse hook already in settings.json');
    return;
  }

  settings.hooks.PreToolUse.push({
    matcher: 'ExitPlanMode',
    hooks: [{ type: 'command', command: cmd, timeout: 15 }],
  });

  writeJSONAtomic(settingsFile, settings);
  ok('Added PreToolUse hook for ExitPlanMode to settings.json');
}

function removeClaudeHook(settingsFile) {
  if (!fs.existsSync(settingsFile)) { skip('settings.json not found'); return; }

  const settings = readJSON(settingsFile);
  const arr = settings.hooks?.PreToolUse;
  if (!arr) { skip('No PreToolUse hooks to remove'); return; }

  const cmd = 'node ~/.claude/hooks/plan-refiner-hook.js';
  const before = arr.length;
  settings.hooks.PreToolUse = arr.filter(
    (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
  );

  if (settings.hooks.PreToolUse.length === before) {
    skip('Hook not found in settings.json');
    return;
  }

  writeJSONAtomic(settingsFile, settings);
  ok('Removed plan-refiner hook from settings.json');
}

// ── Marker-based file patching (Codex/Gemini) ───────────────

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

// ── Agent Detection ─────────────────────────────────────────

function detectAgents() {
  return {
    claude: fs.existsSync(path.join(HOME, '.claude')),
    anvil:  fs.existsSync(path.join(HOME, '.anvil')),
    codex:  fs.existsSync(path.join(HOME, '.codex')),
    gemini: fs.existsSync(path.join(HOME, '.gemini')),
  };
}

// ── Per-Agent Installers ────────────────────────────────────

function installClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  ensureDir(hooksDir);

  // Symlink hook script
  const hookSrc = path.join(PACKAGE_DIR, 'plan-refiner-hook.js');
  const hookDest = path.join(hooksDir, 'plan-refiner-hook.js');
  symlinkFile(hookSrc, hookDest);

  // Symlink refiner prompt (hook resolves it via __dirname)
  const promptSrc = path.join(PACKAGE_DIR, 'refiner-prompt.md');
  const promptDest = path.join(hooksDir, 'plan-refiner-prompt.md');
  symlinkFile(promptSrc, promptDest);

  // Patch settings.json
  addClaudeHook(settingsFile);
}

function uninstallClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  removeSymlink(path.join(hooksDir, 'plan-refiner-hook.js'));
  removeSymlink(path.join(hooksDir, 'plan-refiner-prompt.md'));
  removeClaudeHook(settingsFile);
}

function installAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');

  // Copy middleware to project .anvil/ or global
  const anvilDir = path.join(projectDir, '.anvil');
  const middlewareDir = path.join(anvilDir, 'middleware');
  ensureDir(middlewareDir);

  const src = path.join(PACKAGE_DIR, 'plan-refiner-middleware.py');
  const dest = path.join(middlewareDir, 'plan_refiner_middleware.py');
  copyFile(src, dest);

  // Also copy refiner prompt
  const promptSrc = path.join(PACKAGE_DIR, 'refiner-prompt.md');
  const promptDest = path.join(middlewareDir, 'refiner-prompt.md');
  copyFile(promptSrc, promptDest);

  ok('Register in Anvil: middleware=[PlanRefinerMiddleware()]');
}

function uninstallAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');
  const middlewareDir = path.join(projectDir, '.anvil', 'middleware');

  const mwFile = path.join(middlewareDir, 'plan_refiner_middleware.py');
  const promptFile = path.join(middlewareDir, 'refiner-prompt.md');

  for (const f of [mwFile, promptFile]) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      ok(`Removed ${path.basename(f)}`);
    } else {
      skip(`${path.basename(f)} not found`);
    }
  }
}

function installCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  const tpl = fs.readFileSync(path.join(PACKAGE_DIR, 'instructions', 'agents.md.tpl'), 'utf8');
  appendMarkerBlock(path.join(projectDir, 'AGENTS.md'), tpl);
}

function uninstallCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'AGENTS.md'));
}

function installGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  const tpl = fs.readFileSync(path.join(PACKAGE_DIR, 'instructions', 'gemini.md.tpl'), 'utf8');
  appendMarkerBlock(path.join(projectDir, 'GEMINI.md'), tpl);
}

function uninstallGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'GEMINI.md'));
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
  console.log('plan-refiner — installing');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  for (const agent of agents) {
    switch (agent) {
      case 'claude': installClaude(); break;
      case 'anvil':  installAnvil(projectDir); break;
      case 'codex':  installCodex(projectDir); break;
      case 'gemini': installGemini(projectDir); break;
    }
  }

  console.log('');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');
  console.log('  Done. Restart agents to activate.');
  console.log('');
}

function uninstall(agents, projectDir) {
  console.log('');
  console.log('plan-refiner — uninstalling');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  for (const agent of agents) {
    switch (agent) {
      case 'claude': uninstallClaude(); break;
      case 'anvil':  uninstallAnvil(projectDir); break;
      case 'codex':  uninstallCodex(projectDir); break;
      case 'gemini': uninstallGemini(projectDir); break;
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
  plan-refiner installer

  Usage:
    node install.js                          Interactive wizard
    node install.js --agent=claude,anvil     Install for specific agents
    node install.js --all                    Install for all detected agents
    node install.js --uninstall              Remove all installations
    node install.js --project=/path          Target project directory
    node install.js --help                   Show this help

  Agents: claude, anvil, codex, gemini
`);
    process.exit(0);
  }

  const projectDir = opts.project ? path.resolve(opts.project) : process.cwd();
  const detected = detectAgents();

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
