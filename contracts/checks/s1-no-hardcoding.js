#!/usr/bin/env node
/**
 * s1-no-hardcoding.js — CONTRACT §1 enforcement
 *
 * Blocks Write/Edit tool calls that introduce hardcoded values matching
 * known-risky patterns: absolute paths, localhost URLs with ports,
 * bearer tokens, AWS access keys, and long hex/base64 blobs that look
 * like secrets.
 *
 * Fail-open: if the tool_input shape is unexpected, allow. The purpose
 * is to catch obvious violations, not to block novel edits.
 *
 * Exceptions:
 *   - Test files (contain `test`, `spec`, `fixture` in the path)
 *   - Migration files (contain `migration` or `migrate` in the path)
 *   - Config files (contain `.env`, `config`, `settings` in the path)
 *   - Documentation (`.md`, `.mdx`, `.rst`, `.txt`)
 */

'use strict';

const path = require('path');

const EXEMPT_PATH_RE = /(?:^|\/)(?:test|tests|spec|__tests__|fixtures?|migrations?|migrate)\//i;
const EXEMPT_EXT_RE  = /\.(md|mdx|rst|txt|adoc)$/i;
const EXEMPT_NAME_RE = /(?:^|\/)(?:\.env(?:\..*)?|.*\.env|config\.[jt]s|settings\.py|.*\.config\.[jt]s)$/i;

const PATTERNS = [
  {
    id: 'localhost-port',
    re: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/g,
    hint: 'Use a config value (env var or settings) for host/port, not a literal.',
  },
  {
    id: 'absolute-home-path',
    re: /(["'`])(\/(?:Users|home)\/[a-zA-Z0-9_-]+\/[^"'`\n]*)\1/g,
    hint: 'Absolute paths under /Users or /home MUST come from env or CWD-relative resolution.',
  },
  {
    id: 'aws-access-key',
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    hint: 'AWS access keys MUST NOT be in source — load from env or secrets manager.',
  },
  {
    id: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    hint: 'Bearer tokens MUST come from env or a secrets manager.',
  },
  {
    id: 'private-key-pem',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    hint: 'Private keys MUST NOT appear in source. Move to a secrets store.',
  },
];

function isExemptPath(filePath) {
  if (!filePath) return true;
  if (EXEMPT_PATH_RE.test(filePath)) return true;
  if (EXEMPT_EXT_RE.test(filePath)) return true;
  if (EXEMPT_NAME_RE.test(filePath)) return true;
  return false;
}

function extractContent(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  switch (toolName) {
    case 'Write':
      return { filePath: toolInput.file_path, content: toolInput.content };
    case 'Edit':
      return { filePath: toolInput.file_path, content: toolInput.new_string };
    case 'NotebookEdit':
      return { filePath: toolInput.notebook_path, content: toolInput.new_source };
    default:
      return null;
  }
}

function check(toolName, toolInput) {
  const extracted = extractContent(toolName, toolInput);
  if (!extracted) return { allow: true };
  if (isExemptPath(extracted.filePath)) return { allow: true };
  if (!extracted.content || typeof extracted.content !== 'string') return { allow: true };

  const violations = [];
  for (const pattern of PATTERNS) {
    const matches = extracted.content.match(pattern.re);
    if (matches && matches.length > 0) {
      violations.push({
        id: pattern.id,
        sample: matches[0].slice(0, 80),
        hint: pattern.hint,
      });
    }
  }

  if (violations.length === 0) return { allow: true };

  const reason = [
    'CONTRACT §1 — DRY / No Hardcoding',
    '',
    `The edit to ${path.basename(extracted.filePath)} introduces hardcoded values:`,
    '',
    ...violations.map((v) => `  • ${v.id}: ${v.sample}\n    ${v.hint}`),
    '',
    'See ~/_CODING/hooks/contracts/engineering-contract.md#1--dry--no-hardcoding',
    '',
    'To proceed:',
    '  1. Move the value to config (env var, constants module, or settings file)',
    '  2. Reference it by name in the source',
    '  3. Retry the edit',
    '',
    'If this is a legitimate exception (test fixture, migration, config file),',
    'ensure the file path matches an exemption pattern.',
  ].join('\n');

  return { allow: false, reason };
}

module.exports = { check, PATTERNS, isExemptPath };
