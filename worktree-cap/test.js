'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ownerIntent, targetRepository, worktreeAdmission } = require('./worktree-cap.js');

const hook = path.join(__dirname, 'worktree-cap.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cap-test-'));
const fakeBin = path.join(temp, 'bin');
const state = path.join(temp, 'state');
fs.mkdirSync(fakeBin);
for (let i = 0; i < 8; i += 1) fs.mkdirSync(path.join(temp, `wt-${i}`));
const fakeGit = path.join(fakeBin, 'git');
fs.writeFileSync(fakeGit, `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) printf '%s\\n' '${temp}' ;;
  *"rev-parse --git-common-dir"*) printf '%s\\n' "\${WORKTREE_TEST_COMMON:-${temp}/.git}" ;;
  *"ls-remote origin refs/heads/main refs/heads/master refs/heads/dev refs/heads/develop"*)
    if [ "$WORKTREE_TEST_MODE" = remote-unavailable ]; then exit 1; fi
    if [ "$WORKTREE_TEST_MODE" = stale-origin ]; then
      printf 'dddddddddddddddddddddddddddddddddddddddd\\trefs/heads/main\\n'
      printf 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\\trefs/heads/dev\\n'
    else
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/main\\n'
      printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\trefs/heads/dev\\n'
    fi
    if [ "$WORKTREE_TEST_MODE" = ambiguous-policy ]; then printf 'cccccccccccccccccccccccccccccccccccccccc\\trefs/heads/develop\\n'; fi ;;
  *"rev-parse --verify --quiet refs/remotes/origin/main"*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
  *"rev-parse --verify --quiet refs/remotes/origin/develop"*) if [ "$WORKTREE_TEST_MODE" = ambiguous-policy ]; then printf 'cccccccccccccccccccccccccccccccccccccccc\\n'; else exit 1; fi ;;
  *"rev-parse --verify --quiet refs/remotes/origin/dev"*) printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' ;;
  *"symbolic-ref --quiet --short refs/remotes/origin/HEAD"*) printf 'origin/main\\n' ;;
  *"show refs/remotes/origin/main:.reconcile-gate.json"*)
    if [ "$WORKTREE_TEST_POLICY" = single-trunk ]; then printf '{"model":"single-trunk"}\\n';
    elif [ "$WORKTREE_TEST_POLICY" = malformed ]; then printf '{broken\\n';
    else exit 1; fi ;;
  *"status --porcelain --untracked-files=all"*)
    case "$*" in *"-C $WORKTREE_TEST_DIRTY_PATH status"*) printf '?? untracked.txt\\n';; esac ;;
  *"rev-list --count --merges refs/remotes/origin/dev..HEAD"*)
    case "$*" in *"-C $WORKTREE_TEST_MERGE_PATH rev-list"*) printf '1\\n';; *) printf '0\\n';; esac ;;
  *"rev-list --count refs/remotes/origin/dev..HEAD"*|*"rev-list --count refs/remotes/origin/main..HEAD"*)
    case "$*" in *"-C $WORKTREE_TEST_AHEAD_PATH rev-list"*) printf '2\\n';; *) printf '0\\n';; esac ;;
  *"merge-base"*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
  *"worktree list --porcelain"*)
    case "${'${WORKTREE_TEST_MODE:-normal}'}" in
      malformed) printf 'broken-record\\n';;
      missing) exit 1;;
      *) count="${'${WORKTREE_TEST_COUNT:-4}' }"; if [ -n "$WORKTREE_TEST_COUNT_FILE" ]; then count=$(cat "$WORKTREE_TEST_COUNT_FILE"); fi; i=0; while [ "$i" -lt "$count" ]; do printf 'worktree ${temp}/wt-%s\\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n\\n' "$i"; i=$((i+1)); done ;;
    esac ;;
  *) exit 0 ;;
esac
`);
fs.mkdirSync(path.join(temp, '.git'));
fs.mkdirSync(path.join(temp, 'other.git'));
fs.chmodSync(fakeGit, 0o755);

const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, XDG_STATE_HOME: state };
const session = 'test-session-abcdef';
const turn = 'test-turn-123456';
const prompt = { session_id: session, turn_id: turn, cwd: temp, prompt: 'I authorize creating a worktree for this task.' };

function call(event, input, extra = {}, home) {
  return spawnSync(process.execPath, [hook, event], { input: JSON.stringify(input), env: { ...env, ...extra, ...(home ? { HOME: home } : {}) }, encoding: 'utf8' });
}
function callAsync(event, input, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [hook, event], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
function missingPayload(event) {
  return spawnSync(process.execPath, [hook, event], { input: '', env, encoding: 'utf8' });
}
function authorize(sess = session, t = turn, cwd = temp, extra = {}) {
  const result = call('codex-user-prompt', { ...prompt, session_id: sess, turn_id: t, cwd }, extra);
  assert.equal(result.status, 0, `Codex owner-intent hook failed for ${sess}: ${result.stderr}`);
  return result;
}
function preflight(sess = session, t = turn, fields = {}, extra = {}) {
  return call('codex', {
    session_id: sess, turn_id: t, tool_use_id: `tool-${sess}`, cwd: temp, tool_name: 'Bash',
    tool_input: { command: 'git worktree add ../new-wt' }, ...fields,
  }, extra);
}
function post(sess = session, fields = {}) {
  return call('post-tool', { session_id: sess, tool_use_id: `tool-${sess}`, cwd: temp, tool_name: 'Bash', tool_input: { command: 'git worktree add ../new-wt' }, ...fields });
}
function claudePre(sess, input = {}) {
  return call('claude-pretool', { session_id: sess, tool_use_id: `tool-${sess}`, cwd: temp, tool_name: 'Bash', tool_input: { command: 'git worktree add ../new-wt' }, ...input });
}
function output(result) { try { return JSON.parse(result.stdout); } catch { return {}; } }
function denial(result) { return output(result).hookSpecificOutput?.permissionDecision === 'deny'; }

let fixtureSequence = 0;
function installerFixture() {
  const home = path.join(temp, `home-${++fixtureSequence}`);
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const claudeLink = path.join(claudeDir, 'hooks', 'worktree-cap.js');
  const codexLink = path.join(codexDir, 'hooks', 'worktree-cap.js');
  const claude = {
    keep: true,
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: `node "${claudeLink}" claude-pretool` },
        { type: 'command', command: 'node unrelated.js' },
      ] }],
    },
  };
  const codex = { keep: 'yes', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: `node "${codexLink}" codex` },
    { type: 'command', command: 'node codex-unrelated.js' },
  ] }] } };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), `${JSON.stringify(claude, null, 2)}\n`);
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), `${JSON.stringify(codex, null, 2)}\n`);
  const fixtureEnv = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, '.state') };
  const run = () => spawnSync(process.execPath, [path.join(__dirname, 'install.js'), 'install'], { env: fixtureEnv, encoding: 'utf8' });
  const failSecondWrite = (failRollback = false) => {
    const script = `const fs=require('node:fs'); const original=fs.renameSync; let codexFailed=false; let claudeCount=0; fs.renameSync=function(from,to){ if(to.endsWith('/.codex/hooks.json') && !codexFailed) { codexFailed=true; const e=new Error('injected second config write failure'); e.code='EIO'; throw e; } if(${failRollback} && to.endsWith('/.claude/settings.json') && ++claudeCount===2) { const e=new Error('injected first config rollback failure'); e.code='EIO'; throw e; } return original.call(this,from,to); }; process.env.HOME=${JSON.stringify(home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.install(); } catch (e) { console.error(e.message); process.exitCode=1; }`;
    return spawnSync(process.execPath, ['-e', script], { env: fixtureEnv, encoding: 'utf8' });
  };
  const failUninstallLink = () => {
    const script = `const fs=require('node:fs'); const original=fs.unlinkSync; let failed=false; fs.unlinkSync=function(file){ if(!failed && file.endsWith('/.codex/hooks/worktree-cap.js')) { failed=true; const e=new Error('injected second link removal failure'); e.code='EIO'; throw e; } return original.call(this,file); }; process.env.HOME=${JSON.stringify(home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.uninstall(); } catch (e) { console.error(e.message); process.exitCode=1; }`;
    return spawnSync(process.execPath, ['-e', script], { env: fixtureEnv, encoding: 'utf8' });
  };
  const editCodexDuringInstall = () => {
    const script = `const fs=require('node:fs'); const original=fs.renameSync; let edited=false; fs.renameSync=function(from,to){ const result=original.call(this,from,to); if(!edited && to.endsWith('/.claude/settings.json')) { edited=true; const file=${JSON.stringify(path.join(codexDir, 'hooks.json'))}; const value=JSON.parse(fs.readFileSync(file,'utf8')); value.concurrentEdit='preserve'; fs.writeFileSync(file,JSON.stringify(value,null,2)+'\\n'); } return result; }; process.env.HOME=${JSON.stringify(home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.install(); } catch (e) { console.error(e.message); process.exitCode=1; }`;
    return spawnSync(process.execPath, ['-e', script], { env: fixtureEnv, encoding: 'utf8' });
  };
  const editClaudeBeforeRollback = () => {
    const script = `const fs=require('node:fs'); const original=fs.renameSync; let edited=false; fs.renameSync=function(from,to){ const result=original.call(this,from,to); if(!edited && to.endsWith('/.claude/settings.json')) { edited=true; const value=JSON.parse(fs.readFileSync(to,'utf8')); value.concurrentEdit='preserve'; fs.writeFileSync(to,JSON.stringify(value,null,2)+'\\n'); } return result; }; process.env.HOME=${JSON.stringify(home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.install(); } catch (e) { console.error(e.message); process.exitCode=1; }`;
    return spawnSync(process.execPath, ['-e', script], { env: fixtureEnv, encoding: 'utf8' });
  };
  const runWithLock = () => {
    const lock = path.join(home, '.state', 'worktree-cap', 'installer.lock');
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 1, nonce: 'active' }), { mode: 0o600 });
    return spawnSync(process.execPath, [path.join(__dirname, 'install.js'), 'install'], { env: fixtureEnv, encoding: 'utf8' });
  };
  const failInstallerOwnerWrite = () => {
    const script = `const fs=require('node:fs'); const original=fs.writeFileSync; fs.writeFileSync=function(file,...args){ if(file.endsWith('/installer.lock/owner.json')) throw new Error('injected owner write failure'); return original.call(this,file,...args); }; process.env.HOME=${JSON.stringify(home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.install(); } catch (e) { console.error(e.message); process.exitCode=1; }`;
    return spawnSync(process.execPath, ['-e', script], { env: fixtureEnv, encoding: 'utf8' });
  };
  return { home, claude, codex, claudeDir, codexDir, claudeLink, codexLink, run, failSecondWrite, failUninstallLink, editCodexDuringInstall, editClaudeBeforeRollback, runWithLock, failInstallerOwnerWrite };
}

async function runTests() {
try {
  for (const instructionFile of ['AGENTS.md', 'CLAUDE.md']) {
    const agentInstructions = fs.readFileSync(path.join(__dirname, '..', instructionFile), 'utf8');
    assert.match(agentInstructions, /reuse the task's assigned\s+existing checkout by default/i,
      `${instructionFile} defaults to assigned-checkout reuse`);
    assert.match(agentInstructions, /separate worktree is\s+an exception/i,
      `${instructionFile} makes separate worktrees exceptional`);
    assert.match(agentInstructions, /installed `worktree-cap` guard[^.]*five-total limit/i,
      `${instructionFile} binds worktree exceptions to the five-tree guard`);
    assert.doesNotMatch(agentInstructions, /use\s+one\s+isolated\s+worktree\s+per\s+overlapping\s+task/i,
      `${instructionFile} must not restore worktree creation as the default`);
  }

  const repoA = path.join(temp, 'repo-a');
  const repoB = path.join(temp, 'repo-b');
  assert.equal(targetRepository({ cwd: temp, tool_input: { command: `git -C ${repoA} -C ../repo-b worktree add ../new-wt` } }).cwd,
    repoB, 'repeated relative -C resolves each path from the previous Git checkout');

  assert.equal(ownerIntent('Use an isolated worktree for this task.'), true, 'natural imperative owner request needs no special marker');
  assert.equal(ownerIntent('Should I create a worktree?'), false, 'a question does not authorize creation');
  authorize();
  const allowed = preflight();
  assert.equal(allowed.status, 0);
  assert.equal(denial(allowed), false, `count 4 is allowed: ${JSON.stringify(output(allowed))}`);
  post();

  authorize('zero-count-session');
  const zeroCount = preflight('zero-count-session', turn, {}, { WORKTREE_TEST_COUNT: '0' });
  assert.equal(denial(zeroCount), false, 'count 0 is allowed by the explicit cap boundary');
  post('zero-count-session');

  authorize('primary-only-session');
  const primaryOnly = preflight('primary-only-session', turn, {}, {
    WORKTREE_TEST_COUNT: '1', WORKTREE_TEST_DIRTY_PATH: path.join(temp, 'wt-0'),
  });
  assert.equal(denial(primaryOnly), false, 'primary-only count is allowed and primary dirt is excluded from the reconcile blocker');
  post('primary-only-session');

  authorize('primary-policy-unverified-session');
  const primaryPolicyUnverified = preflight('primary-policy-unverified-session', turn, {}, {
    WORKTREE_TEST_COUNT: '1', WORKTREE_TEST_MODE: 'remote-unavailable',
  });
  assert.equal(denial(primaryPolicyUnverified), true, 'primary-only repository still requires verified origin policy');

  authorize('dirty-primary-session');
  assert.equal(denial(preflight('dirty-primary-session', turn, {}, { WORKTREE_TEST_DIRTY_PATH: path.join(temp, 'wt-0') })), false,
    'primary worktree dirt does not block a new checkout');
  post('dirty-primary-session');

  authorize('dirty-child-session');
  const dirtyPath = path.join(temp, 'wt-1');
  const dirtyChild = preflight('dirty-child-session', turn, {}, { WORKTREE_TEST_DIRTY_PATH: dirtyPath });
  assert.equal(denial(dirtyChild), true, 'dirty non-primary worktree blocks a new checkout');
  assert.ok(output(dirtyChild).hookSpecificOutput.permissionDecisionReason.includes(`${dirtyPath} (dirty)`));

  authorize('unlanded-child-session');
  const unlandedChild = preflight('unlanded-child-session', turn, {}, { WORKTREE_TEST_AHEAD_PATH: path.join(temp, 'wt-2') });
  assert.equal(denial(unlandedChild), true, 'unlanded non-primary commits block a new checkout');
  const legacyUnlandedReason = output(unlandedChild).hookSpecificOutput.permissionDecisionReason;
  assert.match(legacyUnlandedReason, /2 commit\(s\) not verified on refs\/remotes\/origin\/dev/);
  assert.match(legacyUnlandedReason, /legacy two-trunk repository.*\/reconcile to dev/);

  authorize('single-trunk-unlanded-session');
  const singleTrunkUnlanded = preflight('single-trunk-unlanded-session', turn, {}, {
    WORKTREE_TEST_POLICY: 'single-trunk', WORKTREE_TEST_AHEAD_PATH: path.join(temp, 'wt-1'),
  });
  assert.equal(denial(singleTrunkUnlanded), true);
  const singleTrunkReason = output(singleTrunkUnlanded).hookSpecificOutput.permissionDecisionReason;
  assert.match(singleTrunkReason, /single-trunk repository.*feature-branch squash PR to main/);
  assert.doesNotMatch(singleTrunkReason, /\/reconcile/);

  authorize('merge-only-child-session');
  const mergeOnlyChild = preflight('merge-only-child-session', turn, {}, {
    WORKTREE_TEST_AHEAD_PATH: path.join(temp, 'wt-3'), WORKTREE_TEST_MERGE_PATH: path.join(temp, 'wt-3'),
  });
  assert.equal(denial(mergeOnlyChild), true, 'merge-only unlanded worktree is not admitted by empty git-cherry output');

  const unrelatedShell = call('codex', {
    session_id: 'unrelated-shell-session', turn_id: turn, tool_use_id: 'unrelated-shell-tool',
    cwd: temp, tool_name: 'Bash', tool_input: { command: 'printf unrelated-command' },
  });
  assert.equal(unrelatedShell.status, 0);
  assert.equal(denial(unrelatedShell), false, 'unrelated shell command is not intercepted by worktree guard');

  authorize('ambiguous-trunk-session');
  assert.equal(denial(preflight('ambiguous-trunk-session', turn, {}, { WORKTREE_TEST_MODE: 'ambiguous-policy' })), true,
    'ambiguous integration-trunk policy fails closed');

  authorize('remote-unavailable-session');
  assert.equal(denial(preflight('remote-unavailable-session', turn, {}, { WORKTREE_TEST_MODE: 'remote-unavailable' })), true,
    'unavailable origin readback fails closed');

  authorize('stale-origin-session');
  assert.equal(denial(preflight('stale-origin-session', turn, {}, { WORKTREE_TEST_MODE: 'stale-origin' })), true,
    'stale remote-tracking refs fail closed');

  authorize('malformed-policy-session');
  assert.equal(denial(preflight('malformed-policy-session', turn, {}, { WORKTREE_TEST_POLICY: 'malformed' })), true,
    'malformed single-trunk policy fails closed');

  authorize('single-trunk-session');
  assert.equal(denial(preflight('single-trunk-session', turn, {}, { WORKTREE_TEST_POLICY: 'single-trunk' })), false,
    'verified single-trunk policy uses production trunk');
  post('single-trunk-session');

  const actual = path.join(temp, 'squash-merge-fixture');
  const bare = path.join(actual, 'origin.git');
  const primary = path.join(actual, 'primary');
  const feature = path.join(actual, 'feature');
  fs.mkdirSync(actual, { recursive: true });
  function realGit(args, cwd = actual) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  realGit(['init', '--bare', '--initial-branch=main', bare]);
  realGit(['init', '--initial-branch=main', primary]);
  realGit(['config', 'user.name', 'Worktree Test'], primary);
  realGit(['config', 'user.email', 'worktree-test@example.invalid'], primary);
  fs.writeFileSync(path.join(primary, 'seed.txt'), 'seed\n');
  realGit(['add', 'seed.txt'], primary);
  realGit(['commit', '-m', 'seed'], primary);
  realGit(['remote', 'add', 'origin', bare], primary);
  realGit(['push', '-u', 'origin', 'main'], primary);
  realGit(['checkout', '-b', 'dev'], primary);
  realGit(['push', '-u', 'origin', 'dev'], primary);
  realGit(['worktree', 'add', '-b', 'feature', feature, 'dev'], primary);
  realGit(['config', 'user.name', 'Worktree Test'], feature);
  realGit(['config', 'user.email', 'worktree-test@example.invalid'], feature);
  fs.writeFileSync(path.join(feature, 'candidate.txt'), 'first line\n');
  realGit(['add', 'candidate.txt'], feature);
  realGit(['commit', '-m', 'candidate first change'], feature);
  fs.writeFileSync(path.join(feature, 'candidate.txt'), 'first line\nsecond line\n');
  realGit(['add', 'candidate.txt'], feature);
  realGit(['commit', '-m', 'candidate second change'], feature);
  fs.writeFileSync(path.join(primary, 'candidate.txt'), 'first line\nsecond line\n');
  realGit(['add', 'candidate.txt'], primary);
  realGit(['commit', '-m', 'squashed candidate'], primary);
  realGit(['push', 'origin', 'dev'], primary);
  fs.writeFileSync(path.join(primary, 'later.txt'), 'unrelated trunk change\n');
  realGit(['add', 'later.txt'], primary);
  realGit(['commit', '-m', 'later trunk change'], primary);
  realGit(['push', 'origin', 'dev'], primary);
  realGit(['fetch', 'origin'], primary);
  const actualCommon = fs.realpathSync(path.join(primary, '.git'));
  assert.equal(worktreeAdmission(actualCommon), null,
    'clean two-commit feature worktree is admitted after its squash merge and later unrelated trunk commit');

  const mergeFeature = path.join(actual, 'merge-feature');
  realGit(['worktree', 'add', '-b', 'merge-feature', mergeFeature, 'origin/dev'], primary);
  realGit(['config', 'user.name', 'Worktree Test'], mergeFeature);
  realGit(['config', 'user.email', 'worktree-test@example.invalid'], mergeFeature);
  fs.writeFileSync(path.join(mergeFeature, 'feature-side.txt'), 'feature side\n');
  realGit(['add', 'feature-side.txt'], mergeFeature);
  realGit(['commit', '-m', 'feature side'], mergeFeature);
  const sideBranch = path.join(actual, 'side-branch');
  realGit(['worktree', 'add', '-b', 'merge-side', sideBranch, 'origin/dev'], primary);
  realGit(['config', 'user.name', 'Worktree Test'], sideBranch);
  realGit(['config', 'user.email', 'worktree-test@example.invalid'], sideBranch);
  fs.writeFileSync(path.join(sideBranch, 'other-side.txt'), 'other side\n');
  realGit(['add', 'other-side.txt'], sideBranch);
  realGit(['commit', '-m', 'other side'], sideBranch);
  realGit(['merge', '--no-ff', '--no-edit', 'merge-side'], mergeFeature);
  const actualAdmission = worktreeAdmission(actualCommon);
  assert.match(actualAdmission || '', /merge-feature .*not verified/,
    'clean squash-merged feature is accepted but merge-only unlanded checkout still blocks');
  assert.equal((actualAdmission || '').includes(`${feature} (`), false,
    'squash-merged checkout is absent from unresolved worktree blockers');
  assert.equal(denial(preflight('no-owner-session')), true, 'private worktree request without owner-intent token is denied');

  const agentSession = 'agent-isolation-session';
  authorize(agentSession);
  const agentCall = preflight(agentSession, turn, { tool_name: 'Agent', tool_input: { isolation: 'worktree' } });
  assert.equal(denial(agentCall), false, 'Codex Agent worktree isolation is recognized');
  post(agentSession, { tool_name: 'Agent', tool_input: { isolation: 'worktree' } });
  const multi = preflight('multi-add-session', turn, { tool_input: { command: 'git worktree add ../a && git worktree add ../b' } });
  assert.equal(denial(multi), true, 'multiple direct adds in one call are rejected');

  for (const [name, command] of [
    ['equals', `git --git-dir=${path.join(temp, '.git')} worktree add ../new-wt`],
    ['separate argument', `git --git-dir ${path.join(temp, '.git')} worktree add ../new-wt`],
    ['combined target options', `git -C ${temp} --git-dir ${path.join(temp, '.git')} worktree add ../new-wt`],
    ['absolute executable', '/usr/bin/git worktree add ../new-wt'],
    ['command absolute executable', 'command /usr/bin/git worktree add ../new-wt'],
  ]) {
    const sess = `git-dir-${name.replaceAll(' ', '-')}`;
    authorize(sess);
    const result = preflight(sess, turn, { tool_input: { command } }, { WORKTREE_TEST_COUNT: '5' });
    assert.equal(denial(result), true, `explicit --git-dir form is denied at the cap (${name})`);
  }

  authorize('unparsed-git-options-session');
  const unparsedGitOptions = preflight('unparsed-git-options-session', turn,
    { tool_input: { command: 'git --future-option worktree add ../new-wt' } }, { WORKTREE_TEST_COUNT: '5' });
  assert.equal(denial(unparsedGitOptions), true, 'unparsed Git options fail closed for worktree creation');

  authorize('git-dir-env-session');
  const gitDirEnv = preflight('git-dir-env-session', turn,
    { tool_input: { command: `GIT_DIR=${path.join(temp, '.git')} git worktree add ../new-wt` } });
  assert.equal(denial(gitDirEnv), true, 'environment-selected Git directories fail closed');

  authorize('git-common-dir-env-session');
  const gitCommonDirEnv = preflight('git-common-dir-env-session', turn,
    { tool_input: { command: `GIT_COMMON_DIR=${path.join(temp, 'other.git')} git worktree add ../new-wt` } });
  assert.equal(denial(gitCommonDirEnv), true, 'environment-selected Git common directories fail closed');

  const claudeShellSession = 'claude-shell-session';
  call('claude-user-prompt', { session_id: claudeShellSession, cwd: temp, prompt: 'I authorize creating a worktree.' });
  assert.equal(denial(claudePre(claudeShellSession)), false, 'Claude direct shell creation is guarded');
  call('claude-post-tool', { session_id: claudeShellSession, tool_use_id: `tool-${claudeShellSession}`, cwd: temp });

  for (const count of ['5', '6']) {
    const sess = `count-${count}-session`;
    authorize(sess);
    const rejected = preflight(sess, turn, {}, { WORKTREE_TEST_COUNT: count });
    assert.equal(denial(rejected), true, `count ${count} is denied`);
    assert.match(output(rejected).hookSpecificOutput.permissionDecisionReason, new RegExp(`${count}/${count === '5' ? '5' : '5'}`));
  }

  authorize('delegated-session');
  assert.equal(denial(preflight('delegated-session', turn, { agent_id: 'subagent-1' })), true);
  authorize('wrong-turn-session', turn);
  assert.equal(denial(preflight('wrong-turn-session', 'another-turn')), true, 'Codex token is turn-bound');
  authorize('different-repo-session', turn);
  assert.equal(denial(preflight('different-repo-session', turn, {}, { WORKTREE_TEST_COMMON: `${temp}/other.git` })), true, 'token is bound to Git common dir');

  authorize('malformed-session');
  assert.equal(denial(preflight('malformed-session', turn, {}, { WORKTREE_TEST_MODE: 'malformed' })), true);
  authorize('missing-count-session');
  assert.equal(denial(preflight('missing-count-session', turn, {}, { WORKTREE_TEST_MODE: 'missing' })), true);
  assert.equal(denial(missingPayload('codex')), true, 'missing payload fails closed');
  assert.equal(denial(call('codex', 'not-json')), true, 'malformed payload fails closed');

  const expiredAuthorization = authorize('expired-session');
  assert.equal(expiredAuthorization.status, 0, 'expired-session authorization is written before expiry simulation');
  const canonicalCommonDir = fs.realpathSync(path.join(temp, '.git'));
  const hash = crypto.createHash('sha256').update(`${canonicalCommonDir}\0expired-session\0${turn}`).digest('hex');
  const tokenPath = path.join(state, 'worktree-cap', `auth-${hash}.json`);
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  token.expires = Date.now() - 1;
  fs.writeFileSync(tokenPath, JSON.stringify(token));
  assert.equal(denial(preflight('expired-session')), true);

  authorize('replay-session');
  assert.equal(denial(preflight('replay-session')), false);
  post('replay-session');
  assert.equal(denial(preflight('replay-session')), true, 'token cannot be replayed');
  authorize('replay-session', 'later-turn');
  const later = preflight('replay-session', 'later-turn');
  assert.equal(denial(later), false, 'later authorization is not blocked by consumed token');
  post('replay-session');

  const lockSession = 'lock-session';
  authorize(lockSession);
  const held = preflight(lockSession);
  assert.equal(denial(held), false);
  const activeLock = path.join(temp, '.git', 'worktree-cap.lock');
  assert.equal(fs.statSync(activeLock).mode & 0o777, 0o700, 'lock directory uses 0700 permissions');
  assert.equal(fs.statSync(path.join(activeLock, 'owner.json')).mode & 0o777, 0o600, 'lock owner file uses 0600 permissions');
  const concurrent = preflight('concurrent-session');
  assert.equal(denial(concurrent), true, 'repository lock serializes preflight through tool completion');
  post(lockSession);
  authorize('concurrent-session');
  assert.equal(denial(preflight('concurrent-session')), false, 'PostToolUse releases the lock');
  post('concurrent-session');

  const sharedCount = path.join(temp, 'shared-worktree-count');
  fs.writeFileSync(sharedCount, '4');
  const parallelSessions = ['parallel-session-a', 'parallel-session-b'];
  for (const sess of parallelSessions) authorize(sess);
  const parallelCalls = parallelSessions.map(sess => callAsync('codex', {
    session_id: sess, turn_id: turn, tool_use_id: `tool-${sess}`, cwd: temp, tool_name: 'Bash',
    tool_input: { command: 'git worktree add ../parallel-wt' },
  }, { WORKTREE_TEST_COUNT_FILE: sharedCount }));
  const parallelResults = await Promise.all(parallelCalls);
  const authorizedIndexes = parallelResults.map((result, index) => denial(result) ? -1 : index).filter(index => index >= 0);
  assert.equal(authorizedIndexes.length, 1, 'only one concurrent request obtains the repo lock at count 4');
  const authorizedSession = parallelSessions[authorizedIndexes[0]];
  fs.writeFileSync(sharedCount, '5');
  post(authorizedSession);
  assert.equal(fs.readFileSync(sharedCount, 'utf8'), '5', 'single authorized creation advances count only to cap');
  const sixthSession = 'parallel-session-sixth';
  authorize(sixthSession);
  assert.equal(denial(preflight(sixthSession, turn, {}, { WORKTREE_TEST_COUNT_FILE: sharedCount })), true, 'count 5 prevents an additional creation');
  assert.equal(fs.readFileSync(sharedCount, 'utf8'), '5', 'concurrent path cannot exceed five');

  const staleSession = 'stale-lock-session';
  const staleLock = path.join(temp, '.git', 'worktree-cap.lock');
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({ created: Date.now() - 31 * 60 * 1000, session: 'old', tool_use_id: 'old-tool' }));
  authorize(staleSession);
  assert.equal(denial(preflight(staleSession)), true, 'old lock is not reclaimed by age alone');
  assert.equal(fs.existsSync(staleLock), true, 'lock remains valid until completion or explicit recovery');
  fs.rmSync(staleLock, { recursive: true });
  assert.equal(denial(preflight(staleSession)), false, 'request can proceed after explicit stale-lock recovery');
  post(staleSession);

  const claudeHome = path.join(temp, 'claude-home');
  const claudeSession = 'claude-native-session';
  const claudePrompt = { session_id: claudeSession, cwd: temp, prompt: 'I authorize creating a worktree now.' };
  call('claude-user-prompt', claudePrompt);
  const native = call('claude-worktree-create', { session_id: claudeSession, cwd: temp, name: 'native-task' }, {}, claudeHome);
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, path.join(claudeHome, '.claude', 'worktrees', path.basename(temp), 'native-task') + '\n');
  assert.equal(fs.existsSync(staleLock), false, 'native creation releases repo lock');
  const nativeCapSession = 'claude-cap-session';
  call('claude-user-prompt', { session_id: nativeCapSession, cwd: temp, prompt: 'I authorize creating another worktree.' });
  const capFailure = call('claude-worktree-create', { session_id: nativeCapSession, cwd: temp, name: 'over-cap' }, { WORKTREE_TEST_COUNT: '5' }, claudeHome);
  assert.notEqual(capFailure.status, 0, 'native creation rejects at cap');
  assert.equal(fs.existsSync(staleLock), false, 'native failure releases repo lock');

  const freshCodex = installerFixture();
  fs.unlinkSync(path.join(freshCodex.codexDir, 'hooks.json'));
  const freshCodexInstall = freshCodex.run();
  assert.equal(freshCodexInstall.status, 0, freshCodexInstall.stderr);
  const createdCodexConfig = path.join(freshCodex.codexDir, 'hooks.json');
  const createdCodex = JSON.parse(fs.readFileSync(createdCodexConfig, 'utf8'));
  assert(createdCodex.hooks.PreToolUse.some(group => group.matcher === 'spawn_agent|Agent|Task|Bash'));
  assert.equal(fs.statSync(createdCodexConfig).mode & 0o777, 0o600, 'new Codex hooks config uses private permissions');
  assert.equal(fs.realpathSync(freshCodex.codexLink), fs.realpathSync(hook));

  const missingCodexConflict = installerFixture();
  fs.unlinkSync(path.join(missingCodexConflict.codexDir, 'hooks.json'));
  fs.mkdirSync(path.dirname(missingCodexConflict.codexLink), { recursive: true });
  fs.writeFileSync(missingCodexConflict.codexLink, 'operator-owned file');
  const conflictClaude = fs.readFileSync(path.join(missingCodexConflict.claudeDir, 'settings.json'));
  assert.notEqual(missingCodexConflict.run().status, 0, 'conflicting Codex hook path aborts fresh install');
  assert.deepEqual(fs.readFileSync(path.join(missingCodexConflict.claudeDir, 'settings.json')), conflictClaude);
  assert.equal(fs.existsSync(missingCodexConflict.claudeLink), false, 'fresh-install failure removes the newly created Claude link');
  assert.equal(fs.readFileSync(missingCodexConflict.codexLink, 'utf8'), 'operator-owned file');
  assert.equal(fs.existsSync(path.join(missingCodexConflict.codexDir, 'hooks.json')), false);

  const fixture = installerFixture();
  const firstInstall = fixture.run();
  assert.equal(firstInstall.status, 0, firstInstall.stderr);
  const claudeAfter = JSON.parse(fs.readFileSync(path.join(fixture.claudeDir, 'settings.json'), 'utf8'));
  const mixed = claudeAfter.hooks.PreToolUse.find(group => group.matcher === 'Bash');
  assert(mixed.hooks.some(entry => entry.command === 'node unrelated.js'), 'unrelated hook remains in shared group');
  assert.equal(mixed.matcher, 'Bash', 'existing matcher remains unchanged');
  assert(fs.existsSync(fixture.claudeLink) && fs.realpathSync(fixture.claudeLink) === fs.realpathSync(hook));
  assert(fs.existsSync(fixture.codexLink) && fs.realpathSync(fixture.codexLink) === fs.realpathSync(hook));
  const afterFirst = [
    JSON.parse(fs.readFileSync(path.join(fixture.claudeDir, 'settings.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(fixture.codexDir, 'hooks.json'), 'utf8')),
  ];
  assert(afterFirst[1].hooks.PreToolUse.some(group => group.matcher === 'spawn_agent|Agent|Task|Bash'));
  const codexShared = afterFirst[1].hooks.PreToolUse.find(group => group.matcher === 'Bash');
  assert.equal(codexShared.hooks.length, 1);
  assert.equal(codexShared.hooks[0].command, 'node codex-unrelated.js');
  const secondInstall = fixture.run();
  assert.equal(secondInstall.status, 0, secondInstall.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.claudeDir, 'settings.json'), 'utf8')), afterFirst[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.codexDir, 'hooks.json'), 'utf8')), afterFirst[1]);
  const backups = fs.readdirSync(fixture.claudeDir).filter(name => name.includes('worktree-cap.backup-'));
  assert(backups.length >= 1);
  assert.equal(fs.statSync(path.join(fixture.claudeDir, backups[0])).mode & 0o777, 0o600);
  assert(fs.readdirSync(fixture.codexDir).some(name => name.includes('worktree-cap.backup-')), 'both global configs are backed up before writes');

  const rollback = installerFixture();
  const rollbackClaude = fs.readFileSync(path.join(rollback.claudeDir, 'settings.json'));
  const rollbackCodex = fs.readFileSync(path.join(rollback.codexDir, 'hooks.json'));
  assert.notEqual(rollback.failSecondWrite().status, 0, 'injected second settings write fails');
  assert.deepEqual(fs.readFileSync(path.join(rollback.claudeDir, 'settings.json')), rollbackClaude, 'first settings write rolls back');
  assert.deepEqual(fs.readFileSync(path.join(rollback.codexDir, 'hooks.json')), rollbackCodex, 'second settings remain intact');
  assert.equal(fs.existsSync(rollback.claudeLink), false, 'new symlink is removed after rollback');

  const missingCodexRollback = installerFixture();
  fs.unlinkSync(path.join(missingCodexRollback.codexDir, 'hooks.json'));
  const missingRollbackClaude = fs.readFileSync(path.join(missingCodexRollback.claudeDir, 'settings.json'));
  assert.notEqual(missingCodexRollback.failSecondWrite().status, 0, 'failed install with absent Codex config is reported');
  assert.deepEqual(fs.readFileSync(path.join(missingCodexRollback.claudeDir, 'settings.json')), missingRollbackClaude);
  assert.equal(fs.existsSync(path.join(missingCodexRollback.codexDir, 'hooks.json')), false, 'rollback removes a newly created Codex config');
  assert.equal(fs.existsSync(missingCodexRollback.codexLink), false);
  assert.equal(fs.readdirSync(missingCodexRollback.codexDir).some(name => name.endsWith('.tmp')), false, 'rollback removes the failed atomic-write temp file');

  const occupiedTemp = installerFixture();
  const occupiedTempScript = `const fs=require('node:fs'); const path=require('node:path'); const config=${JSON.stringify(path.join(occupiedTemp.codexDir, 'hooks.json'))}; const temp=config+'.'+process.pid+'.tmp'; fs.writeFileSync(temp,'operator-owned temp',{flag:'wx'}); process.env.HOME=${JSON.stringify(occupiedTemp.home)}; process.env.XDG_STATE_HOME=${JSON.stringify(path.join(occupiedTemp.home, '.state'))}; const installer=require(${JSON.stringify(path.join(__dirname, 'install.js'))}); try { installer.install(); process.exitCode=1; } catch (e) { if (e.code==='EEXIST' && fs.readFileSync(temp,'utf8')==='operator-owned temp') process.exitCode=0; else { console.error(e.message); process.exitCode=2; } }`;
  const occupiedTempResult = spawnSync(process.execPath, ['-e', occupiedTempScript], { env: process.env, encoding: 'utf8' });
  assert.equal(occupiedTempResult.status, 0, occupiedTempResult.stderr || 'installer preserves a pre-existing atomic-write temp file');

  const incomplete = installerFixture();
  const failedInstall = incomplete.failSecondWrite(true);
  assert.notEqual(failedInstall.status, 0, 'second write and first rollback failure are reported');
  assert.match(failedInstall.stderr, /readback:/, 'partial install includes settings and link readback');
  assert(fs.existsSync(incomplete.claudeLink) && fs.realpathSync(incomplete.claudeLink) === fs.realpathSync(hook), 'hook link remains for partially installed settings');
  const partialClaude = JSON.parse(fs.readFileSync(path.join(incomplete.claudeDir, 'settings.json'), 'utf8'));
  assert(partialClaude.hooks.PreToolUse.some(group => group.hooks.some(entry => entry.command === `node "${incomplete.claudeLink}" claude-pretool`)), 'remaining Claude registration is confirmed readable');

  const uninstallFailure = installerFixture();
  assert.equal(uninstallFailure.run().status, 0);
  assert.notEqual(uninstallFailure.failUninstallLink().status, 0, 'uninstall link failure is reported');
  for (const link of [uninstallFailure.claudeLink, uninstallFailure.codexLink]) {
    assert(fs.existsSync(link) && fs.realpathSync(link) === fs.realpathSync(hook), 'removed link is restored when settings roll back');
  }
  const restoredClaude = JSON.parse(fs.readFileSync(path.join(uninstallFailure.claudeDir, 'settings.json'), 'utf8'));
  const restoredCodex = JSON.parse(fs.readFileSync(path.join(uninstallFailure.codexDir, 'hooks.json'), 'utf8'));
  assert(restoredClaude.hooks.PreToolUse.some(group => group.hooks.some(entry => entry.command === `node "${uninstallFailure.claudeLink}" claude-pretool`)));
  assert(restoredCodex.hooks.PreToolUse.some(group => group.hooks.some(entry => entry.command === `node "${uninstallFailure.codexLink}" codex`)));

  const invalid = installerFixture();
  const originalClaude = fs.readFileSync(path.join(invalid.claudeDir, 'settings.json'));
  fs.writeFileSync(path.join(invalid.codexDir, 'hooks.json'), '{broken json');
  assert.notEqual(invalid.run().status, 0, 'both settings files validate before any write');
  assert.deepEqual(fs.readFileSync(path.join(invalid.claudeDir, 'settings.json')), originalClaude);
  assert.equal(fs.existsSync(invalid.claudeLink), false);

  for (const key of ['claude', 'codex']) {
    const symlinked = installerFixture();
    const config = key === 'claude'
      ? path.join(symlinked.claudeDir, 'settings.json')
      : path.join(symlinked.codexDir, 'hooks.json');
    const otherConfig = key === 'claude'
      ? path.join(symlinked.codexDir, 'hooks.json')
      : path.join(symlinked.claudeDir, 'settings.json');
    const target = `${config}.target`;
    const targetBytes = fs.readFileSync(config);
    const otherBytes = fs.readFileSync(otherConfig);
    fs.renameSync(config, target);
    fs.symlinkSync(target, config);
    const refused = symlinked.run();
    assert.notEqual(refused.status, 0, `${key} symlinked settings config is refused`);
    assert.match(refused.stderr, /symlinks are unsupported/);
    assert(fs.lstatSync(config).isSymbolicLink(), `${key} settings symlink remains intact`);
    assert.deepEqual(fs.readFileSync(target), targetBytes, `${key} symlink target remains unchanged`);
    assert.deepEqual(fs.readFileSync(otherConfig), otherBytes, `other settings file remains unchanged for ${key}`);
    assert.equal(fs.existsSync(symlinked.claudeLink), false, `no Claude hook link is installed when ${key} config is refused`);
    assert.equal(fs.existsSync(symlinked.codexLink), false, `no Codex hook link is installed when ${key} config is refused`);
  }

  const installerLocked = installerFixture();
  const lockedClaude = fs.readFileSync(path.join(installerLocked.claudeDir, 'settings.json'));
  assert.notEqual(installerLocked.runWithLock().status, 0, 'installer lock blocks overlapping install/uninstall operations');
  assert.deepEqual(fs.readFileSync(path.join(installerLocked.claudeDir, 'settings.json')), lockedClaude);

  const ownerWriteFailure = installerFixture();
  assert.notEqual(ownerWriteFailure.failInstallerOwnerWrite().status, 0, 'installer owner-file failure is reported');
  assert.equal(fs.existsSync(path.join(ownerWriteFailure.home, '.state', 'worktree-cap', 'installer.lock')), false, 'new empty installer lock is removed when owner-file creation fails');

  const concurrentEdit = installerFixture();
  const originalConcurrentClaude = fs.readFileSync(path.join(concurrentEdit.claudeDir, 'settings.json'));
  assert.notEqual(concurrentEdit.editCodexDuringInstall().status, 0, 'second settings snapshot drift aborts install');
  assert.deepEqual(fs.readFileSync(path.join(concurrentEdit.claudeDir, 'settings.json')), originalConcurrentClaude, 'first write rolls back after second snapshot drift');
  assert.equal(JSON.parse(fs.readFileSync(path.join(concurrentEdit.codexDir, 'hooks.json'), 'utf8')).concurrentEdit, 'preserve', 'concurrent second-file edit is preserved');
  assert(fs.existsSync(concurrentEdit.claudeLink) && fs.realpathSync(concurrentEdit.claudeLink) === fs.realpathSync(hook), 'rollback restores links still referenced by baseline settings');

  const rollbackDrift = installerFixture();
  assert.notEqual(rollbackDrift.editClaudeBeforeRollback().status, 0, 'rollback detects settings changed after write');
  const driftedClaude = JSON.parse(fs.readFileSync(path.join(rollbackDrift.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(driftedClaude.concurrentEdit, 'preserve', 'rollback does not overwrite a concurrent edit');
  assert(fs.existsSync(rollbackDrift.claudeLink) && fs.realpathSync(rollbackDrift.claudeLink) === fs.realpathSync(hook), 'link is retained for the still-referenced registration');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}

runTests().then(() => process.stdout.write('worktree-cap focused cases passed\n')).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
