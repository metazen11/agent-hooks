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

// ── review round 1: spoof resistance ────────────────────────
// main and dev on different commits; only origin/main is backed up.
function repo2() {
  const { work, tip } = repo();
  g(work, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
  g(work, 'fetch', '-q', 'origin');
  g(work, 'tag', 'backup/m', tip);
  g(work, 'commit', '-q', '--allow-empty', '-m', 'three');
  return { work, tip, dev: g(work, 'rev-parse', 'origin/dev') };
}
const BARE = 'git push --force';
const L = LEASE.replace(' origin main', '');

test('multi-refspec lease push with one unbacked branch -> deny', () => {
  const { work } = repo2();
  assert.strictEqual(run(work, `${L} origin main dev`).allow, false);
});
test('--all / --mirror / --tags / no-arg lease push -> deny', () => {
  const { work } = repo2();
  for (const c of [`${L} --all origin`, `${L} --mirror origin`, `${L} --tags origin main`, 'git push --force-with-lease']) {
    assert.strictEqual(run(work, c).allow, false, c);
  }
  assert.strictEqual(run(work, 'git push --force-with-lease origin').allow, false);
});
test('chained: backed lease push && bare force of other branch -> deny', () => {
  const { work } = repo2();
  assert.strictEqual(run(work, `${L} origin main`).allow, true);
  assert.strictEqual(run(work, `${L} origin main && ${BARE} origin dev`).allow, false);
  assert.strictEqual(run(work, `${L} origin main && ${L} origin dev`).allow, false);
});
test('cd / -C / --git-dir retargeting -> evidence ignored', () => {
  const { work } = repo2();
  g(work, 'tag', 'pre-head', 'HEAD');
  const reset = ['git reset', '--hard'].join(' ');
  assert.strictEqual(run(work, reset).allow, true);
  assert.strictEqual(run(work, `cd /tmp && ${reset}`).allow, false);
  assert.strictEqual(run(work, `git -C /tmp ${reset.slice(4)}`).allow, false);
  assert.strictEqual(run(work, `git --git-dir=/tmp/x ${reset.slice(4)}`).allow, false);
});
test('branch -D a b needs a tag at every tip', () => {
  const { work } = repo2();
  g(work, 'branch', 'a'); g(work, 'branch', 'b', 'HEAD~1');
  g(work, 'tag', 'backup/a', 'a');
  assert.strictEqual(run(work, 'git branch -D a b').allow, false);
  g(work, 'tag', 'backup/b', 'b');
  assert.strictEqual(run(work, 'git branch -D a b').allow, true);
});
test('explicit --force-with-lease=ref:sha needs tag at that sha', () => {
  const { work, tip, dev } = repo2();
  assert.strictEqual(run(work, `git push --force-with-lease=main:${tip} origin main`).allow, true);
  assert.strictEqual(run(work, `git push --force-with-lease=main:${dev} origin main`).allow, false);
});
test('reset with dirty worktree -> deny even with tag', () => {
  const { work } = repo2();
  g(work, 'tag', 'pre-head', 'HEAD');
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  g(work, 'add', 'f.txt');
  assert.strictEqual(run(work, ['git reset', '--hard'].join(' ')).allow, false);
});
test('value-taking push options shift positionals -> deny', () => {
  const { work } = repo2();
  assert.strictEqual(run(work, `${L} -o ci.skip origin main`).allow, false);
});

// ── review round 2 ──────────────────────────────────────────
test('B1: lease ref must name the pushed branch', () => {
  const { work, tip } = repo2();
  assert.strictEqual(run(work, `${L}=main:${tip} origin main`).allow, true);
  assert.strictEqual(run(work, `${L}=refs/heads/main:${tip} origin main`).allow, true);
  assert.strictEqual(run(work, `${L}=zzz:${tip} origin main`).allow, false);
  assert.strictEqual(run(work, `${L}=zzz origin main`).allow, false);
});
test('B2: more than one lease token -> deny', () => {
  const { work, tip, dev } = repo2();
  const F = '--force-with-lease';
  assert.strictEqual(run(work, `git push ${F}=main:${tip} ${F}=main:${dev} origin main`).allow, false);
  assert.strictEqual(run(work, `git push ${F} ${F} origin main`).allow, false);
});
test('B3: chained commands never get evidence', () => {
  const { work } = repo2();
  g(work, 'tag', 'pre-head', 'HEAD');
  const reset = ['git reset', '--hard'].join(' ');
  assert.strictEqual(run(work, reset).allow, true);
  for (const c of [
    `git tag -d pre-head && ${reset}`,
    `git checkout dev && ${reset}`,
    `${reset}; echo x`,
    `echo $(${reset})`,
    `GIT_DIR=/tmp/x ${reset}`,
    `pushd /tmp && ${reset}`,
    `${L}=main:abc origin main | cat`,
  ]) {
    assert.strictEqual(run(work, c).allow, false, c);
  }
});
test('deny-pattern gaps: +refspec, bundled -f, --mirror, trailing force', () => {
  const { work } = repo2();
  for (const c of ['git push origin +main', 'git push origin +feat:main', 'git push -fu origin main',
    'git push -uf origin main', 'git push --mirror origin', 'git push origin main --force']) {
    assert.strictEqual(run(work, c).allow, false, c);
  }
});
test('B4: newline-separated commands never get evidence', () => {
  const { work } = repo2();
  g(work, 'tag', 'pre-head', 'HEAD');
  g(work, 'branch', 'x', 'HEAD~1');
  const reset = ['git reset', '--hard HEAD~1'].join(' ');
  assert.strictEqual(run(work, reset).allow, true);
  assert.strictEqual(run(work, `${reset}\n`).allow, true); // trailing newline is still one command
  for (const c of [
    `${reset}\ngit branch -D x`,
    `${reset}\ngit push --force origin y`,
    `${reset}\r\ngit branch -D x`,
    `${L} origin main\ngit branch -D x`,
    `${L} origin main\r\n${reset}`,
  ]) {
    assert.strictEqual(run(work, c).allow, false, JSON.stringify(c));
  }
});
test('false-denial sweep: benign commands still allowed', () => {
  const { work } = repo2();
  for (const c of ['git push origin main', 'git push -u origin feat', 'git reset --soft HEAD~1',
    'git log --grep=reset', 'git commit -m "force push guard"', 'git push origin feature-f',
    'git push --set-upstream origin f-x']) {
    assert.strictEqual(run(work, c).allow, true, c);
  }
});

// ── stdin -> contracts-hook.js: pins cwd plumbing ───────────
function hook(cwd, command) {
  const out = execFileSync('node', [path.join(__dirname, '..', 'contracts-hook.js')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}
test('hook stdin: cwd reaches the check (allow with tag, deny without)', () => {
  const { work, tip } = repo();
  assert.strictEqual(hook(work, LEASE), 'deny');
  g(work, 'tag', 'backup/z', tip);
  assert.strictEqual(hook(work, LEASE), 'allow');
});
