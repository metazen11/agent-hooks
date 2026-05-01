#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// test.js — Unit tests for plan-refiner
// ─────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-refiner-test-'));
}

// Import functions from hook
const { parseFrontmatter, hasRefinementStamp, findActivePlan } = require('./plan-refiner-hook.js');

// ── parseFrontmatter tests ──────────────────────────────────

console.log('\nparseFrontmatter:');

assert(
  parseFrontmatter('---\nrefined_once: true\n---\n# Plan').refined_once === true,
  'parses refined_once: true'
);

assert(
  parseFrontmatter('---\nrefined_once: false\n---\n# Plan').refined_once === false,
  'parses refined_once: false'
);

assert(
  parseFrontmatter('---\nrefined_once: true\nrefined_at: 2026-05-01\nrefined_by: claude\n---').refined_at === '2026-05-01',
  'parses multiple fields'
);

assert(
  Object.keys(parseFrontmatter('# No frontmatter')).length === 0,
  'returns empty for no frontmatter'
);

assert(
  Object.keys(parseFrontmatter('')).length === 0,
  'returns empty for empty string'
);

assert(
  parseFrontmatter('---\nkey: "quoted value"\n---').key === 'quoted value',
  'strips quotes from values'
);

// ── hasRefinementStamp tests ────────────────────────────────

console.log('\nhasRefinementStamp:');

const dir1 = tmpDir();

// Stamped via frontmatter
const stamped = path.join(dir1, 'stamped.md');
fs.writeFileSync(stamped, '---\nrefined_once: true\nrefined_at: 2026-05-01\n---\n# Plan\n');
assert(hasRefinementStamp(stamped) === true, 'detects frontmatter stamp');

// Not stamped
const unstamped = path.join(dir1, 'unstamped.md');
fs.writeFileSync(unstamped, '# Plan\n\nSome content.\n');
assert(hasRefinementStamp(unstamped) === false, 'detects missing stamp');

// Stamped false
const stampedFalse = path.join(dir1, 'stamped-false.md');
fs.writeFileSync(stampedFalse, '---\nrefined_once: false\n---\n# Plan\n');
assert(hasRefinementStamp(stampedFalse) === false, 'refined_once: false is not stamped');

// Stamped via marker file
const markerDir = path.join(dir1, '.refined');
fs.mkdirSync(markerDir);
const markerPlan = path.join(dir1, 'marker-plan.md');
fs.writeFileSync(markerPlan, '# Plan without frontmatter\n');
fs.writeFileSync(path.join(markerDir, 'marker-plan.refined'), '');
assert(hasRefinementStamp(markerPlan) === true, 'detects marker file stamp');

// Non-existent file
assert(hasRefinementStamp(path.join(dir1, 'nope.md')) === false, 'non-existent file returns false');

// ── findActivePlan tests ────────────────────────────────────

console.log('\nfindActivePlan:');

const dir2 = tmpDir();

// No plans dir
assert(findActivePlan(dir2) === null, 'returns null for no plans dir');

// With .claude/plans/
const plansDir = path.join(dir2, '.claude', 'plans');
fs.mkdirSync(plansDir, { recursive: true });

const plan1 = path.join(plansDir, 'old-plan.md');
fs.writeFileSync(plan1, '# Old plan');
// Ensure different mtime
const now = Date.now();
fs.utimesSync(plan1, new Date(now - 10000), new Date(now - 10000));

const plan2 = path.join(plansDir, 'new-plan.md');
fs.writeFileSync(plan2, '# New plan');
fs.utimesSync(plan2, new Date(now), new Date(now));

const found = findActivePlan(dir2);
assert(found === plan2, 'returns most recently modified plan');

// Ignores dotfiles
fs.writeFileSync(path.join(plansDir, '.hidden.md'), '# Hidden');
const found2 = findActivePlan(dir2);
assert(path.basename(found2) !== '.hidden.md', 'ignores dotfiles');

// ── Hook integration tests ──────────────────────────────────

console.log('\nhook integration:');

const hookPath = path.join(__dirname, 'plan-refiner-hook.js');

function runHook(input) {
  try {
    const result = execSync(`node "${hookPath}"`, {
      input: JSON.stringify(input),
      timeout: 10000,
      encoding: 'utf8',
    });
    return JSON.parse(result);
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

// Non-ExitPlanMode tool passes through
const r1 = runHook({ tool_name: 'Write', tool_input: {}, cwd: '/tmp' });
assert(r1.hookSpecificOutput.permissionDecision === 'allow', 'non-ExitPlanMode tool allowed');

// ExitPlanMode with no plan file passes through
const emptyDir = tmpDir();
const r2 = runHook({ tool_name: 'ExitPlanMode', tool_input: {}, cwd: emptyDir });
assert(r2.hookSpecificOutput.permissionDecision === 'allow', 'ExitPlanMode with no plan allowed');

// ExitPlanMode with stamped plan passes through
const dir3 = tmpDir();
const stampedPlansDir = path.join(dir3, '.claude', 'plans');
fs.mkdirSync(stampedPlansDir, { recursive: true });
fs.writeFileSync(
  path.join(stampedPlansDir, 'test.md'),
  '---\nrefined_once: true\nrefined_at: 2026-05-01\n---\n# My Plan\n'
);
const r3 = runHook({ tool_name: 'ExitPlanMode', tool_input: {}, cwd: dir3 });
assert(r3.hookSpecificOutput.permissionDecision === 'allow', 'ExitPlanMode with stamped plan allowed');

// ExitPlanMode with unstamped plan is denied
const dir4 = tmpDir();
const unstampedPlansDir = path.join(dir4, '.claude', 'plans');
fs.mkdirSync(unstampedPlansDir, { recursive: true });
fs.writeFileSync(
  path.join(unstampedPlansDir, 'test.md'),
  '# My Plan\n\nThis needs refinement.\n'
);
const r4 = runHook({ tool_name: 'ExitPlanMode', tool_input: {}, cwd: dir4 });
assert(r4.hookSpecificOutput.permissionDecision === 'deny', 'ExitPlanMode with unstamped plan denied');
assert(
  r4.hookSpecificOutput.permissionDecisionReason.includes('PLAN REFINEMENT REQUIRED'),
  'denial reason contains refiner prompt'
);

// ── Marker block tests ──────────────────────────────────────

console.log('\nmarker blocks:');

const MARKER_START = '<!-- plan-refiner-start -->';
const MARKER_END   = '<!-- plan-refiner-end -->';

function appendMarkerBlock(filePath, content) {
  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(MARKER_START)) return false;
  fs.writeFileSync(filePath, existing + '\n' + content.trim() + '\n', 'utf8');
  return true;
}

function removeMarkerBlock(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(MARKER_START)) return false;
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (endIdx === -1) return false;
  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + MARKER_END.length).replace(/^\n+/, '');
  fs.writeFileSync(filePath, before + (after ? '\n' + after : '') + '\n', 'utf8');
  return true;
}

const dir5 = tmpDir();
const mdFile = path.join(dir5, 'AGENTS.md');
const block = `${MARKER_START}\n## Quality Gate\nDo stuff.\n${MARKER_END}`;

assert(appendMarkerBlock(mdFile, block) === true, 'append to new file');
assert(appendMarkerBlock(mdFile, block) === false, 'idempotent append');
assert(removeMarkerBlock(mdFile) === true, 'remove block');
assert(!fs.readFileSync(mdFile, 'utf8').includes(MARKER_START), 'block removed from content');

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');

// Cleanup
for (const d of [dir1, dir2, dir3, dir4, dir5, emptyDir]) {
  fs.rmSync(d, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
