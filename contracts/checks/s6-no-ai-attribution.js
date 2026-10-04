#!/usr/bin/env node
/**
 * s6-no-ai-attribution.js — CONTRACT §6 enforcement
 *
 * Blocks Bash commands, Write/Edit tool calls, and gh CLI invocations
 * that would introduce AI-authorship attribution into commit messages,
 * PR bodies, issue bodies, or file contents.
 *
 * No exceptions per §6 for attribution itself. One path-scoped carve-out
 * for the mechanical scan: edits to files INSIDE this contracts package
 * (the check, the contract text, the tests) are allowed, because those
 * files necessarily quote the very patterns being forbidden. Without it
 * the contract cannot be maintained except by bypass, which §3 forbids.
 * Bash commands remain strict — a literal pattern on a command line is
 * still denied; pass it through a file instead.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

// Resolved once: the package root, with the installed symlink
// (~/.claude/hooks/contracts -> repo) collapsed to its real location.
const PACKAGE_DIR = realpathOr(path.resolve(__dirname, '..'));

/**
 * True when `filePath` lives inside this contracts package. Write targets
 * may not exist yet, so the parent is realpath'd and the basename re-joined;
 * that keeps a symlinked install path resolving to the same real tree.
 * Fail-closed: anything that cannot be shown to be inside is treated as
 * outside and scanned normally.
 */
function isPackageFile(filePath) {
  if (!filePath) return false;
  const abs  = path.resolve(filePath);
  const real = path.join(realpathOr(path.dirname(abs)), path.basename(abs));
  const rel  = path.relative(PACKAGE_DIR, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const AI_ATTRIBUTION_PATTERNS = [
  {
    id: 'co-authored-by-claude',
    re: /Co-Authored-By:\s*Claude/i,
  },
  {
    id: 'co-authored-by-ai-email',
    re: /Co-Authored-By:[^\n]*@(?:anthropic\.com|openai\.com|google\.com\s*<\s*gemini)/i,
  },
  {
    id: 'noreply-ai-attribution',
    re: /Co-Authored-By:[^\n]*noreply@anthropic\.com/i,
  },
  {
    id: 'generated-with-claude',
    re: /Generated with (?:\[?)?Claude(?: Code)?/i,
  },
  {
    id: 'generated-with-emoji',
    re: /🤖 Generated with/i,
  },
  {
    id: 'generated-by-copilot',
    re: /Generated (?:with|by) (?:GitHub )?Copilot/i,
  },
  {
    id: 'generated-by-cursor',
    re: /Generated (?:with|by) Cursor/i,
  },
];

function containsAttribution(text) {
  if (typeof text !== 'string') return null;
  for (const pattern of AI_ATTRIBUTION_PATTERNS) {
    const match = text.match(pattern.re);
    if (match) return { pattern, sample: match[0] };
  }
  return null;
}

function checkBash(toolInput) {
  const command = toolInput && toolInput.command;
  if (typeof command !== 'string') return { allow: true };

  const hit = containsAttribution(command);
  if (!hit) return { allow: true };

  return {
    allow: false,
    reason: buildReason('command', hit, command.slice(0, 200)),
  };
}

function checkEdit(toolName, toolInput) {
  if (!toolInput) return { allow: true };
  const filePath = toolInput.file_path || toolInput.notebook_path || '';
  if (isPackageFile(filePath)) return { allow: true };
  const content = toolInput.content || toolInput.new_string || toolInput.new_source;
  if (typeof content !== 'string') return { allow: true };

  const hit = containsAttribution(content);
  if (!hit) return { allow: true };

  return {
    allow: false,
    reason: buildReason(
      'file content',
      hit,
      hit.sample,
      filePath ? path.basename(filePath) : null
    ),
  };
}

function buildReason(mode, hit, sample, fileName) {
  const location = mode === 'command'
    ? `A ${mode} contains AI-authorship attribution:`
    : `An edit to ${fileName || 'a file'} contains AI-authorship attribution:`;

  return [
    'CONTRACT §6 — No AI Attribution',
    '',
    location,
    '',
    `  • ${hit.pattern.id}: ${sample.slice(0, 120)}`,
    '',
    'AI attribution is forbidden in commits, PR bodies, issues, comments,',
    'and file contents. No exceptions per §6.',
    '',
    'See ~/_CODING/hooks/contracts/engineering-contract.md#6--no-ai-attribution',
    '',
    'To proceed: remove the attribution line and retry.',
  ].join('\n');
}

function check(toolName, toolInput) {
  if (toolName === 'Bash') return checkBash(toolInput);
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return checkEdit(toolName, toolInput);
  }
  return { allow: true };
}

module.exports = { check, AI_ATTRIBUTION_PATTERNS, containsAttribution };
