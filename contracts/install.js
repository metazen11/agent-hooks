#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js — Multi-agent engineering-contract hook installer
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
//  Installs the mechanical enforcement layer for the engineering
//  contract across supported agents. For Claude Code, this wires
//  a PreToolUse dispatcher into settings.json. For Codex / Gemini
//  / Anvil (no native hook system yet), it appends a marker-fenced
//  instruction block to the agent's project-level guidance file.
//
// ─────────────────────────────────────────────────────────────

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

// ── Config ──────────────────────────────────────────────────

const PACKAGE_DIR  = __dirname;
const HOME         = os.homedir();
const MARKER_START = '<!-- contracts-start -->';
const MARKER_END   = '<!-- contracts-end -->';

const AGENTS = ['claude', 'anvil', 'codex', 'gemini'];

// Claude Code matcher: pipe-separated regex covering the tool families
// the contract checks care about (edits, notebook edits, and shell).
const CLAUDE_MATCHER = 'Write|Edit|Bash|NotebookEdit';

// ── Helpers ─────────────────────────────────────────────────

const ok   = (msg) => console.log(`  \x1b[32m+\x1b[0m  ${msg}`);
const skip = (msg) => console.log(`  \x1b[90m.\x1b[0m  ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m  ${msg}`);
const err  = (msg) => console.error(`  \x1b[31mx\x1b[0m  ${msg}`);

/**
 * Create a directory (and its parents) if it does not exist. Logs a
 * "created" line on first creation.
 * @param {string} dir Absolute directory path.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ok(`Created ${dir}`);
  }
}

/**
 * Replace `dest` with a symlink pointing at `src`. Any prior file or
 * link at `dest` is removed first. Missing prior file is not an error.
 * @param {string} src Existing source path.
 * @param {string} dest Destination path to create as a symlink.
 */
function symlinkPath(src, dest) {
  try {
    fs.unlinkSync(dest);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.symlinkSync(src, dest);
  ok(`${path.basename(dest)}  ->  ${src}`);
}

/**
 * Remove a symlink at `dest`. Refuses to remove real files or dirs.
 * @param {string} dest Path expected to be a symlink.
 */
function removeSymlink(dest) {
  let stat;
  try {
    stat = fs.lstatSync(dest);
  } catch (e) {
    if (e.code === 'ENOENT') {
      skip(`${path.basename(dest)} not found`);
      return;
    }
    throw e;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(dest);
    ok(`Removed ${path.basename(dest)}`);
  } else {
    warn(`${path.basename(dest)} is not a symlink — skipped`);
  }
}

// ── Settings.json patching (Claude Code) ────────────────────

/**
 * Read a JSON file, returning `{}` if it is missing. Aborts the
 * process on parse error — we do not want to silently overwrite a
 * malformed settings file the operator has been editing.
 * @param {string} file Absolute file path.
 * @returns {object} Parsed JSON or empty object.
 */
function readJSON(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(`Failed to parse ${file}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Write a JSON file atomically (write-then-rename) so a crash mid-write
 * cannot leave the settings file half-populated.
 * @param {string} file Destination path.
 * @param {object} obj JSON-serialisable value.
 */
function writeJSONAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Ensure the PreToolUse hook entry for the contracts dispatcher is
 * present in `~/.claude/settings.json`. Idempotent — a repeated call
 * detects the existing entry by command string and skips.
 * @param {string} settingsFile Absolute path to settings.json.
 */
function addClaudeHook(settingsFile) {
  const settings = readJSON(settingsFile);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  const cmd = 'node ~/.claude/hooks/contracts/contracts-hook.js';
  const exists = settings.hooks.PreToolUse.some(
    (e) => e.hooks && e.hooks.some((h) => h.command === cmd)
  );

  if (exists) {
    skip('PreToolUse hook already in settings.json');
    return;
  }

  settings.hooks.PreToolUse.push({
    matcher: CLAUDE_MATCHER,
    hooks: [{ type: 'command', command: cmd, timeout: 15 }],
  });

  writeJSONAtomic(settingsFile, settings);
  ok(`Added PreToolUse hook (${CLAUDE_MATCHER}) to settings.json`);
}

/**
 * Remove the contracts PreToolUse entry from settings.json. Matches by
 * command string so unrelated hooks are preserved.
 * @param {string} settingsFile Absolute path to settings.json.
 */
function removeClaudeHook(settingsFile) {
  if (!fs.existsSync(settingsFile)) { skip('settings.json not found'); return; }

  const settings = readJSON(settingsFile);
  const arr = settings.hooks && settings.hooks.PreToolUse;
  if (!arr) { skip('No PreToolUse hooks to remove'); return; }

  const cmd = 'node ~/.claude/hooks/contracts/contracts-hook.js';
  const before = arr.length;
  settings.hooks.PreToolUse = arr.filter(
    (e) => !(e.hooks && e.hooks.some((h) => h.command === cmd))
  );

  if (settings.hooks.PreToolUse.length === before) {
    skip('Hook not found in settings.json');
    return;
  }

  writeJSONAtomic(settingsFile, settings);
  ok('Removed contracts hook from settings.json');
}

// ── Marker-based file patching (Codex/Gemini/Anvil) ─────────

/**
 * Append a marker-fenced block to `filePath`. If the start marker is
 * already present, the operation is a no-op — installers are expected
 * to be idempotent.
 * @param {string} filePath Target markdown file.
 * @param {string} content Block content (marker fences included).
 */
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

/**
 * Remove the marker-fenced block previously inserted by
 * `appendMarkerBlock`. Surrounding content is preserved.
 * @param {string} filePath Target markdown file.
 */
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

/**
 * Detect which supported agents have a config dir under $HOME.
 * @returns {{claude:boolean, anvil:boolean, codex:boolean, gemini:boolean}}
 */
function detectAgents() {
  return {
    claude: fs.existsSync(path.join(HOME, '.claude')),
    anvil:  fs.existsSync(path.join(HOME, '.anvil')),
    codex:  fs.existsSync(path.join(HOME, '.codex')),
    gemini: fs.existsSync(path.join(HOME, '.gemini')),
  };
}

// ── Per-Agent Installers ────────────────────────────────────

/**
 * Install the Claude Code integration.
 *
 * Symlinks the entire package directory into `~/.claude/hooks/contracts`
 * so the dispatcher can require its neighbors (checks/*.js) via
 * relative paths, then registers the dispatcher in settings.json.
 */
function installClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  ensureDir(hooksDir);

  const pkgDest = path.join(hooksDir, 'contracts');
  symlinkPath(PACKAGE_DIR, pkgDest);

  addClaudeHook(settingsFile);
}

/**
 * Remove the Claude Code integration installed by `installClaude`.
 */
function uninstallClaude() {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const hooksDir = path.join(HOME, '.claude', 'hooks');
  const settingsFile = path.join(HOME, '.claude', 'settings.json');

  removeSymlink(path.join(hooksDir, 'contracts'));
  removeClaudeHook(settingsFile);
}

/**
 * Install the Anvil integration.
 *
 * Anvil does not expose a native PreToolUse hook the way Claude Code
 * does, and this package does not yet ship middleware. For now we
 * install the marker-fenced instruction block into
 * `<projectDir>/.anvil/CONTRACTS.md` so Anvil sessions read the
 * contract from a stable location. Replace this with a middleware
 * copy step when a Python middleware is added to the package.
 *
 * @param {string} projectDir Absolute project root.
 */
function installAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');
  const anvilDir = path.join(projectDir, '.anvil');
  ensureDir(anvilDir);

  const tpl = fs.readFileSync(
    path.join(PACKAGE_DIR, 'instructions', 'anvil.md.tpl'),
    'utf8'
  );
  appendMarkerBlock(path.join(anvilDir, 'CONTRACTS.md'), tpl);
}

/**
 * Remove the Anvil integration installed by `installAnvil`.
 * @param {string} projectDir Absolute project root.
 */
function uninstallAnvil(projectDir) {
  console.log('\n  \x1b[36manvil:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, '.anvil', 'CONTRACTS.md'));
}

/**
 * Install the Codex integration by appending the marker-fenced block
 * to `<projectDir>/AGENTS.md` (Codex's project guidance file).
 * @param {string} projectDir Absolute project root.
 */
function installCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  const tpl = fs.readFileSync(
    path.join(PACKAGE_DIR, 'instructions', 'agents.md.tpl'),
    'utf8'
  );
  appendMarkerBlock(path.join(projectDir, 'AGENTS.md'), tpl);
}

/**
 * Remove the Codex integration installed by `installCodex`.
 * @param {string} projectDir Absolute project root.
 */
function uninstallCodex(projectDir) {
  console.log('\n  \x1b[36mcodex:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'AGENTS.md'));
}

/**
 * Install the Gemini integration by appending the marker-fenced block
 * to `<projectDir>/GEMINI.md`.
 * @param {string} projectDir Absolute project root.
 */
function installGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  const tpl = fs.readFileSync(
    path.join(PACKAGE_DIR, 'instructions', 'gemini.md.tpl'),
    'utf8'
  );
  appendMarkerBlock(path.join(projectDir, 'GEMINI.md'), tpl);
}

/**
 * Remove the Gemini integration installed by `installGemini`.
 * @param {string} projectDir Absolute project root.
 */
function uninstallGemini(projectDir) {
  console.log('\n  \x1b[36mgemini:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'GEMINI.md'));
}

// ── Interactive Prompt ──────────────────────────────────────

/**
 * Ask a single question on stdin/stdout and resolve with the trimmed
 * answer. The readline interface is created and torn down per call to
 * avoid leaking listeners in one-shot scripts.
 * @param {string} question Prompt text.
 * @returns {Promise<string>}
 */
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

/**
 * Show which agents were detected and prompt the operator for a
 * comma-separated subset. Empty input accepts the default (all
 * detected agents).
 * @param {object} detected Result of `detectAgents`.
 * @returns {Promise<string[]>} Chosen agent identifiers.
 */
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

/**
 * Run the per-agent installer for each selected agent.
 * @param {string[]} agents Agent identifiers.
 * @param {string} projectDir Absolute project root for file-based installs.
 */
function install(agents, projectDir) {
  console.log('');
  console.log('contracts — installing');
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

/**
 * Run the per-agent uninstaller for each selected agent.
 * @param {string[]} agents Agent identifiers.
 * @param {string} projectDir Absolute project root for file-based installs.
 */
function uninstall(agents, projectDir) {
  console.log('');
  console.log('contracts — uninstalling');
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

/**
 * Parse process.argv into an options object.
 * @returns {{uninstall:boolean, all:boolean, agents:?string[], project:?string, help:boolean}}
 */
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

/**
 * CLI entry point. Selects an agent set (flags or interactive prompt)
 * and dispatches to install/uninstall.
 */
async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
  contracts installer

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

  // Guard: running the installer from inside the package would treat the
  // package itself as the target project and write instruction files into
  // it. Those belong in each consuming project. Refuse instead.
  if (projectDir === PACKAGE_DIR) {
    console.error('');
    console.error('  Refusing to install into the package directory itself.');
    console.error('  Instruction files belong in the consuming project.');
    console.error('');
    console.error(`  Run from the target repo, or pass --project=/path/to/repo`);
    console.error('');
    process.exit(1);
  }

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
