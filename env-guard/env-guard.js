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

const allow = () => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
    }
});

const block = (reason) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
    }
});

// ── Bash command inspection ──────────────────────────────────
//
// Goal: prevent any Bash command from printing secret-file CONTENTS
// to stdout/stderr. Metadata ops (chmod, ls, stat, test -f) are fine.
// Writes through env-write.js are fine. Everything that reads bytes
// out of a .env-shaped file is blocked.

// Tokens that indicate a content read of a file path passed as arg
const CONTENT_READ_TOKENS = new Set([
  'cat', 'bat', 'tac', 'head', 'tail', 'less', 'more', 'most', 'view',
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'code',
  'strings', 'xxd', 'od', 'hexdump',
  'awk', 'gawk', 'sed', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'cut', 'sort', 'uniq', 'tr', 'column',
  'jq', 'yq',
  'open', // macOS `open .env` opens in editor
]);

// `source` / `.` load env values into the current shell — risky because
// the next command in the same compound could echo $VAR
const SOURCE_TOKENS = new Set(['source', '.']);

// Scripted readers — block any -c/-e payload that references a secret path
const SCRIPT_INTERPRETERS = new Set([
  'python', 'python3', 'python2', 'node', 'deno', 'bun',
  'ruby', 'perl', 'php', 'osascript',
]);

// Match `.env` or `.env.foo` followed by a non-name char (quote, space,
// slash terminator, EOS) — but NOT followed by another name char (so
// `.envoy` isn't a match).
const SECRET_REF_RE = /\.env(?:\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_])|config\.json/;

function commandMentionsSecret(command) {
  // Cheap pre-check: does the literal string look like it touches a .env file?
  if (!SECRET_REF_RE.test(command)) return null;

  // Whole-command check FIRST so inline-script payloads aren't sliced apart
  // by statement-splitting. If the command begins with a scripted interpreter
  // and the rest contains both an inline flag (-c/-e) and a secret reference,
  // treat the whole thing as a hit regardless of what's inside the quoted body.
  {
    const head = command.trim().split(/\s+/);
    let i = 0;
    // Skip `env` wrapper and any leading KEY=val env-style prefixes.
    while (i < head.length && (head[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head[i]))) i++;
    const prog0 = (head[i] || '').replace(/^.*\//, '');
    if (SCRIPT_INTERPRETERS.has(prog0)) {
      const rest = command.slice(command.indexOf(prog0) + prog0.length);
      if (/(^|\s)-[ce](\s|$|["'`])/.test(rest) && SECRET_REF_RE.test(rest)) {
        return { token: prog0 + ' -c/-e', file: '(inline script reads secret)' };
      }
    }
  }

  // Walk tokens, tracking the current "head" of each statement.
  // Statement separators: ; & && || | newline
  const statements = command.split(/[\n;]|&&|\|\||\||&/);

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    // Tokenize (lossy — good enough for shell heuristic)
    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 0) continue;

    // Allow env-write.js (the sanctioned writer)
    if (trimmed.includes('env-write.js')) continue;

    // Find the program name, skipping env-style prefixes (FOO=bar cmd)
    let progIdx = 0;
    while (
      progIdx < tokens.length &&
      (
        tokens[progIdx] === 'env' ||
        /^-/.test(tokens[progIdx]) && tokens.slice(0, progIdx).includes('env') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[progIdx])
      )
    ) progIdx++;
    if (progIdx >= tokens.length) continue;

    const prog = tokens[progIdx].replace(/^.*\//, ''); // strip path

    // 1) `< secret-file` redirection in any statement
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '<' && tokens[i + 1] && isSecretFile(tokens[i + 1])) {
        return { token: '<', file: tokens[i + 1] };
      }
      // `<file` or `<<<file` glued forms
      const m = tokens[i].match(/^<+(.+)$/);
      if (m && isSecretFile(m[1])) return { token: tokens[i], file: m[1] };
    }

    // 2) source / `.` reads file into env
    if (SOURCE_TOKENS.has(prog) && tokens[progIdx + 1] && isSecretFile(tokens[progIdx + 1])) {
      return { token: prog, file: tokens[progIdx + 1] };
    }

    // 3) content-read tokens followed by a secret file arg
    if (CONTENT_READ_TOKENS.has(prog)) {
      for (let i = progIdx + 1; i < tokens.length; i++) {
        const arg = tokens[i].replace(/^['"]|['"]$/g, '');
        if (isSecretFile(arg)) return { token: prog, file: arg };
      }
    }

    // 4) scripted interpreters: any inline payload (`-c`, `-e`) — or any
    // arg referencing `.env` / credential json — is suspect.
    if (SCRIPT_INTERPRETERS.has(prog)) {
      const rest = tokens.slice(progIdx + 1).join(' ');
      // -c/-e flag in any form (followed by space, quote, or another arg)
      const hasInline = /(^|\s)-[ce](\s|$|["'`])/.test(rest);
      const refsSecret = SECRET_REF_RE.test(rest);
      if (hasInline && refsSecret) {
        return { token: prog + ' -c/-e', file: '(inline script reads secret)' };
      }
      // Also block bare-arg form: `perl script.pl .env`, `python foo.py .env`
      for (let i = progIdx + 1; i < tokens.length; i++) {
        const arg = tokens[i].replace(/^['"]|['"]$/g, '');
        if (isSecretFile(arg)) return { token: prog, file: arg };
      }
    }

    // 5) git commands that print file contents
    if (prog === 'git') {
      const sub = tokens[progIdx + 1] || '';
      if (['show', 'diff', 'log', 'cat-file', 'blame'].includes(sub)) {
        for (let i = progIdx + 2; i < tokens.length; i++) {
          if (isSecretFile(tokens[i])) return { token: `git ${sub}`, file: tokens[i] };
        }
      }
    }
  }
  return null;
}

function buildBashBlock(hit, command) {
  return [
    `BLOCKED: Bash command would expose secret file contents.`,
    ``,
    `  matched: ${hit.token}  →  ${hit.file}`,
    ``,
    `Use instead:`,
    `  • ${HELPER} "<file>" KEY VALUE      (set a value)`,
    `  • Read tool on the file              (returns sanitized view)`,
    `  • ls / stat / chmod / wc -l         (metadata, safe)`,
    ``,
    `If you need a value at runtime, have the program load it itself —`,
    `don't pipe a secret file through cat/grep/awk/sed/source.`,
  ].join('\n');
}

// ── Main: read stdin → decide → write stdout ────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { tool_name = '', tool_input = {} } = JSON.parse(input);

    if (tool_name === 'Read') {
      const filePath = tool_input.file_path || '';
      if (isSecretFile(filePath)) {
        if (!fs.existsSync(filePath)) {
          return console.log(block(`File not found: ${filePath}`));
        }
        return console.log(block(buildReadBlock(filePath)));
      }
    }

    if (tool_name === 'Edit') {
      const filePath = tool_input.file_path || '';
      if (isSecretFile(filePath)) {
        return console.log(block(buildEditBlock(filePath)));
      }
    }

    if (tool_name === 'Bash') {
      const command = tool_input.command || '';
      const hit = commandMentionsSecret(command);
      if (hit) {
        return console.log(block(buildBashBlock(hit, command)));
      }
    }

    console.log(allow());
  } catch (e) {
    // Fail closed on malformed input — we'd rather a confusing block than
    // silently allow a tool call we couldn't inspect.
    console.log(block(`env-guard could not parse hook input: ${e.message}`));
  }
});
