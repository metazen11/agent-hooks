'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const s7 = require('../checks/s7-reversibility-gate.js');

const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's7-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  g(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  g(work, 'remote', 'add', 'origin', remote);
  g(work, 'push', '-q', 'origin', 'main');
  const tip = g(work, 'rev-parse', 'origin/main');
  g(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  return { work, tip };
}
const run = (cwd, command) => s7.check('Bash', { command }, { cwd });
const LEASE = 'git push --force-with-lease origin main';

test('lease push + backup tag at remote tip -> allow', () => {
  const { work, tip } = repo();
  g(work, 'tag', 'backup/pr-pre-rebase', tip);
  assert.strictEqual(run(work, LEASE).allow, true);
});
test('lease push, no tag -> deny with fix hint', () => {
  const { work } = repo();
  const r = run(work, LEASE);
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /git tag backup\/<name>/);
});
test('lease push, stale tag pointing elsewhere -> deny', () => {
  const { work } = repo();
  g(work, 'tag', 'backup/stale', 'HEAD');
  assert.strictEqual(run(work, LEASE).allow, false);
});
test('bare --force denied even with matching tag', () => {
  const { work, tip } = repo();
  g(work, 'tag', 'backup/x', tip);
  assert.strictEqual(run(work, 'git push --force origin main').allow, false);
  assert.strictEqual(run(work, 'git push -f origin main').allow, false);
});
test('reset --hard: tag at HEAD allows, none denies', () => {
  const { work } = repo();
  assert.strictEqual(run(work, 'git reset --hard HEAD~1').allow, false);
  g(work, 'tag', 'pre-reset-1', 'HEAD');
  assert.strictEqual(run(work, 'git reset --hard HEAD~1').allow, true);
});
test('branch -D: tag at branch tip allows', () => {
  const { work } = repo();
  g(work, 'branch', 'feat');
  assert.strictEqual(run(work, 'git branch -D feat').allow, false);
  g(work, 'tag', 'backup/feat', 'feat');
  assert.strictEqual(run(work, 'git branch -D feat').allow, true);
});
test('other categories unchanged: filesystem delete still denied with cwd', () => {
  const { work } = repo();
  assert.strictEqual(run(work, ['r', 'm -rf /tmp/x'].join('')).allow, false);
});
