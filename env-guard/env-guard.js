#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// env-guard.js  —  PreToolUse hook: protects .env file secrets
// ─────────────────────────────────────────────────────────────
//
//  Read .env  →  BLOCK  +  return sanitized view (values masked)
//  Edit .env  →  BLOCK  +  tell Claude to use env-write.js
//  Anything else  →  ALLOW
//
//  Hook contract:
//    stdin  = JSON  { tool_name, tool_input }
//    stdout = JSON  { decision: "allow"|"block", reason? }
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ── Patterns that count as "secret files" ────────────────────

const ENV_FILE_RE    = /\.env($|\.)/;
const CRED_CONFIG_RE = /config\.json$/;
const CRED_PATH_RE   = /etl|database|credential/;

function isSecretFile(filePath) {
  if (!filePath) return false;
  const base = path.basename(filePath);
  if (ENV_FILE_RE.test(base)) return true;
  if (CRED_CONFIG_RE.test(base) && CRED_PATH_RE.test(filePath)) return true;
  return false;
}

function isJsonFile(filePath) {
  return /\.json$/i.test(filePath);
}

// ── Sanitize KEY=VALUE (.env style) ──────────────────────────

const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)/;

function sanitizeEnv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const out   = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const m = line.match(KEY_VALUE_RE);
    if (m) {
      const [, key, val] = m;
      out.push(val ? `${key}=******* (${val.length} chars)` : `${key}=(empty)`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

// ── Sanitize JSON (mask string values, keep structure) ───────

function sanitizeJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch { return '  (invalid JSON)'; }
  return formatJsonMasked(obj, 1);
}

function formatJsonMasked(val, depth, keyName) {
  const indent  = '  '.repeat(depth);
  const indent0 = '  '.repeat(depth - 1);

  if (val === null)             return 'null';
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number')  return String(val);

  if (typeof val === 'string') {
    if (val === '') return '""';
    if (shouldMask(keyName, val)) return `"*******" (${val.length} chars)`;
    return `"${val}"`;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map(v => `${indent}${formatJsonMasked(v, depth + 1, keyName)}`);
    return `[\n${items.join(',\n')}\n${indent0}]`;
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    const entries = keys.map(k => {
      const masked = formatJsonMasked(val[k], depth + 1, k);
      return `${indent}"${k}": ${masked}`;
    });
    return `{\n${entries.join(',\n')}\n${indent0}}`;
  }

  return String(val);
}

// ── Masking rules ────────────────────────────────────────────

const SENSITIVE_KEY_RE = /pwd|pass|secret|token|key|credential|auth|api.?key/i;

function shouldMask(keyName, val) {
  // Key name looks sensitive → always mask
  if (keyName && SENSITIVE_KEY_RE.test(keyName)) return true;
  // Long strings are likely tokens/secrets
  if (val.length > 40) return true;
  return false;
}

// ── Build the blocked output ─────────────────────────────────

const HELPER = 'node ~/.claude/hooks/env-write.js';
const LINE   = '─'.repeat(56);

function buildReadBlock(filePath) {
  const name    = path.basename(filePath);
  const isJson  = isJsonFile(filePath);
  const content = isJson ? sanitizeJson(filePath) : sanitizeEnv(filePath);
  const writeTip = isJson
    ? `Edit this file manually — JSON structure is too complex for env-write.js`
    : `${HELPER} "${filePath}" KEY VALUE`;

  return [
    `BLOCKED: Secret file — values are masked.`,
    ``,
    `${LINE}`,
    `  ${name}`,
    `${LINE}`,
    ``,
    content,
    ``,
    `${LINE}`,
    `  Write: ${writeTip}`,
    `${LINE}`,
  ].join('\n');
}

function buildEditBlock(filePath) {
  const name = path.basename(filePath);
  return [
    `BLOCKED: Cannot Edit ${name} (secrets would be surfaced).`,
    ``,
    `Use instead:`,
    `  ${HELPER} "${filePath}" KEY VALUE`,
  ].join('\n');
}

// ── Response helpers ─────────────────────────────────────────

const allow = ()       => JSON.stringify({ decision: 'allow' });
const block = (reason) => JSON.stringify({ decision: 'block', reason });

// ── Main: read stdin → decide → write stdout ────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { tool_name = '', tool_input = {} } = JSON.parse(input);
    const filePath = tool_input.file_path || tool_input.command || '';

    if (tool_name === 'Read' && isSecretFile(filePath)) {
      if (!fs.existsSync(filePath)) {
        return console.log(block(`File not found: ${filePath}`));
      }
      return console.log(block(buildReadBlock(filePath)));
    }

    if (tool_name === 'Edit' && isSecretFile(filePath)) {
      return console.log(block(buildEditBlock(filePath)));
    }

    console.log(allow());
  } catch {
    console.log(allow());
  }
});
