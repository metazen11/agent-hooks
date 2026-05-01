#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// plan-refiner-hook.js — Claude Code PreToolUse hook
// ─────────────────────────────────────────────────────────────
//
// Intercepts ExitPlanMode and blocks submission until the plan
// has been refined (indicated by `refined_once: true` in YAML
// frontmatter or a .refined/ marker file).
//
// Protocol:
//   stdin:  { tool_name, tool_input, cwd }
//   stdout: { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
//
// Design: fail-open (if no plan found or prompt missing, allow)
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Constants ───────────────────────────────────────────────

const HOOK_EVENT = 'PreToolUse';
const REFINER_PROMPT_PATH = path.resolve(__dirname, 'refiner-prompt.md');

// Plan file locations to search (in order of preference)
const PLAN_DIR_PATTERNS = [
  '.claude/plans',           // Claude Code project-specific plans
  'plans',                   // Generic plans directory
  '.anvil',                  // Anvil active plan
];

// ── Response helpers ────────────────────────────────────────

function allow() {
  const result = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'allow',
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

function deny(reason) {
  const result = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// ── Frontmatter parsing ────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    // Parse booleans and strip quotes
    if (val === 'true') fm[key] = true;
    else if (val === 'false') fm[key] = false;
    else fm[key] = val.replace(/^["']|["']$/g, '');
  }
  return fm;
}

function hasRefinementStamp(planPath) {
  try {
    const content = fs.readFileSync(planPath, 'utf8');

    // Check frontmatter
    const fm = parseFrontmatter(content);
    if (fm.refined_once === true) return true;

    // Check marker file
    const dir = path.dirname(planPath);
    const basename = path.basename(planPath, '.md');
    const markerDir = path.join(dir, '.refined');
    const markerFile = path.join(markerDir, `${basename}.refined`);
    if (fs.existsSync(markerFile)) return true;

    return false;
  } catch {
    return false;
  }
}

// ── Plan file discovery ─────────────────────────────────────

function findActivePlan(cwd) {
  // Search each plan directory pattern
  for (const pattern of PLAN_DIR_PATTERNS) {
    const dir = path.join(cwd, pattern);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;

    // Find .md files, sorted by mtime (most recent first)
    let mdFiles;
    try {
      mdFiles = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .map((f) => {
          const full = path.join(dir, f);
          return { path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
    }

    if (mdFiles.length > 0) return mdFiles[0].path;
  }

  return null;
}

// Also check project-specific Claude plans dir
function findActivePlanWithProject(cwd) {
  // First try: project-specific .claude/plans in the session context
  // Claude Code stores plans in ~/.claude/plans/ or project-specific locations
  const homePlans = path.join(
    process.env.HOME || require('os').homedir(),
    '.claude', 'plans'
  );

  // Check home plans dir for most recent
  if (fs.existsSync(homePlans)) {
    try {
      const mdFiles = fs.readdirSync(homePlans)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .map((f) => {
          const full = path.join(homePlans, f);
          return { path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      // Only consider files modified in the last 5 minutes (active plan)
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const recent = mdFiles.filter((f) => f.mtime > fiveMinAgo);
      if (recent.length > 0) return recent[0].path;
    } catch {}
  }

  // Fallback: search cwd-relative patterns
  return findActivePlan(cwd);
}

// ── Main ────────────────────────────────────────────────────

function main(input) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    allow();
    return;
  }

  // Only intercept ExitPlanMode
  if (data.tool_name !== 'ExitPlanMode') {
    allow();
    return;
  }

  const cwd = data.cwd || process.cwd();

  // Find the active plan file
  const planPath = findActivePlanWithProject(cwd);
  if (!planPath) {
    // No plan file found — don't block
    process.stderr.write(
      '[plan-refiner] No plan file found — allowing ExitPlanMode\n'
    );
    allow();
    return;
  }

  // Read plan content
  let planContent;
  try {
    planContent = fs.readFileSync(planPath, 'utf8').trim();
  } catch {
    allow();
    return;
  }

  // Empty plan — nothing to refine
  if (!planContent) {
    allow();
    return;
  }

  // Check if already refined
  if (hasRefinementStamp(planPath)) {
    allow();
    return;
  }

  // Load refiner prompt
  let refinerPrompt;
  try {
    refinerPrompt = fs.readFileSync(REFINER_PROMPT_PATH, 'utf8').trim();
  } catch {
    process.stderr.write(
      `[plan-refiner] WARNING: Refiner prompt not found at ${REFINER_PROMPT_PATH} — allowing\n`
    );
    allow();
    return;
  }

  // Block and inject refiner
  const reason = [
    'PLAN REFINEMENT REQUIRED',
    '',
    'Your plan has not been refined yet. Before submitting for approval,',
    'you must review and refine it using the quality gate checklist below.',
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
    refinerPrompt,
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
    `Plan file: ${planPath}`,
    '',
    'Current plan content:',
    '───────────────────────────────────────────────────────────────',
    planContent,
    '───────────────────────────────────────────────────────────────',
    '',
    'Instructions:',
    '1. Review the plan above against the quality gate checklist',
    '2. Refine the plan by editing the plan file',
    '3. Add this frontmatter at the top of the plan file:',
    '   ---',
    '   refined_once: true',
    `   refined_at: ${new Date().toISOString()}`,
    '   refined_by: claude-code',
    '   ---',
    '4. Call ExitPlanMode again',
  ].join('\n');

  deny(reason);
}

// ── Read stdin ──────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { main(input); });

// Handle broken pipe gracefully
process.stdout.on('error', () => process.exit(0));
process.stderr.on('error', () => {});

// ── Exports for testing ─────────────────────────────────────

if (typeof module !== 'undefined') {
  module.exports = {
    parseFrontmatter,
    hasRefinementStamp,
    findActivePlan,
  };
}
