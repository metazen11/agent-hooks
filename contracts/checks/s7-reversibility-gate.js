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
    re: /\bgit\s+reset\s+--hard\b/,
    category: 'git',
    hint: 'git reset --hard discards uncommitted work. Capture the current HEAD as a tag first (`git tag pre-reset-<date>`).',
  },
  {
    id: 'git-push-force',
    re: /\bgit\s+push\s+(?:--force(?:-with-lease)?|-f)\b/,
    category: 'git',
    hint: 'git push --force rewrites remote history. Use --force-with-lease at minimum, or confirm with operator.',
  },
  {
    id: 'git-branch-delete-force',
    re: /\bgit\s+branch\s+-D\b/,
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

// The commit a backup tag must point at, or '' when the rewrite is not
// backup-satisfiable (bare --force, unresolvable ref). '' never matches a tag.
function rewriteTarget(id, command, cwd) {
  if (id === 'git-reset-hard') return git(cwd, ['rev-parse', 'HEAD']);
  if (id === 'git-branch-delete-force') {
    const m = /\bgit\s+branch\s+-D\s+([^\s&|;]+)/.exec(command);
    return m ? git(cwd, ['rev-parse', `refs/heads/${m[1]}`]) : '';
  }
  if (id !== 'git-push-force') return '';
  const push = /\bgit\s+push\s+([^&|;]*)/.exec(command)[1];
  // Bare --force / -f stays denied; only --force-with-lease is backup-satisfiable.
  if (/(?:^|\s)(?:--force|-f)(?=\s|$)/.test(push) || !/--force-with-lease\b/.test(push)) return '';
  const pos = push.split(/\s+/).filter((a) => a && !a.startsWith('-'));
  const remote = pos[0] || 'origin';
  const dst = pos[1]
    ? pos[1].replace(/^\+/, '').split(':').pop()
    : git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return git(cwd, ['rev-parse', `refs/remotes/${remote}/${dst.replace(/^refs\/heads\//, '')}`]);
}

function checkBash(toolInput, cwd) {
  const raw = toolInput && toolInput.command;
  if (typeof raw !== 'string') return { allow: true };

  const command = normalizeCommand(raw);

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.re.test(command)) {
      if (cwd && hasBackupTag(cwd, rewriteTarget(pattern.id, command, cwd))) {
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
