#!/usr/bin/env node
/**
 * output-redact — PostToolUse hook for Bash tool output.
 *
 * Reads the Bash tool's stdout/stderr from JSON on stdin, redacts known
 * sensitive patterns inline, writes the redacted JSON to stdout.
 *
 * Wired in ~/.claude/settings.json under PostToolUse matcher: "Bash".
 *
 * Why this exists:
 *   Behavioral "never echo secrets" lessons have failed 3+ times in single
 *   sessions. The agent rationalizes per-case ("this one is fine because…")
 *   and the rationalization step is the leak. A mechanical filter at the
 *   harness layer cuts the loop — the agent never sees the raw value to
 *   reason about, so cannot reason its way past the control.
 *
 * Patterns redacted (see PATTERNS array). Each match is replaced with
 * `[REDACTED:<CATEGORY>]` so the agent still understands what TYPE of value
 * appeared but cannot recover the value itself.
 *
 * Bypass:
 *   Set env CLAUDE_HOOK_REDACT_BYPASS=1 in the Bash tool invocation. Bypass
 *   uses are appended to ~/.claude/security-bypass.log with timestamp + cwd
 *   + command for audit.
 *
 * Allowlist:
 *   Per-project file `.claude-redact-allow` (one pattern per line) holds
 *   project-specific safe values. Loaded relative to the tool's cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// -----------------------------------------------------------------------------
// Pattern table — order matters. More specific patterns first.
// -----------------------------------------------------------------------------
//
// Each entry: { category, regex }
// Regex MUST be global (/g) and MUST be a single capture-or-non-capture group
// that matches the full sensitive substring (no extra context capture).
// The replacement is always `[REDACTED:${category}]`.
const PATTERNS = [
  // --- Hard-credential patterns (Class A — work from anywhere) ---
  {
    category: 'GH_TOKEN',
    regex: /gh[oprsu]_[A-Za-z0-9_]{36,}/g,
  },
  {
    category: 'AWS_ACCESS_KEY',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    category: 'AWS_SECRET_KEY',
    // 40-char base64 candidate on a line containing 'aws_secret' or similar
    regex: /(?<=aws_secret_access_key[^A-Za-z0-9+/=]{1,20})[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/gi,
  },
  {
    category: 'SLACK_TOKEN',
    regex: /xox[abprsou]-[A-Za-z0-9-]{10,}/g,
  },
  {
    category: 'STRIPE_KEY',
    regex: /(?:sk|pk|rk|whsec)_(?:test|live)_[A-Za-z0-9]{20,}/g,
  },
  {
    category: 'GOOGLE_API_KEY',
    regex: /AIza[0-9A-Za-z_-]{35}/g,
  },
  // ANTHROPIC must come before OPENAI — sk-ant-* would otherwise be eaten by
  // the OpenAI pattern's catch-all.
  {
    category: 'ANTHROPIC_KEY',
    regex: /sk-ant-[A-Za-z0-9_-]{40,}/g,
  },
  {
    category: 'OPENAI_KEY',
    // Covers sk-..., sk-proj-..., sk-svcacct-..., sk-org-... (current OpenAI prefixes).
    // Negative-lookahead for 'ant-' so Anthropic keys never reach this pattern.
    regex: /sk-(?!ant-)(?:proj-|svcacct-|admin-|org-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    category: 'JWT',
    // header.payload.signature — three base64url segments
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    category: 'PRIVATE_KEY_HEADER',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },

  // --- Cookie/session tokens ---
  {
    category: 'CF_BM_COOKIE',
    regex: /__cf_bm=[A-Za-z0-9._-]+/g,
  },
  {
    category: 'CF_CLEARANCE_COOKIE',
    regex: /cf_clearance=[A-Za-z0-9._-]+/g,
  },

  // --- Server filesystem paths (Cloudways pattern + generic patterns) ---
  {
    category: 'CLOUDWAYS_PATH',
    regex: /\/home\/\d+\.cloudwaysapps\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]*/g,
  },
  {
    category: 'CLOUDWAYS_HOSTNAME',
    regex: /[A-Za-z0-9-]+\.cloudwaysapps\.com/g,
  },

  // --- IPv4 (excluding well-known private + loopback + link-local) ---
  // We redact anything that looks like a public IPv4. Private ranges are
  // explicitly excluded so docker/localhost work doesn't get mangled.
  {
    category: 'IPv4',
    regex: /\b(?!10\.)(?!127\.)(?!169\.254\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!192\.168\.)(?!0\.0\.0\.0\b)(?!255\.255\.255\.255\b)((?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d))\b/g,
  },

  // --- Automation usernames (project convention: *_automation, *_staging, *_prod) ---
  {
    category: 'AUTOMATION_USER',
    regex: /\b[a-z][a-z0-9_-]*(?:_automation|_staging_automation|_prod_automation)\b/gi,
  },
];

// -----------------------------------------------------------------------------
// Allowlist support
// -----------------------------------------------------------------------------
function loadAllowlist(cwd) {
  if (!cwd) return [];
  try {
    const file = path.join(cwd, '.claude-redact-allow');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  } catch {
    return [];
  }
}

function isAllowed(value, allowlist) {
  return allowlist.some((pattern) => {
    if (pattern === value) return true;
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        return new RegExp(pattern.slice(1, -1)).test(value);
      } catch {
        return false;
      }
    }
    return false;
  });
}

// -----------------------------------------------------------------------------
// Redaction engine
// -----------------------------------------------------------------------------
function redactString(text, allowlist, counts) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const { category, regex } of PATTERNS) {
    out = out.replace(regex, (match) => {
      if (isAllowed(match, allowlist)) return match;
      counts[category] = (counts[category] || 0) + 1;
      return `[REDACTED:${category}]`;
    });
  }
  return out;
}

function walkAndRedact(value, allowlist, counts) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, allowlist, counts);
  if (Array.isArray(value)) return value.map((v) => walkAndRedact(v, allowlist, counts));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walkAndRedact(v, allowlist, counts);
    }
    return out;
  }
  return value;
}

// -----------------------------------------------------------------------------
// Bypass logging
// -----------------------------------------------------------------------------
function logBypass(cwd, command) {
  try {
    const logFile = path.join(os.homedir(), '.claude', 'security-bypass.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      cwd,
      command: typeof command === 'string' ? command.slice(0, 200) : String(command).slice(0, 200),
    });
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    // best-effort logging — don't fail the hook if we can't write
  }
}

// -----------------------------------------------------------------------------
// Entry — read JSON from stdin, redact, write to stdout.
//
// Claude Code's PostToolUse hook contract: stdin is a JSON object describing
// the tool invocation + its result. We mutate the result fields and write the
// modified object to stdout. Schema (relevant fields):
//   { tool_name, tool_input: { command, ... }, tool_response: { stdout, stderr, ... } }
// -----------------------------------------------------------------------------
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    // Malformed input — pass through unchanged rather than break the harness.
    process.stdout.write(input);
    process.exit(0);
  }

  // Bypass check
  const env = (payload && payload.tool_input && payload.tool_input.env) || {};
  const bypass = env.CLAUDE_HOOK_REDACT_BYPASS === '1' || process.env.CLAUDE_HOOK_REDACT_BYPASS === '1';
  if (bypass) {
    const cwd = (payload && payload.tool_input && payload.tool_input.cwd) || process.cwd();
    const command = (payload && payload.tool_input && payload.tool_input.command) || '';
    logBypass(cwd, command);
    process.stdout.write(input);
    process.exit(0);
  }

  // Load allowlist from the tool's cwd if provided, else hook's cwd
  const cwd = (payload && payload.tool_input && payload.tool_input.cwd) || process.cwd();
  const allowlist = loadAllowlist(cwd);

  const counts = {};
  const redacted = walkAndRedact(payload, allowlist, counts);

  // Add a summary so the agent KNOWS redaction happened
  const totalRedactions = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalRedactions > 0 && redacted.tool_response) {
    const summary = `\n[output-redact: ${totalRedactions} value(s) masked — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}]\n`;
    if (typeof redacted.tool_response.stdout === 'string') {
      redacted.tool_response.stdout = redacted.tool_response.stdout + summary;
    }
  }

  process.stdout.write(JSON.stringify(redacted));
  process.exit(0);
}

main().catch((err) => {
  // Fail open — never block tool output on hook error
  process.stderr.write(`output-redact: error ${err.message}\n`);
  process.stdin.pipe(process.stdout);
});
