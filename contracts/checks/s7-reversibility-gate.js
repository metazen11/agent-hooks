#!/usr/bin/env node
/**
 * s7-reversibility-gate.js — CONTRACT §7 enforcement
 *
 * Intercepts Bash commands for destructive or hard-to-reverse operations
 * and denies them with a request for operator confirmation or backup
 * evidence.
 *
 * Categories:
 *   1. Filesystem destruction — rm -rf, forced removal of directories
 *   2. Git rewrites — reset --hard, push --force, branch -D, checkout -- .
 *   3. Database destruction — DROP TABLE, TRUNCATE, DELETE FROM without WHERE
 *   4. Package operations — downgrades, uninstalls of top-level deps
 *
 * The hook denies rather than merely warns. Operator can then either:
 *   - Provide explicit confirmation for this specific action
 *   - Take a backup and retry
 *   - Add a standing authorization to CLAUDE.md if this is a repeated safe pattern
 */

'use strict';

const { execFileSync } = require('child_process');

const DESTRUCTIVE_PATTERNS = [
  {
    id: 'rm-rf',
    re: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|-rf|-fr|--recursive[^&|;]*--force|--force[^&|;]*--recursive)\b(?![^&|;]*--dry-run)/,
    category: 'filesystem',
    hint: 'rm -rf is irreversible. Confirm the target path, or move to a trash location first.',
  },
  {
    id: 'git-reset-hard',
    re: /\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+)*\s+reset\s+--hard\b/,
    category: 'git',
    hint: 'git reset --hard discards uncommitted work. Capture the current HEAD as a tag first (`git tag pre-reset-<date>`).',
  },
  {
    id: 'git-push-force',
    re: /\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+)*\s+push\s+(?:[^&|;]*\s)?(?:(?:--force(?:-with-lease)?|-[a-zA-Z]*f[a-zA-Z]*|--mirror)\b|\+\S)/,
    category: 'git',
    hint: 'git push --force rewrites remote history. Use --force-with-lease at minimum, or confirm with operator.',
  },
  {
    id: 'git-branch-delete-force',
    re: /\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+)*\s+branch\s+-D\b/,
    category: 'git',
    hint: 'git branch -D force-deletes a branch even if unmerged. Confirm the branch is truly abandoned.',
  },
  {
    id: 'git-checkout-discard',
    re: /\bgit\s+checkout\s+--\s*\.\s*$/,
    category: 'git',
    hint: 'git checkout -- . discards all unstaged changes. Confirm you have no work in progress.',
  },
  {
    id: 'git-clean-force',
    re: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    category: 'git',
    hint: 'git clean -f deletes untracked files permanently. Run `git clean -n` first to preview.',
  },
  {
    id: 'sql-drop-table',
    re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    category: 'database',
    hint: 'DROP TABLE/DATABASE is irreversible without a backup. Confirm a pg_dump / snapshot exists and is recent.',
  },
  {
    id: 'sql-truncate',
    re: /\bTRUNCATE\s+(?:TABLE\s+)?[a-zA-Z_]/i,
    category: 'database',
    hint: 'TRUNCATE deletes all rows without WHERE. Confirm intent and backup.',
  },
  {
    id: 'sql-delete-no-where',
    re: /\bDELETE\s+FROM\s+[a-zA-Z_][a-zA-Z0-9_.]*\s*(?:;|$)/i,
    category: 'database',
    hint: 'DELETE without WHERE removes all rows. Add a WHERE clause or confirm intent.',
  },
  {
    id: 'dropdb',
    re: /\bdropdb\b/,
    category: 'database',
    hint: 'dropdb removes an entire database. Confirm backup and operator authorization.',
  },
];

const GIT_REWRITE_IDS = new Set(['git-reset-hard', 'git-push-force', 'git-branch-delete-force']);

function normalizeCommand(cmd) {
  return cmd.replace(/[\r\n]+/g, ' ').trim();
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '';
  }
}

// §7 evidence: a backup/* or pre-* tag pointing at the commit about to be lost.
function hasBackupTag(cwd, sha) {
  return !!sha && git(cwd, ['tag', '--list', 'backup/*', 'pre-*', '--points-at', sha]) !== '';
}

// Fail closed: every unparseable or ambiguous shape returns false.
// Evidence is granted only to a lone, plain `git <verb> ...` invocation. Any
// chaining, substitution, quoting, env prefix or repo retargeting (cd, -C,
// --git-dir, GIT_DIR=, core.worktree) means the tag lookup in the hook cwd
// could describe a different repo/state than the one acted on, so deny.
// Quoted tokens (`git "push" --force`) are beyond what a regex gate can see.
const NOT_SINGLE = /[;&|`<>$()"'\\]|\s-[Cc]\s|--git-dir|--work-tree|\bGIT_\w+=|\bpushd\b|\bcd\b|core\.worktree/;
// Value-taking push options (-o, --repo, --receive-pack, ...) would shift the
// positionals, so any option outside this allowlist denies.
const PUSH_FLAGS_OK = /^(?:--force-with-lease(?:=\S*)?|-u|--set-upstream|-q|--quiet|-v|--verbose|--no-verify)$/;

// toks: tokens after `git push`. Exactly one --force-with-lease, one explicit
// remote and one refspec; the lease (if it names a ref/sha) must be for that branch.
function pushBacked(toks, cwd) {
  if (!toks.filter((t) => t.startsWith('-')).every((t) => PUSH_FLAGS_OK.test(t))) return false;
  const leases = toks.filter((t) => t.startsWith('--force-with-lease'));
  if (leases.length !== 1) return false;
  const pos = toks.filter((t) => !t.startsWith('-'));
  if (pos.length !== 2 || pos[1].startsWith('+')) return false;
  const [remote, spec] = pos;
  const parts = spec.split(':');
  if (parts.length > 2 || parts.some((p) => !p)) return false;
  const branch = parts[parts.length - 1].replace(/^refs\/heads\//, '');
  const m = /^--force-with-lease=([^:]+)(?::(.+))?$/.exec(leases[0]);
  if (leases[0] !== '--force-with-lease' && !m) return false;
  if (m && m[1].replace(/^refs\/heads\//, '') !== branch) return false;
  const sha = m && m[2]
    ? git(cwd, ['rev-parse', '--verify', '-q', `${m[2]}^{commit}`])
    : git(cwd, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`]);
  return hasBackupTag(cwd, sha);
}

function backed(command, cwd) {
  if (!cwd || NOT_SINGLE.test(command)) return false;
  const [git_, verb, ...rest] = command.split(/\s+/);
  if (git_ !== 'git') return false;
  if (verb === 'push') return pushBacked(rest, cwd);
  if (verb === 'reset' && rest.includes('--hard')) {
    // A tag keeps commits, not uncommitted work, so the worktree must be clean.
    return git(cwd, ['status', '--porcelain']) === ''
      && hasBackupTag(cwd, git(cwd, ['rev-parse', 'HEAD']));
  }
  if (verb === 'branch' && rest[0] === '-D') {
    const names = rest.slice(1);
    return names.length > 0 && names.every((n) => !n.startsWith('-')
      && hasBackupTag(cwd, git(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${n}`])));
  }
  return false;
}

function checkBash(toolInput, cwd) {
  const raw = toolInput && toolInput.command;
  if (typeof raw !== 'string') return { allow: true };

  const command = normalizeCommand(raw);

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.re.test(command)) {
      if (GIT_REWRITE_IDS.has(pattern.id) && backed(command, cwd)) {
        continue;
      }
      return {
        allow: false,
        reason: buildReason(pattern, command.slice(0, 200)),
      };
    }
  }
  return { allow: true };
}

function buildReason(pattern, sample) {
  return [
    'CONTRACT §7 — Reversibility Gate',
    '',
    `This is a ${pattern.category} destructive operation that requires evidence`,
    'of either operator confirmation or a restorable backup before proceeding.',
    '',
    `  • ${pattern.id}: ${sample}`,
    `    ${pattern.hint}`,
    '',
    'See ~/_CODING/hooks/contracts/engineering-contract.md#7--reversibility-gate',
    '',
    'To proceed, do ONE of:',
    '  1. Ask the operator to confirm this specific action in this context',
    '  2. Produce and verify a backup/snapshot, then retry',
    '  3. If this pattern is safe in a documented context, add a standing',
    '     authorization to the project CLAUDE.md and cite it here',
    '',
    'Backup evidence the gate accepts for git rewrites: a local tag named',
    'backup/* or pre-* pointing at the commit being overwritten/discarded:',
    '  push --force-with-lease: git tag backup/<name> <remote-tracking sha>  (bare --force is never satisfied)',
    '  reset --hard:            git tag backup/<name> HEAD',
    '  branch -D <b>:           git tag backup/<name> <b>',
    '',
    'Operator authorization for one action does NOT authorize the same action',
    'in a different context — scope of authorization matches scope of request.',
  ].join('\n');
}

function check(toolName, toolInput, ctx) {
  if (toolName === 'Bash') return checkBash(toolInput, ctx && ctx.cwd);
  return { allow: true };
}

module.exports = { check, DESTRUCTIVE_PATTERNS };
