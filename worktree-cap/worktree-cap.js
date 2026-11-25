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

function commonDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const value = runGit(['-C', cwd, 'rev-parse', '--git-common-dir'], cwd);
  if (!value) return null;
  const resolved = path.resolve(cwd, value);
  try { return fs.realpathSync(resolved); } catch { return null; }
}

function repositoryRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  return runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
}

function worktreeCount(common) {
  const output = runGit(['--git-dir', common, 'worktree', 'list', '--porcelain'], common);
  if (typeof output !== 'string' || !output.startsWith('worktree ')) return null;
  const entries = output.split(/\n\n+/).filter(Boolean);
  if (!entries.length) return null;
  const paths = [];
  for (const entry of entries) {
    const lines = entry.split('\n');
    const wt = lines.filter(line => line.startsWith('worktree '));
    const heads = lines.filter(line => line.startsWith('HEAD '));
    if (wt.length !== 1 || !path.isAbsolute(wt[0].slice(9)) || heads.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(heads[0].slice(5))) return null;
    if (lines.some(line => line && !/^(worktree |HEAD |branch |detached|bare|locked|prunable)/.test(line))) return null;
    paths.push(wt[0].slice(9));
  }
  if (new Set(paths).size !== paths.length) return null;
  return paths.length;
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

function isWorktreeRequest(input) {
  const value = input.tool_input || input.input || {};
  const serialized = JSON.stringify(value);
  return /"(?:isolation|isolation_mode)"\s*:\s*"worktree"/i.test(serialized) ||
    /\b(?:--worktree|-w)(?:\s|$)/i.test(value.command || '') ||
    /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b/i.test(value.command || '');
}

function isDirectGitWorktreeAdd(input) {
  const command = (input.tool_input || input.input || {}).command || '';
  return /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b/i.test(command);
}

function hasMultipleDirectAdds(input) {
  const command = (input.tool_input || input.input || {}).command || '';
  return [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b/ig)].length > 1;
}

function targetCwd(input) {
  const command = (input.tool_input || {}).command || '';
  const gitC = command.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+worktree\s+add\b/);
  const selected = gitC ? (gitC[1] || gitC[2] || gitC[3]) : input.cwd;
  return selected && path.isAbsolute(selected) ? selected : path.resolve(input.cwd, selected || '.');
}

function preflight(input, event, platform) {
  if (input.agent_id) deny(event, 'Delegated agents cannot authorize worktree creation.');
  if (hasMultipleDirectAdds(input)) deny(event, 'Multiple worktree additions in one shell command are not supported by the worktree cap guard.');
  const cwd = targetCwd(input);
  const common = commonDir(cwd);
  if (!common) deny(event, 'Cannot determine the target repository; worktree creation is denied.');
  if (!acquireLock(common, input)) deny(event, 'Another worktree request is being checked for this repository, or its lock needs recovery.');
  let keepLock = false;
  try {
    const count = worktreeCount(common);
    if (count === null) deny(event, 'Cannot reliably count linked worktrees; worktree creation is denied.');
    if (count >= CAP) deny(event, `Worktree cap reached (${count}/${CAP}) for this repository.`);
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
    const count = worktreeCount(common);
    if (count === null) fail('cannot reliably count linked worktrees');
    if (count >= CAP) fail(`worktree cap reached (${count}/${CAP})`);
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
    const common = commonDir(targetCwd(input));
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

module.exports = { ownerIntent, worktreeCount, isWorktreeRequest, commonDir, stateIdentity };
