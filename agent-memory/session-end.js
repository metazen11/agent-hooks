#!/usr/bin/env node
/**
 * agent-memory SessionEnd hook
 *
 * Marks the session as completed on the agent-memory server.
 *
 * stdin: JSON { session_id }
 * stdout: (none needed for SessionEnd)
 */

const http = require('http');
const fs = require('fs');

const SERVER_BASE = 'http://localhost:3377';

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const input = readStdin();
const sessionId = input.session_id;

if (!sessionId) {
  process.exit(0);
}

// PATCH session to completed
const payload = JSON.stringify({ status: 'completed' });
const url = new URL(`${SERVER_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);

const req = http.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
  timeout: 5000,
}, () => {});

req.on('error', () => {});
req.on('timeout', () => { req.destroy(); });

req.write(payload);
req.end();

// Don't wait for response
process.exit(0);
