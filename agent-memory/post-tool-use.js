#!/usr/bin/env node
/**
 * agent-memory PostToolUse hook
 *
 * Fire-and-forget: sends tool call data to agent-memory server for async
 * observation processing. Never blocks — on any error, exits 0 silently.
 *
 * stdin: JSON { tool_name, tool_input, tool_response, session_id, cwd }
 * stdout: JSON { } (always allow)
 */

const http = require('http');
const fs = require('fs');

const SERVER_URL = 'http://localhost:3377/api/queue';

// Tools that produce no useful observations
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool', 'SlashCommand', 'Skill', 'TodoWrite',
  'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'TaskOutput', 'TaskStop', 'EnterPlanMode', 'ExitPlanMode',
]);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function allow() {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const input = readStdin();
if (!input) {
  allow();
}

const toolName = input.tool_name || '';

// Skip low-value tools
if (SKIP_TOOLS.has(toolName)) {
  allow();
}

// Build queue payload
const payload = JSON.stringify({
  session_id: input.session_id || `session-${Date.now()}`,
  tool_name: toolName,
  tool_input: input.tool_input || null,
  tool_response_preview: typeof input.tool_response === 'string'
    ? input.tool_response.slice(0, 2000)
    : JSON.stringify(input.tool_response || '').slice(0, 2000),
  cwd: input.cwd || process.cwd(),
  last_user_message: null,
});

// Fire-and-forget HTTP POST (2s timeout)
const url = new URL(SERVER_URL);
const req = http.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
  timeout: 2000,
}, () => {});

req.on('error', () => {});  // Silently ignore errors
req.on('timeout', () => { req.destroy(); });

req.write(payload);
req.end();

// Always allow immediately — don't wait for response
allow();
