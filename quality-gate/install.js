#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// install.js — Quality gate installer for target projects
// ─────────────────────────────────────────────────────────────
//
// Copies schema, validator, git hook, and instruction fragments
// into a target project directory.
//
//  Usage:
//    node install.js --project=/path/to/repo           # Interactive
//    node install.js --project=/path/to/repo --all     # All targets
//    node install.js --project=/path/to/repo --uninstall
//    node install.js --help
//
// ─────────────────────────────────────────────────────────────

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────

const PACKAGE_DIR     = __dirname;
const HOME            = os.homedir();
const MARKER_START    = '<!-- quality-gate-start -->';
const MARKER_END      = '<!-- quality-gate-end -->';

const TARGETS = ['git', 'github', 'claude', 'codex', 'gemini'];

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

function copyIfNeeded(src, dest) {
  const destExists = fs.existsSync(dest);
  if (destExists) {
    const srcContent = fs.readFileSync(src, 'utf8');
    const destContent = fs.readFileSync(dest, 'utf8');
    if (srcContent === destContent) {
      skip(`${path.basename(dest)} already up to date`);
      return;
    }
  }
  fs.copyFileSync(src, dest);
  ok(`${destExists ? 'Updated' : 'Copied'} ${path.basename(dest)}`);
}

function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    ok(`Removed ${path.basename(filePath)}`);
  } else {
    skip(`${path.basename(filePath)} not found`);
  }
}

// ── Marker-based file patching ──────────────────────────────

function appendMarkerBlock(filePath, content) {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }
  if (existing.includes(MARKER_START)) {
    skip(`Quality gate block already in ${path.basename(filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, existing + '\n' + content.trim() + '\n', 'utf8');
  ok(`Appended quality gate to ${path.basename(filePath)}`);
}

function removeMarkerBlock(filePath) {
  if (!fs.existsSync(filePath)) { skip(`${path.basename(filePath)} not found`); return; }
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(MARKER_START)) { skip(`No quality gate block in ${path.basename(filePath)}`); return; }
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (endIdx === -1) { warn(`Found start marker but no end in ${path.basename(filePath)}`); return; }
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + MARKER_END.length).replace(/^\n+/, '');
  fs.writeFileSync(filePath, before + (after ? '\n' + after : '') + '\n', 'utf8');
  ok(`Removed quality gate from ${path.basename(filePath)}`);
}

// ── Detection ───────────────────────────────────────────────

function detectTargets(projectDir) {
  return {
    git:    fs.existsSync(path.join(projectDir, '.git')),
    github: fs.existsSync(path.join(projectDir, '.git')), // any git repo can have actions
    claude: fs.existsSync(path.join(projectDir, 'CLAUDE.md')) || fs.existsSync(path.join(HOME, '.claude')),
    codex:  fs.existsSync(path.join(HOME, '.codex')),
    gemini: fs.existsSync(path.join(HOME, '.gemini')),
  };
}

// ── Detect Python + jsonschema ──────────────────────────────

function hasPythonJsonschema() {
  try {
    execSync('python3 -c "import jsonschema"', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── Per-Target Installers ───────────────────────────────────

function installGit(projectDir) {
  console.log('\n  \x1b[36mgit:\x1b[0m');

  // Copy schema
  const schemasDir = path.join(projectDir, 'schemas');
  ensureDir(schemasDir);
  copyIfNeeded(
    path.join(PACKAGE_DIR, 'schemas', 'quality-gate-output.schema.json'),
    path.join(schemasDir, 'quality-gate-output.schema.json')
  );

  // Copy validator(s)
  const scriptsDir = path.join(projectDir, 'scripts');
  ensureDir(scriptsDir);

  if (hasPythonJsonschema()) {
    copyIfNeeded(
      path.join(PACKAGE_DIR, 'scripts', 'validate_quality_gate.py'),
      path.join(scriptsDir, 'validate_quality_gate.py')
    );
    try { fs.chmodSync(path.join(scriptsDir, 'validate_quality_gate.py'), 0o755); } catch {}
  } else {
    warn('Python jsonschema not available — installing Node.js validator');
  }

  // Always install Node.js fallback
  copyIfNeeded(
    path.join(PACKAGE_DIR, 'scripts', 'validate_quality_gate_node.js'),
    path.join(scriptsDir, 'validate_quality_gate_node.js')
  );

  // Create plans/ directory
  const plansDir = path.join(projectDir, 'plans');
  ensureDir(plansDir);
  const gitkeep = path.join(plansDir, '.gitkeep');
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, '');
    ok('Created plans/.gitkeep');
  }

  // Install git hook (chain with existing pre-commit)
  const hookScript = path.join(PACKAGE_DIR, 'hooks', 'pre-commit-quality-gate.sh');
  const gitHooksDir = path.join(projectDir, '.git', 'hooks');
  const preCommit = path.join(gitHooksDir, 'pre-commit');

  if (fs.existsSync(preCommit)) {
    const existing = fs.readFileSync(preCommit, 'utf8');
    if (existing.includes('pre-commit-quality-gate')) {
      skip('Quality gate already chained in pre-commit');
    } else {
      // Chain: append call to our script
      const chain = `\n\n# Quality gate — validate plans/*.json\nbash "${path.join(projectDir, 'scripts', 'pre-commit-quality-gate.sh')}" || exit 1\n`;
      // Copy our hook script to scripts/ for chaining
      copyIfNeeded(hookScript, path.join(scriptsDir, 'pre-commit-quality-gate.sh'));
      try { fs.chmodSync(path.join(scriptsDir, 'pre-commit-quality-gate.sh'), 0o755); } catch {}
      fs.appendFileSync(preCommit, chain);
      ok('Chained quality gate into existing pre-commit');
    }
  } else {
    // No existing hook — install directly
    copyIfNeeded(hookScript, preCommit);
    try { fs.chmodSync(preCommit, 0o755); } catch {}
    ok('Installed pre-commit hook');
  }
}

function uninstallGit(projectDir) {
  console.log('\n  \x1b[36mgit:\x1b[0m');
  removeFile(path.join(projectDir, 'schemas', 'quality-gate-output.schema.json'));
  removeFile(path.join(projectDir, 'scripts', 'validate_quality_gate.py'));
  removeFile(path.join(projectDir, 'scripts', 'validate_quality_gate_node.js'));
  removeFile(path.join(projectDir, 'scripts', 'pre-commit-quality-gate.sh'));

  // Remove chain from pre-commit
  const preCommit = path.join(projectDir, '.git', 'hooks', 'pre-commit');
  if (fs.existsSync(preCommit)) {
    let content = fs.readFileSync(preCommit, 'utf8');
    if (content.includes('pre-commit-quality-gate')) {
      content = content.replace(/\n*# Quality gate — validate plans\/\*\.json\n.*pre-commit-quality-gate.*\n?/g, '');
      fs.writeFileSync(preCommit, content);
      ok('Removed quality gate chain from pre-commit');
    }
  }
}

function installGitHub(projectDir) {
  console.log('\n  \x1b[36mgithub:\x1b[0m');
  const workflowDir = path.join(projectDir, '.github', 'workflows');
  ensureDir(workflowDir);
  copyIfNeeded(
    path.join(PACKAGE_DIR, 'workflows', 'quality-gate.yml'),
    path.join(workflowDir, 'quality-gate.yml')
  );
}

function uninstallGitHub(projectDir) {
  console.log('\n  \x1b[36mgithub:\x1b[0m');
  removeFile(path.join(projectDir, '.github', 'workflows', 'quality-gate.yml'));
}

function installClaude(projectDir) {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  const tpl = fs.readFileSync(path.join(PACKAGE_DIR, 'instructions', 'claude.md.tpl'), 'utf8');
  appendMarkerBlock(path.join(projectDir, 'CLAUDE.md'), tpl);
}

function uninstallClaude(projectDir) {
  console.log('\n  \x1b[36mclaude:\x1b[0m');
  removeMarkerBlock(path.join(projectDir, 'CLAUDE.md'));
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function promptSelection(detected) {
  console.log('\n  Available targets:');
  for (const t of TARGETS) {
    const status = detected[t] ? '\x1b[32m*\x1b[0m' : '\x1b[90m-\x1b[0m';
    const label = detected[t] ? '' : ' (not detected)';
    console.log(`    ${status} ${t}${label}`);
  }
  const available = TARGETS.filter((t) => detected[t]);
  console.log('');
  const answer = await ask(`  Install for [${available.join(',')}]: `);
  if (!answer) return available;
  return answer.split(',').map((s) => s.trim().toLowerCase()).filter((t) => TARGETS.includes(t));
}

// ── Orchestration ───────────────────────────────────────────

function install(targets, projectDir) {
  console.log('');
  console.log('quality-gate — installing');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  for (const t of targets) {
    switch (t) {
      case 'git':    installGit(projectDir); break;
      case 'github': installGitHub(projectDir); break;
      case 'claude': installClaude(projectDir); break;
      case 'codex':  installCodex(projectDir); break;
      case 'gemini': installGemini(projectDir); break;
    }
  }

  console.log('');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');
  console.log('  Done.');
  if (!hasPythonJsonschema()) {
    console.log('');
    warn('Recommended: pip install jsonschema');
  }
  console.log('');
}

function uninstall(targets, projectDir) {
  console.log('');
  console.log('quality-gate — uninstalling');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');

  for (const t of targets) {
    switch (t) {
      case 'git':    uninstallGit(projectDir); break;
      case 'github': uninstallGitHub(projectDir); break;
      case 'claude': uninstallClaude(projectDir); break;
      case 'codex':  uninstallCodex(projectDir); break;
      case 'gemini': uninstallGemini(projectDir); break;
    }
  }

  console.log('');
  console.log('\x1b[90m' + '─'.repeat(40) + '\x1b[0m');
  console.log('  Done.');
  console.log('');
}

// ── CLI ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { uninstall: false, all: false, targets: null, project: null, help: false };
  for (const arg of args) {
    if (arg === '--uninstall' || arg === '-u') opts.uninstall = true;
    else if (arg === '--all' || arg === '-a') opts.all = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--target=')) opts.targets = arg.slice(9).split(',').map((s) => s.trim());
    else if (arg.startsWith('--project=')) opts.project = arg.slice(10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
  quality-gate installer

  Usage:
    node install.js --project=/path/to/repo          Interactive
    node install.js --project=/path --target=git      Specific targets
    node install.js --project=/path --all             All targets
    node install.js --project=/path --uninstall       Remove all
    node install.js --help                            Show this help

  Targets: git, github, claude, codex, gemini

  The --project flag is required (target repo to install into).
`);
    process.exit(0);
  }

  if (!opts.project) {
    err('--project=/path/to/repo is required.');
    err('This installs the quality gate INTO a target project.');
    process.exit(1);
  }

  const projectDir = path.resolve(opts.project);
  if (!fs.existsSync(projectDir)) {
    err(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  const detected = detectTargets(projectDir);
  let targets;

  if (opts.targets) {
    targets = opts.targets.filter((t) => TARGETS.includes(t));
  } else if (opts.all) {
    targets = TARGETS.filter((t) => detected[t]);
  } else {
    targets = await promptSelection(detected);
  }

  if (targets.length === 0) {
    warn('No targets selected.');
    process.exit(0);
  }

  if (opts.uninstall) {
    uninstall(targets, projectDir);
  } else {
    install(targets, projectDir);
  }
}

main().catch((e) => { err(e.message); process.exit(1); });
