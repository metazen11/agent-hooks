#!/usr/bin/env node
/**
 * s3-no-symptom-suppression.js — CONTRACT §3 enforcement
 *
 * Blocks Bash commands and code edits that suppress failure signals
 * instead of fixing the underlying cause. Covers:
 *   - git commit --no-verify / -n
 *   - git commit --no-gpg-sign
 *   - Introducing `except: pass` or bare `except:`
 *   - Introducing `@ts-ignore` / `@ts-nocheck` without an issue reference
 *   - Introducing `# noqa` without a rule code
 *
 * Fail-open on unexpected input.
 */

'use strict';

const path = require('path');

const BASH_BYPASS_PATTERNS = [
  {
    id: 'git-no-verify',
    re: /\bgit\s+(?:commit|push|merge|rebase)\b[^&|;]*(?:--no-verify|\s-n\b)/,
    hint: 'git --no-verify bypasses pre-commit hooks. Fix what the hook is telling you, do not silence it.',
  },
  {
    id: 'git-no-gpg-sign',
    re: /\bgit\b[^&|;]*--no-gpg-sign/,
    hint: 'Disabling GPG signing bypasses signature verification. If signing is broken, fix the key/config.',
  },
  {
    id: 'commit-signoff-bypass',
    re: /\bgit\b[^&|;]*-c\s+commit\.gpgsign=false/,
    hint: 'Inline overriding commit.gpgsign is a bypass. Fix the underlying signing setup.',
  },
];

const CODE_BYPASS_PATTERNS = [
  {
    id: 'bare-except-pass',
    re: /except\s*:\s*\n\s*pass\b/,
    hint: 'Bare `except: pass` silences all errors including SystemExit and KeyboardInterrupt. Handle the specific exception, or let it propagate.',
    langs: ['.py'],
  },
  {
    id: 'bare-except',
    re: /except\s*:\s*(?:#[^\n]*)?\n/,
    hint: 'Bare `except:` catches everything including system-level exits. Catch a specific exception class.',
    langs: ['.py'],
  },
  {
    id: 'ts-ignore-orphan',
    re: /\/\/\s*@ts-ignore(?![^\n]*#\d)(?![^\n]*https?:\/\/)/,
    hint: '@ts-ignore without a linked issue or URL is a symptom-suppression. Fix the type error, or link the tracking issue in the comment.',
    langs: ['.ts', '.tsx', '.js', '.jsx'],
  },
  {
    id: 'ts-nocheck',
    re: /\/\/\s*@ts-nocheck/,
    hint: '@ts-nocheck disables type checking for the entire file. Fix the errors or narrow the scope.',
    langs: ['.ts', '.tsx'],
  },
  {
    id: 'noqa-orphan',
    re: /#\s*noqa(?![:\s]*[A-Z]\d)/,
    hint: '`# noqa` without a rule code silences ALL linter checks on that line. Use `# noqa: E501` to silence a specific rule.',
    langs: ['.py'],
  },
];

function checkBash(toolInput) {
  const command = toolInput && toolInput.command;
  if (typeof command !== 'string') return { allow: true };

  for (const pattern of BASH_BYPASS_PATTERNS) {
    if (pattern.re.test(command)) {
      return {
        allow: false,
        reason: buildReason('bash', pattern, command.slice(0, 120)),
      };
    }
  }
  return { allow: true };
}

function checkEdit(toolName, toolInput) {
  if (!toolInput) return { allow: true };
  const filePath = toolInput.file_path || toolInput.notebook_path;
  const content = toolInput.content || toolInput.new_string || toolInput.new_source;
  if (typeof content !== 'string' || !filePath) return { allow: true };

  const ext = path.extname(filePath).toLowerCase();

  for (const pattern of CODE_BYPASS_PATTERNS) {
    if (pattern.langs && !pattern.langs.includes(ext)) continue;
    const match = content.match(pattern.re);
    if (match) {
      return {
        allow: false,
        reason: buildReason('edit', pattern, match[0].slice(0, 120), filePath),
      };
    }
  }
  return { allow: true };
}

function buildReason(mode, pattern, sample, filePath) {
  const lines = [
    'CONTRACT §3 — Root Cause Over Symptom',
    '',
    mode === 'bash'
      ? 'This command suppresses a failure signal instead of fixing the cause:'
      : `This edit to ${filePath ? path.basename(filePath) : 'the file'} introduces a suppression pattern:`,
    '',
    `  • ${pattern.id}: ${sample}`,
    `    ${pattern.hint}`,
    '',
    'See ~/_CODING/hooks/contracts/engineering-contract.md#3--root-cause-over-symptom',
    '',
    'To proceed:',
    '  1. Diagnose why the check/type-checker/hook is failing',
    '  2. Fix the underlying cause',
    '  3. Retry',
    '',
    'If the check itself is genuinely broken, file the issue and reference it',
    'in the bypass (e.g., `@ts-ignore  # tracked in #123`).',
  ];
  return lines.join('\n');
}

function check(toolName, toolInput) {
  if (toolName === 'Bash') return checkBash(toolInput);
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return checkEdit(toolName, toolInput);
  }
  return { allow: true };
}

module.exports = { check, BASH_BYPASS_PATTERNS, CODE_BYPASS_PATTERNS };
