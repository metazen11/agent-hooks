#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const source = path.join(__dirname, 'worktree-cap.js');
const home = os.homedir();
const targets = [
  { key: 'claude', link: path.join(home, '.claude', 'hooks', 'worktree-cap.js'), config: path.join(home, '.claude', 'settings.json') },
  { key: 'codex', link: path.join(home, '.codex', 'hooks', 'worktree-cap.js'), config: path.join(home, '.codex', 'hooks.json') },
];
const eventCommands = {
  claude: {
    'UserPromptSubmit': ['claude-user-prompt'],
    'PreToolUse': ['claude-pretool'],
    'PostToolUse': ['claude-post-tool'],
    'WorktreeCreate': ['claude-worktree-create'],
  },
  codex: {
    'UserPromptSubmit': ['codex-user-prompt'],
    'PreToolUse': ['codex'],
    'PostToolUse': ['post-tool'],
  },
};

function hookCommand(target, event, arg) { return `node "${target.link}" ${arg}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function readConfig(file) {
  const original = fs.readFileSync(file);
  const parsed = JSON.parse(original.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid settings object: ${file}`);
  if (parsed.hooks !== undefined && (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) throw new Error(`Invalid hooks object: ${file}`);
  for (const [event, groups] of Object.entries(parsed.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks))) throw new Error(`Invalid ${event} hook groups: ${file}`);
  }
  return { original, parsed, mode: fs.statSync(file).mode & 0o777 };
}

function hookEntries(config, event) {
  return (config.hooks?.[event] || []).flatMap(group => group.hooks.map(entry => ({ group, entry })));
}

function removeManaged(config, target) {
  for (const [event, args] of Object.entries(eventCommands[target.key])) {
    const commands = new Set(args.map(arg => hookCommand(target, event, arg)));
    const groups = config.hooks?.[event] || [];
    const kept = [];
    for (const group of groups) {
      const prior = group.hooks;
      group.hooks = prior.filter(entry => !commands.has(entry.command));
      if (group.hooks.length || prior.length === 0 || prior.every(entry => !commands.has(entry.command))) kept.push(group);
    }
    if (config.hooks) {
      config.hooks[event] = kept;
      if (!config.hooks[event].length) delete config.hooks[event];
    }
  }
}

function requiredEntries(target) {
  const result = [];
  for (const [event, args] of Object.entries(eventCommands[target.key])) {
    for (const arg of args) {
      const hook = { type: 'command', command: hookCommand(target, event, arg), timeout: event === 'WorktreeCreate' ? 30 : 10 };
      let matcher;
      if (target.key === 'claude' && event === 'PreToolUse') { matcher = 'Bash'; hook.onFailure = 'block'; }
      if (target.key === 'claude' && event === 'PostToolUse') matcher = 'Bash';
      if (target.key === 'codex' && event === 'PreToolUse') matcher = 'spawn_agent|Agent|Task|Bash';
      if (target.key === 'codex' && event === 'PostToolUse') matcher = 'spawn_agent|Agent|Task|Bash';
      result.push({ event, matcher, hook });
    }
  }
  return result;
}

function addRequired(config, target) {
  config.hooks ||= {};
  for (const required of requiredEntries(target)) {
    const groups = config.hooks[required.event] ||= [];
    if (groups.some(group => group.matcher === required.matcher && group.hooks.some(entry => entry.command === required.hook.command))) continue;
    const group = { hooks: [required.hook] };
    if (required.matcher !== undefined) group.matcher = required.matcher;
    groups.push(group);
  }
}

function verify(config, target) {
  for (const required of requiredEntries(target)) {
    const matches = hookEntries(config, required.event).filter(({ group, entry }) => entry.command === required.hook.command && group.matcher === required.matcher);
    if (matches.length !== 1) throw new Error(`Registration readback failed: ${required.event} ${required.hook.command}`);
  }
}

function atomicWrite(file, content, mode) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode, flag: 'wx' });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

function backup(file, bytes) {
  const name = `${file}.worktree-cap.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(name, bytes, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(name, 0o600);
  return name;
}

function withInstallerLock(action) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'worktree-cap');
  const lock = path.join(dir, 'installer.lock');
  const ownerPath = path.join(lock, 'owner.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const owner = { pid: process.pid, started: Date.now(), nonce: crypto.randomBytes(16).toString('hex') };
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another worktree-cap installer is active or left a lock at ${lock}`);
    throw error;
  }
  let ownerWritten = false;
  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    ownerWritten = true;
    fs.chmodSync(ownerPath, 0o600);
    return action();
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      if (current.nonce === owner.nonce) fs.rmSync(lock, { recursive: true });
    } catch {
      if (!ownerWritten) {
        try {
          if (fs.readdirSync(lock).length === 0) fs.rmdirSync(lock);
        } catch { /* preserve non-empty or unverified contents for explicit recovery */ }
      }
    }
  }
}

function assertSnapshot(file, expected, stage) {
  let actual;
  try { actual = fs.readFileSync(file); }
  catch (error) { throw new Error(`Settings changed during ${stage}; refusing to overwrite ${file}: ${error.message}`); }
  if (!actual.equals(expected)) throw new Error(`Settings changed during ${stage}; refusing to overwrite ${file}`);
}

function writeFromSnapshot(row, expectedBefore, content, stage) {
  assertSnapshot(row.target.config, expectedBefore, stage);
  atomicWrite(row.target.config, content, row.mode);
  assertSnapshot(row.target.config, content, `${stage} readback`);
}

function ensureLink(target) {
  fs.mkdirSync(path.dirname(target.link), { recursive: true });
  try {
    const stat = fs.lstatSync(target.link);
    if (stat.isSymbolicLink() && fs.realpathSync(target.link) === fs.realpathSync(source)) return false;
    throw new Error(`Refusing to replace existing path: ${target.link}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.symlinkSync(source, target.link);
  return true;
}

function linkState(target) {
  try {
    const stat = fs.lstatSync(target.link);
    return stat.isSymbolicLink() ? { kind: 'symlink', value: fs.readlinkSync(target.link) } : { kind: 'other' };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function stateMatches(target, expected) {
  const actual = linkState(target);
  if (expected === null) return actual === null;
  if (!actual || actual.kind !== expected.kind) return false;
  return expected.kind !== 'symlink' || actual.value === expected.value;
}

function restoreLinkState(target, expected) {
  const actual = linkState(target);
  if (stateMatches(target, expected)) return;
  if (actual && actual.kind === 'other') throw new Error(`Cannot restore managed hook path because it is occupied: ${target.link}`);
  if (actual?.kind === 'symlink') {
    let managed = false;
    try { managed = fs.realpathSync(target.link) === fs.realpathSync(source); } catch { managed = false; }
    if (!managed) throw new Error(`Refusing to replace a symlink not owned by this installer: ${target.link}`);
    fs.unlinkSync(target.link);
  }
  if (expected?.kind === 'symlink') {
    fs.mkdirSync(path.dirname(target.link), { recursive: true });
    fs.symlinkSync(expected.value, target.link);
  }
}

function restoreLinkStates(snapshots) {
  const failures = [];
  for (const { target, state } of snapshots) {
    try {
      restoreLinkState(target, state);
      if (!stateMatches(target, state)) throw new Error(`Hook link readback differs: ${target.link}`);
    } catch (error) { failures.push(error.message); }
  }
  return failures;
}

function restoreConfigSnapshots(rows) {
  const failures = [];
  for (const row of [...rows].reverse()) {
    try {
      const current = fs.readFileSync(row.target.config);
      if (current.equals(row.original)) continue;
      if (!row.writtenBytes || !current.equals(row.writtenBytes)) {
        failures.push(`${row.target.config} changed concurrently; rollback left it untouched`);
        continue;
      }
      writeFromSnapshot(row, row.writtenBytes, row.original, 'rollback');
    } catch (error) { failures.push(`${row.target.config} restore failed: ${error.message}`); }
  }
  for (const row of rows) {
    try {
      if (!fs.readFileSync(row.target.config).equals(row.original)) failures.push(`${row.target.config} readback does not match its backup`);
    } catch (error) { failures.push(`${row.target.config} readback failed: ${error.message}`); }
  }
  return failures;
}

function ensureLinksForRegistrations() {
  const failures = [];
  const outcomes = [];
  for (const target of targets) {
    try {
      const config = readConfig(target.config).parsed;
      const required = requiredEntries(target);
      const mentionedCount = required.filter(item => hookEntries(config, item.event)
        .some(({ entry }) => entry.command === item.hook.command)).length;
      const mentioned = mentionedCount > 0;
      if (mentioned && !ensureLink(target)) {
        if (fs.realpathSync(target.link) !== fs.realpathSync(source)) throw new Error(`Hook link points elsewhere: ${target.link}`);
      }
      if (mentioned && fs.realpathSync(target.link) !== fs.realpathSync(source)) throw new Error(`Hook link readback failed: ${target.link}`);
      outcomes.push(`${target.config}: ${mentionedCount}/${required.length} managed entries; link ${mentioned ? 'valid' : 'not referenced'}`);
    } catch (error) { failures.push(error.message); }
  }
  return { outcomes, failures };
}

function installTransaction() {
  const loaded = targets.map(target => ({ target, ...readConfig(target.config) }));
  const priorLinks = targets.map(target => ({ target, state: linkState(target) }));
  const changed = loaded.map(row => {
    const next = clone(row.parsed);
    removeManaged(next, row.target);
    addRequired(next, row.target);
    verify(next, row.target);
    return { ...row, next, changed: JSON.stringify(row.parsed) !== JSON.stringify(next) };
  });
  const backedUp = [];
  if (changed.some(item => item.changed)) for (const row of changed) backedUp.push(backup(row.target.config, row.original));
  try {
    for (const target of targets) ensureLink(target);
    const written = [];
    try {
      for (const row of changed) {
        if (!row.changed) continue;
        const nextBytes = Buffer.from(`${JSON.stringify(row.next, null, 2)}\n`);
        const attempt = { ...row, writtenBytes: nextBytes };
        written.push(attempt);
        writeFromSnapshot(row, row.original, nextBytes, 'install');
      }
      for (const row of changed) {
        const attempt = written.find(item => item.target.config === row.target.config);
        const expected = attempt ? attempt.writtenBytes : row.original;
        assertSnapshot(row.target.config, expected, 'install final readback');
        verify(readConfig(row.target.config).parsed, row.target);
      }
    } catch (error) {
      const configFailures = restoreConfigSnapshots(written);
      if (configFailures.length) {
        const readback = ensureLinksForRegistrations();
        error.message += `; rollback incomplete: ${[...configFailures, ...readback.failures].join('; ')}; readback: ${readback.outcomes.join('; ')}`;
      } else {
        const linkFailures = restoreLinkStates(priorLinks);
        if (linkFailures.length) {
          const readback = ensureLinksForRegistrations();
          error.message += `; config restored, but hook-link rollback incomplete: ${[...linkFailures, ...readback.failures].join('; ')}; readback: ${readback.outcomes.join('; ')}`;
        }
      }
      throw error;
    }
  } catch (error) {
    const configsUnchanged = changed.every(row => {
      try { return fs.readFileSync(row.target.config).equals(row.original); } catch { return false; }
    });
    if (configsUnchanged) {
      const linkFailures = restoreLinkStates(priorLinks);
      if (linkFailures.length) {
        const readback = ensureLinksForRegistrations();
        error.message += `; link rollback incomplete: ${[...linkFailures, ...readback.failures].join('; ')}; readback: ${readback.outcomes.join('; ')}`;
      }
    } else if (!error.message.includes('rollback incomplete')) {
      const readback = ensureLinksForRegistrations();
      error.message += `; settings may reference hook links; readback: ${readback.outcomes.join('; ')}${readback.failures.length ? `; failures: ${readback.failures.join('; ')}` : ''}`;
    }
    throw error;
  }
  return backedUp;
}

function uninstallTransaction() {
  const loaded = targets.map(target => ({ target, ...readConfig(target.config) }));
  const priorLinks = targets.map(target => ({ target, state: linkState(target) }));
  for (const row of loaded) removeManaged(row.parsed, row.target);
  const changed = loaded.filter(row => JSON.stringify(readConfig(row.target.config).parsed) !== JSON.stringify(row.parsed));
  const backups = changed.map(row => backup(row.target.config, row.original));
  const written = [];
  try {
    for (const row of changed) {
      const nextBytes = Buffer.from(`${JSON.stringify(row.parsed, null, 2)}\n`);
      const attempt = { ...row, writtenBytes: nextBytes };
      written.push(attempt);
      writeFromSnapshot(row, row.original, nextBytes, 'uninstall');
    }
    for (const row of changed) {
      const actual = readConfig(row.target.config).parsed;
      if (JSON.stringify(actual) !== JSON.stringify(row.parsed)) throw new Error(`Uninstall settings readback failed: ${row.target.config}`);
      const attempt = written.find(item => item.target.config === row.target.config);
      if (attempt) assertSnapshot(row.target.config, attempt.writtenBytes, 'uninstall final readback');
    }
    for (const target of targets) {
      try { if (fs.lstatSync(target.link).isSymbolicLink() && fs.realpathSync(target.link) === fs.realpathSync(source)) fs.unlinkSync(target.link); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    const configFailures = restoreConfigSnapshots(written);
    const linkFailures = restoreLinkStates(priorLinks);
    const readback = ensureLinksForRegistrations();
    const failures = [...configFailures, ...linkFailures, ...readback.failures];
    if (failures.length) error.message += `; uninstall rollback incomplete: ${failures.join('; ')}; readback: ${readback.outcomes.join('; ')}`;
    throw error;
  }
  return backups;
}

function install() { return withInstallerLock(installTransaction); }
function uninstall() { return withInstallerLock(uninstallTransaction); }

function main() {
  const action = process.argv[2] || 'install';
  if (!['install', 'uninstall'].includes(action)) throw new Error('Usage: node install.js [install|uninstall]');
  const backups = action === 'install' ? install() : uninstall();
  process.stdout.write(`worktree-cap ${action} complete; backups: ${backups.join(', ') || 'none'}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`worktree-cap installer: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { install, uninstall, targets, requiredEntries };
