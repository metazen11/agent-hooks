#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CAP = 5;
const TOKEN_TTL_MS = 2 * 60 * 1000;
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'worktree-cap');

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { fail('cannot read hook input'); }
  const event = process.argv[2];
  if (!raw.trim() && ['codex', 'claude-pretool'].includes(event)) deny(event, 'missing hook payload; worktree creation is denied.');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    if (['codex', 'claude-pretool'].includes(event)) deny(event, 'malformed hook payload; worktree creation is denied.');
    fail('malformed hook input');
  }
}

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function runGitRaw(args, cwd, input = undefined) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function commonDir(cwd, gitDir = null) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const args = gitDir
    ? ['--git-dir', path.resolve(cwd, gitDir), 'rev-parse', '--git-common-dir']
    : ['-C', cwd, 'rev-parse', '--git-common-dir'];
  const value = runGit(args, cwd);
  if (!value) return null;
  const resolved = path.resolve(cwd, value);
  try { return fs.realpathSync(resolved); } catch { return null; }
}

function repositoryRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
}

function worktreeEntries(common) {
  const output = runGit(['--git-dir', common, 'worktree', 'list', '--porcelain'], common);
  if (typeof output !== 'string') return null;
  if (!output.trim()) return [];
  if (!output.startsWith('worktree ')) return null;
  const entries = output.split(/\n\n+/).filter(Boolean);
  const records = [];
  for (const entry of entries) {
    const lines = entry.split('\n');
    const wt = lines.filter(line => line.startsWith('worktree '));
    const heads = lines.filter(line => line.startsWith('HEAD '));
    if (wt.length !== 1 || !path.isAbsolute(wt[0].slice(9)) || heads.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(heads[0].slice(5))) return null;
    if (lines.some(line => line && !/^(worktree |HEAD |branch |detached|bare|locked|prunable)/.test(line))) return null;
    records.push({ path: wt[0].slice(9), head: heads[0].slice(5) });
  }
  const paths = records.map(record => record.path);
  if (new Set(paths).size !== paths.length) return null;
  return records;
}

function worktreeCount(common) {
  const entries = worktreeEntries(common);
  return entries ? entries.length : null;
}

function verifiedOriginBranches(common) {
  const branches = ['main', 'master', 'dev', 'develop'];
  const remoteOutput = runGit(['--git-dir', common, 'ls-remote', 'origin', ...branches.map(name => `refs/heads/${name}`)], common);
  if (remoteOutput === null) return null;
  const remote = new Map();
  for (const line of remoteOutput.split('\n').filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40,64})\trefs\/heads\/(main|master|dev|develop)$/i);
    if (!match || remote.has(match[2])) return null;
    remote.set(match[2], match[1].toLowerCase());
  }
  const verified = new Set();
  for (const [branch, remoteSha] of remote) {
    const localSha = runGit(['--git-dir', common, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], common);
    if (localSha && /^[0-9a-f]{40,64}$/i.test(localSha) && localSha.toLowerCase() === remoteSha) verified.add(branch);
  }
  return verified;
}

function integrationRef(common) {
  const verified = verifiedOriginBranches(common);
  if (!verified) return null;
  let production = ['main', 'master'].filter(branch => verified.has(branch));
  if (production.length > 1) {
    const defaultRef = runGit(['--git-dir', common, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], common);
    production = production.filter(branch => defaultRef === `origin/${branch}`);
  }
  if (production.length !== 1) return null;
  const prod = production[0];
  const marker = runGit(['--git-dir', common, 'show', `refs/remotes/origin/${prod}:.reconcile-gate.json`], common);
  if (marker !== null) {
    let config;
    try { config = JSON.parse(marker); } catch { return null; }
    if (config?.model === 'single-trunk') return `refs/remotes/origin/${prod}`;
    if (config?.model !== undefined) return null;
  }
  const integration = ['dev', 'develop'].filter(branch => verified.has(branch));
  return integration.length === 1 ? `refs/remotes/origin/${integration[0]}` : null;
}

function patchIds(patch, cwd) {
  const output = runGitRaw(['patch-id', '--verbatim'], cwd, patch);
  if (output === null) return null;
  return output.split('\n').filter(Boolean).map(line => line.split(/\s+/, 1)[0]);
}

function landedOnIntegration(pathname, target, aheadCount) {
  if (aheadCount === 0) return true;
  const cherry = runGit(['-C', pathname, 'cherry', target, 'HEAD'], pathname);
  if (cherry === null) return null;
  const cherryRows = cherry.split('\n').filter(Boolean);
  const mergeCount = runGit(['-C', pathname, 'rev-list', '--count', '--merges', `${target}..HEAD`], pathname);
  if (!/^\d+$/.test(mergeCount || '')) return null;
  if (cherryRows.length > 0 && Number(mergeCount) === 0 && cherryRows.every(row => row.startsWith('- '))) return true;
  const base = runGit(['-C', pathname, 'merge-base', target, 'HEAD'], pathname);
  if (!base || !/^[0-9a-f]{40,64}$/i.test(base)) return null;
  const branchPatch = runGitRaw(['-C', pathname, 'diff', '--no-ext-diff', '--binary', base, 'HEAD'], pathname);
  if (branchPatch === null) return null;
  if (!branchPatch.trim()) return false;
  const branchIds = patchIds(branchPatch, pathname);
  if (!branchIds || branchIds.length !== 1) return null;
  const trunkPatches = runGitRaw(['-C', pathname, 'log', '--first-parent', '--no-ext-diff', '--binary', '-p', '--pretty=format:commit %H', `${base}..${target}`], pathname);
  if (trunkPatches === null) return null;
  const trunkIds = patchIds(trunkPatches, pathname);
  return trunkIds ? trunkIds.includes(branchIds[0]) : null;
}

function landingGuidance(target) {
  const branch = target.replace(/^refs\/remotes\/origin\//, '');
  if (branch === 'main' || branch === 'master') {
    return `For this single-trunk repository, land clean work through a feature-branch squash PR to ${branch}; do not reconcile to a dev branch.`;
  }
  return `For this legacy two-trunk repository, after the checkout is clean, run /reconcile to ${branch}.`;
}

function worktreeAdmission(common) {
  const entries = worktreeEntries(common);
  if (!entries) return 'Cannot reliably inspect linked worktrees; creation is denied.';
  if (entries.length >= CAP) return `Worktree cap reached (${entries.length}/${CAP}) for this repository.`;
  const target = integrationRef(common);
  if (!target) return 'Cannot verify this repository’s authorized integration trunk from current origin refs and policy; inspect origin and the committed policy read-only, then retry only after they are unambiguous.';
  const nonPrimary = entries.slice(1);
  if (!nonPrimary.length) return null;
  const unresolved = [];
  for (const entry of nonPrimary) {
    const status = runGit(['-C', entry.path, 'status', '--porcelain', '--untracked-files=all'], entry.path);
    if (status === null) {
      unresolved.push(`${entry.path} (status unavailable)`);
      continue;
    }
    if (status) unresolved.push(`${entry.path} (dirty)`);
    const ahead = runGit(['-C', entry.path, 'rev-list', '--count', `${target}..HEAD`], entry.path);
    if (!/^\d+$/.test(ahead || '')) unresolved.push(`${entry.path} (unlanded status unavailable)`);
    else if (Number(ahead) > 0) {
      const landed = landedOnIntegration(entry.path, target, Number(ahead));
      if (landed === null) unresolved.push(`${entry.path} (landing status unavailable)`);
      else if (!landed) unresolved.push(`${entry.path} (${ahead} commit(s) not verified on ${target})`);
    }
  }
  return unresolved.length
    ? `Unresolved worktrees block creation: ${unresolved.join('; ')}. Preserve and resolve dirty changes first; inspect unavailable status or origin policy read-only. Once relevant checkouts are clean and origin policy is verified, ${landingGuidance(target)} Resolve CI/review/audit/conflict blockers; remove only a verified merged, clean, inactive checkout.`
    : null;
}

function ownerIntent(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 100000) return false;
  const text = prompt.toLowerCase();
  const subject = /\b(i|i'm|i am|we|owner|mauricio)\b/.test(text) || /^\s*(please\s+)?(authori[sz]e|approve|allow|create|use|open|start)\b/.test(text);
  const action = /\b(authori[sz]e|approve|allow|create|use|open|start|need)\b/.test(text);
  const target = /\b(work ?trees?|isolat(ed|ion)|separate checkout)\b/.test(text);
  const negated = /\b(don't|do not|never|stop|no)\b.{0,50}\b(work ?trees?|isolat(ed|ion))\b/.test(text);
  return subject && action && target && !negated && !/^\s*(should|could|would|can)\b/.test(text);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
}

function stateIdentity(input, common, platform) {
  if (typeof input.session_id !== 'string' || input.session_id.length < 8) return null;
  const codex = platform === 'codex';
  if (codex && (typeof input.turn_id !== 'string' || !input.turn_id)) return null;
  return sha(`${common}\0${input.session_id}\0${codex ? input.turn_id : 'claude-session'}`);
}

function tokenPath(input, common, platform) {
  const identity = stateIdentity(input, common, platform);
  return identity ? path.join(STATE_DIR, `auth-${identity}.json`) : null;
}

function atomicJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

function issueToken(input, platform) {
  if (!ownerIntent(input.prompt)) return;
  const common = commonDir(input.cwd);
  const file = common && tokenPath(input, common, platform);
  if (!file) return;
  ensureStateDir();
  const now = Date.now();
  atomicJson(file, { common_hash: sha(common), created: now, expires: now + TOKEN_TTL_MS, used: false, turn_id: platform === 'codex' ? input.turn_id : null });
}

function consumeToken(input, common, platform) {
  const file = tokenPath(input, common, platform);
  if (!file) return false;
  ensureStateDir();
  let token;
  try { token = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!token || token.common_hash !== sha(common) || token.used || !Number.isFinite(token.expires) || token.expires < Date.now()) return false;
  if (platform === 'codex' && token.turn_id !== input.turn_id) return false;
  token.used = true;
  try { atomicJson(file, token); return true; } catch { return false; }
}

function lockPath(common) { return path.join(common, 'worktree-cap.lock'); }
function lockOwnerFile(lock) { return path.join(lock, 'owner.json'); }

function acquireLock(common, input) {
  const lock = lockPath(common);
  const record = { created: Date.now(), session: sha(String(input.session_id || '')), tool_use_id: input.tool_use_id || null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      created = true;
      fs.writeFileSync(lockOwnerFile(lock), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      return record;
    } catch (error) {
      if (created) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} return null; }
      if (error.code === 'ENOENT') return null;
      if (!['EEXIST', 'ENOTDIR'].includes(error.code)) return null;
      // Age alone cannot distinguish a hung command from an abandoned lock.
      // Keep the lock until PostToolUse/native completion releases it.
      return null;
    }
  }
  return null;
}

function releaseLock(common, input) {
  const lock = lockPath(common);
  try {
    const prior = JSON.parse(fs.readFileSync(lockOwnerFile(lock), 'utf8'));
    if (prior.session === sha(String(input.session_id || '')) && prior.tool_use_id === (input.tool_use_id || null)) fs.rmSync(lock, { recursive: true });
  } catch { /* already absent or malformed; stale handling is bounded */ }
}

function deny(event, message) {
  const payload = event === 'claude-pretool' || event === 'codex' ? {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  } : { decision: 'block', reason: message };
  process.stdout.write(JSON.stringify(payload));
  const error = new Error('hook denied');
  error.denied = true;
  throw error;
}

function shellTokens(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  const push = () => { if (token) tokens.push(token); token = ''; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { token += character; escaped = false; continue; }
    if (quote) {
      if (character === '\\' && quote === '"') { escaped = true; continue; }
      if (character === quote) { quote = null; continue; }
      token += character;
      continue;
    }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '\n' || character === '\r') { push(); tokens.push(';'); continue; }
    if (/\s/.test(character)) { push(); continue; }
    const operator = command.slice(index).match(/^(?:&&|\|\||[;|&])/);
    if (operator) { push(); tokens.push(operator[0]); index += operator[0].length - 1; continue; }
    token += character;
  }
  if (escaped || quote) return null;
  push();
  return tokens;
}

function gitWorktreeAdds(command) {
  if (typeof command !== 'string') return [];
  const tokens = shellTokens(command);
  if (!tokens) return /\bgit\b[^;&|\n]*\bworktree\s+add\b/i.test(command) ? [{ unsupported: true }] : [];
  const operators = new Set(['&&', '||', ';', '|', '&']);
  const containsWorktreeAdd = (start, end) => {
    for (let index = start; index + 1 < end; index += 1) {
      if (tokens[index] === 'worktree' && tokens[index + 1] === 'add') return true;
    }
    return false;
  };
  const hasGitDirectoryOverride = gitIndex => {
    const prefix = tokens.slice(0, gitIndex);
    let start = gitIndex - 1;
    while (start >= 0 && !operators.has(tokens[start])) start -= 1;
    const invocation = tokens.slice(start + 1, gitIndex);
    return prefix.some(token => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(token)) ||
      (invocation.includes('env') && invocation.some(token => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(token)));
  };
  const additions = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const executable = path.basename(tokens[index]).toLowerCase();
    if (executable !== 'git' && executable !== 'git.exe') continue;
    let cursor = index + 1;
    const checkouts = [];
    let gitDir = null;
    let hasCheckoutOption = false;
    let hasGitDirOption = false;
    const environmentTarget = hasGitDirectoryOverride(index);
    while (cursor < tokens.length && !operators.has(tokens[cursor])) {
      const argument = tokens[cursor];
      if (argument === 'worktree' && tokens[cursor + 1] === 'add') {
        additions.push({ checkouts, gitDir, unsupported: environmentTarget || (hasCheckoutOption && hasGitDirOption) });
        break;
      }
      if (argument === '-C' || argument === '--git-dir') {
        const value = tokens[cursor + 1];
        if (!value || operators.has(value)) {
          const end = tokens.findIndex((item, offset) => offset > cursor && operators.has(item));
          const stop = end < 0 ? tokens.length : end;
          if (containsWorktreeAdd(cursor + 1, stop)) additions.push({ unsupported: true });
          break;
        }
        if (argument === '-C') { checkouts.push(value); hasCheckoutOption = true; }
        else { gitDir = value; hasGitDirOption = true; }
        cursor += 2;
        continue;
      }
      if (argument.startsWith('--git-dir=')) {
        gitDir = argument.slice('--git-dir='.length);
        hasGitDirOption = true;
        if (!gitDir) additions.push({ unsupported: true });
        cursor += 1;
        continue;
      }
      if (argument.startsWith('-')) {
        const end = tokens.findIndex((item, offset) => offset > cursor && operators.has(item));
        const stop = end < 0 ? tokens.length : end;
        if (containsWorktreeAdd(cursor + 1, stop)) additions.push({ unsupported: true });
        break;
      }
      break;
    }
  }
  return additions;
}

function isWorktreeRequest(input) {
  const value = input.tool_input || input.input || {};
  const serialized = JSON.stringify(value);
  return /"(?:isolation|isolation_mode)"\s*:\s*"worktree"/i.test(serialized) ||
    /\b(?:--worktree|-w)(?:\s|$)/i.test(value.command || '') ||
    gitWorktreeAdds(value.command).length > 0;
}

function isDirectGitWorktreeAdd(input) {
  return gitWorktreeAdds((input.tool_input || input.input || {}).command).length > 0;
}

function hasMultipleDirectAdds(input) {
  return gitWorktreeAdds((input.tool_input || input.input || {}).command).length > 1;
}

function targetRepository(input) {
  const command = (input.tool_input || input.input || {}).command || '';
  const addition = gitWorktreeAdds(command)[0];
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null;
  if (!addition) return { cwd, gitDir: null };
  if (addition.unsupported || !cwd) return { unsupported: true };
  const selectedCwd = (addition.checkouts || []).reduce((current, checkout) => path.resolve(current, checkout), cwd);
  const gitDir = addition.gitDir ? path.resolve(selectedCwd, addition.gitDir) : null;
  return { cwd: selectedCwd, gitDir };
}

function preflight(input, event, platform) {
  if (input.agent_id) deny(event, 'Delegated agents cannot authorize worktree creation.');
  if (hasMultipleDirectAdds(input)) deny(event, 'Multiple worktree additions in one shell command are not supported by the worktree cap guard.');
  const target = targetRepository(input);
  if (target.unsupported || !target.cwd) deny(event, 'Cannot safely parse the target repository options; worktree creation is denied.');
  const common = commonDir(target.cwd, target.gitDir);
  if (!common) deny(event, 'Cannot determine the target repository; worktree creation is denied.');
  if (!acquireLock(common, input)) deny(event, 'Another worktree request is being checked for this repository, or its lock needs recovery.');
  let keepLock = false;
  try {
    const admission = worktreeAdmission(common);
    if (admission) deny(event, admission);
    if (!consumeToken(input, common, platform)) deny(event, 'No unexpired owner-intent request is available for this repository and turn.');
    keepLock = true;
  } finally {
    if (!keepLock) releaseLock(common, input);
  }
}

function createClaudeWorktree(input) {
  const root = repositoryRoot(input.cwd);
  const common = commonDir(input.cwd);
  if (!root || !common) fail('cannot determine target repository');
  const record = acquireLock(common, input);
  if (!record) fail('another worktree request is active or the lock needs recovery');
  try {
    const admission = worktreeAdmission(common);
    if (admission) fail(admission);
    if (!consumeToken(input, common, 'claude')) fail('no unexpired owner-intent request is available for this repository');
    const name = typeof input.name === 'string' ? input.name : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === '.' || name === '..') fail('invalid Claude worktree name');
    const repoName = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_');
    const target = path.join(os.homedir(), '.claude', 'worktrees', repoName, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = spawnSync('git', ['-C', root, 'worktree', 'add', '-b', `codex/${name}-${crypto.randomBytes(4).toString('hex')}`, target], { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== 0) fail(`git worktree add failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    process.stdout.write(`${target}\n`);
  } finally { releaseLock(common, input); }
}

function main() {
  const event = process.argv[2];
  const input = readInput();
  if (event === 'codex-user-prompt') { issueToken(input, 'codex'); return; }
  if (event === 'claude-user-prompt') { issueToken(input, 'claude'); return; }
  if (event === 'claude-worktree-create') { createClaudeWorktree(input); return; }
  if (event === 'post-tool' || event === 'claude-post-tool') {
    const target = targetRepository(input);
    const common = target.unsupported ? null : commonDir(target.cwd, target.gitDir);
    if (common) releaseLock(common, input);
    return;
  }
  if (event === 'codex' || event === 'claude-pretool') {
    const matched = event === 'codex' ? isWorktreeRequest(input) : isDirectGitWorktreeAdd(input);
    if (matched) preflight(input, event, event === 'codex' ? 'codex' : 'claude');
    return;
  }
  fail('unknown hook event');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    if (error.denied) process.exitCode = 0;
    else { process.stderr.write(`worktree-cap: ${error.message}\n`); process.exitCode = error.exitCode || 2; }
  }
}

module.exports = { ownerIntent, worktreeCount, worktreeAdmission, targetRepository, isWorktreeRequest, commonDir, stateIdentity };
