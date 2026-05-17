#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// test.js — Unit tests for pre-commit-hook
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pre-commit-test-'));
}

// ── isGitCommitCommand tests ────────────────────────────────

console.log('\nisGitCommitCommand:');

// Inline the function for testing (same logic as wrapper)
function isGitCommitCommand(command) {
  if (!command) return false;
  if (/--no-verify/.test(command)) return false;
  return /\bgit\s+commit\b/.test(command);
}

assert(isGitCommitCommand('git commit -m "test"') === true, 'git commit -m "test"');
assert(isGitCommitCommand('git commit') === true, 'git commit');
assert(isGitCommitCommand('git  commit') === true, 'git  commit (double space)');
assert(isGitCommitCommand('cd /tmp && git commit -am "x"') === true, 'chained with git commit');
assert(isGitCommitCommand('git commit --no-verify') === false, 'git commit --no-verify');
assert(isGitCommitCommand('git commit --no-verify -m "x"') === false, '--no-verify with message');
assert(isGitCommitCommand('git status') === false, 'git status');
assert(isGitCommitCommand('git log --oneline') === false, 'git log');
assert(isGitCommitCommand('echo git commit') === true, 'echo git commit (acceptable false positive)');
assert(isGitCommitCommand('') === false, 'empty string');
assert(isGitCommitCommand(null) === false, 'null');
assert(isGitCommitCommand(undefined) === false, 'undefined');

// ── appendMarkerBlock / removeMarkerBlock tests ─────────────

console.log('\nmarker block operations:');

const MARKER_START = '<!-- pre-commit-hook-start -->';
const MARKER_END   = '<!-- pre-commit-hook-end -->';

function appendMarkerBlock(filePath, content) {
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }
  if (existing.includes(MARKER_START)) return false;
  const block = '\n' + content.trim() + '\n';
  fs.writeFileSync(filePath, existing + block, 'utf8');
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
  const result = before + (after ? '\n' + after : '') + '\n';
  fs.writeFileSync(filePath, result, 'utf8');
  return true;
}

const testContent = `${MARKER_START}\n## Quality Gate\nRun checks.\n${MARKER_END}`;

// Test: append to empty file
const dir1 = tmpDir();
const file1 = path.join(dir1, 'test.md');
assert(appendMarkerBlock(file1, testContent) === true, 'append to new file returns true');
assert(fs.readFileSync(file1, 'utf8').includes(MARKER_START), 'file contains marker');

// Test: idempotent
assert(appendMarkerBlock(file1, testContent) === false, 'second append returns false (idempotent)');
const content1 = fs.readFileSync(file1, 'utf8');
const markerCount = (content1.match(/pre-commit-hook-start/g) || []).length;
assert(markerCount === 1, 'only one marker block after double append');

// Test: append to existing file with content
const dir2 = tmpDir();
const file2 = path.join(dir2, 'AGENTS.md');
fs.writeFileSync(file2, '# My Project\n\nExisting content.\n');
appendMarkerBlock(file2, testContent);
const content2 = fs.readFileSync(file2, 'utf8');
assert(content2.startsWith('# My Project'), 'existing content preserved');
assert(content2.includes(MARKER_START), 'marker block appended');

// Test: remove marker block
assert(removeMarkerBlock(file2) === true, 'remove returns true');
const content3 = fs.readFileSync(file2, 'utf8');
assert(!content3.includes(MARKER_START), 'marker removed');
assert(content3.includes('# My Project'), 'original content preserved after remove');

// Test: remove from file without marker
assert(removeMarkerBlock(file2) === false, 'remove with no marker returns false');

// Test: remove from non-existent file
const noFile = path.join(dir1, 'nope.md');
assert(removeMarkerBlock(noFile) === false, 'remove non-existent file returns false');

// ── Wrapper integration test ────────────────────────────────

console.log('\nwrapper integration:');

const wrapperPath = path.join(__dirname, 'pre-commit-wrapper.js');

function runWrapper(input) {
  try {
    const result = execSync(`node "${wrapperPath}"`, {
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

// Non-Bash tool passes through
const r1 = runWrapper({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, cwd: '/tmp' });
assert(r1.hookSpecificOutput.permissionDecision === 'allow', 'non-Bash tool allowed');

// Non-commit Bash command passes through
const r2 = runWrapper({ tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: '/tmp' });
assert(r2.hookSpecificOutput.permissionDecision === 'allow', 'non-commit bash allowed');

// git commit --no-verify passes through
const r3 = runWrapper({ tool_name: 'Bash', tool_input: { command: 'git commit --no-verify -m "x"' }, cwd: '/tmp' });
assert(r3.hookSpecificOutput.permissionDecision === 'allow', 'git commit --no-verify allowed');

// git commit with no staged files (pre-commit script exits 0)
const testRepo = tmpDir();
execSync('git init', { cwd: testRepo, stdio: 'pipe' });
const r4 = runWrapper({ tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' }, cwd: testRepo });
assert(r4.hookSpecificOutput.permissionDecision === 'allow', 'git commit with no staged files allowed');

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');

// Cleanup
fs.rmSync(dir1, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(testRepo, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
