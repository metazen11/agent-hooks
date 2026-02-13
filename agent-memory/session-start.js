#!/usr/bin/env node
/**
 * agent-memory SessionStart hook
 *
 * Queries agent-memory server for recent observations matching the current
 * project and injects them as session context via systemMessage.
 *
 * Falls back gracefully if server is unreachable.
 *
 * stdin: JSON { cwd, session_id, reason }
 * stdout: JSON { systemMessage?: string }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_BASE = 'http://localhost:3377';

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function output(obj) {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

const input = readStdin();

// Skip on 'clear' reason
if (input.reason === 'clear') {
  output({});
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const project = path.basename(cwd);

// Start session on server (fire-and-forget)
const sessionPayload = JSON.stringify({
  session_id: input.session_id || `session-${Date.now()}`,
  project: project,
  project_path: cwd,
  agent_type: 'claude-code',
});

const sessionUrl = new URL(`${SERVER_BASE}/api/sessions`);
const sessionReq = http.request({
  hostname: sessionUrl.hostname,
  port: sessionUrl.port,
  path: sessionUrl.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(sessionPayload),
  },
  timeout: 2000,
}, () => {});
sessionReq.on('error', () => {});
sessionReq.on('timeout', () => { sessionReq.destroy(); });
sessionReq.write(sessionPayload);
sessionReq.end();

// Fetch recent observations for context
const obsUrl = new URL(`${SERVER_BASE}/api/observations?project=${encodeURIComponent(project)}&limit=5`);

const req = http.get({
  hostname: obsUrl.hostname,
  port: obsUrl.port,
  path: `${obsUrl.pathname}${obsUrl.search}`,
  timeout: 3000,
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const observations = JSON.parse(data);
      if (!Array.isArray(observations) || observations.length === 0) {
        output({});
        return;
      }

      // Format as context message (chronological: oldest first)
      const sorted = observations.reverse();
      const lines = sorted.map((obs, i) => {
        const date = obs.created_at ? obs.created_at.replace('T', ' ').slice(0, 19) : '';
        const type = obs.type ? `[${obs.type}]` : '';
        return `  ${i + 1}. ${date} ${type} ${obs.title}`;
      });

      const msg = `Recent memory (${observations.length} entries):\n${lines.join('\n')}`;
      console.error(`[agent-memory] ${msg.replace(/\n/g, '\n[agent-memory] ')}`);
      output({ systemMessage: msg });
    } catch {
      output({});
    }
  });
});

req.on('error', () => { output({}); });
req.on('timeout', () => { req.destroy(); output({}); });
