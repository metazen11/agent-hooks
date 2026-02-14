#!/usr/bin/env node
/**
 * agent-memory SessionStart hook
 *
 * Queries agent-memory server for recent observations matching the current
 * project and injects them as session context via systemMessage.
 *
 * Also injects a hint teaching Claude how to query the memory MCP tools.
 *
 * Falls back gracefully if server is unreachable.
 *
 * stdin: JSON { cwd, session_id, reason }
 * stdout: JSON { systemMessage?: string }
 *
 * Set AGENT_MEMORY_DEBUG=1 for verbose stderr logging.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_BASE = 'http://localhost:3377';
const DEBUG = process.env.AGENT_MEMORY_DEBUG !== '0';

function debug(msg) {
  if (DEBUG) console.error(`[agent-memory:session-start] ${msg}`);
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    debug(`stdin: ${raw.slice(0, 200)}`);
    return JSON.parse(raw);
  } catch {
    debug('Failed to parse stdin');
    return {};
  }
}

function output(obj) {
  const json = JSON.stringify(obj);
  debug(`stdout: ${json.slice(0, 300)}`);
  console.log(json);
  process.exit(0);
}

const input = readStdin();

// Skip on 'clear' reason
if (input.reason === 'clear') {
  debug('Skipping — reason is clear');
  output({});
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const project = path.basename(cwd);
debug(`project=${project} cwd=${cwd}`);

// ── MCP usage hint ──────────────────────────────────────────
// This teaches Claude how to use the agent-memory MCP tools
// on every session start, similar to claude-mem's approach.

const MCP_HINT = `# Agent Memory (MCP)

You have access to a persistent memory system via MCP tools (server: "agent-memory").
This stores observations from all past coding sessions — bugs found, decisions made,
patterns discovered, files modified. Use it to avoid repeating mistakes and build on prior work.

**When to search memory:**
- Before starting unfamiliar work ("have I solved this before?")
- When debugging ("did I hit this bug in a previous session?")
- When making architecture decisions ("what did I decide last time?")
- When the user asks about past work or previous sessions

**3-layer search workflow (saves 10x tokens):**
1. \`search(query)\` → Get index with IDs and titles (~50-100 tokens/result)
2. \`timeline(anchor=ID)\` → See what happened around an interesting result
3. \`get_observations([IDs])\` → Fetch full details ONLY for relevant IDs

**Never skip to step 3.** Always filter with search first.

**save_memory(text)** — Manually save important findings for future sessions.`;

// ── Start session on server (fire-and-forget) ───────────────

const sessionPayload = JSON.stringify({
  session_id: input.session_id || `session-${Date.now()}`,
  project: project,
  project_path: cwd,
  agent_type: 'claude-code',
});

debug(`POST /api/sessions payload=${sessionPayload.slice(0, 100)}`);

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
}, (res) => { debug(`POST /api/sessions → ${res.statusCode}`); });
sessionReq.on('error', (e) => { debug(`POST /api/sessions error: ${e.message}`); });
sessionReq.on('timeout', () => { debug('POST /api/sessions timeout'); sessionReq.destroy(); });
sessionReq.write(sessionPayload);
sessionReq.end();

// ── Fetch recent observations for context ───────────────────

const obsUrl = new URL(`${SERVER_BASE}/api/observations?project=${encodeURIComponent(project)}&limit=5`);
debug(`GET ${obsUrl.pathname}${obsUrl.search}`);

const req = http.get({
  hostname: obsUrl.hostname,
  port: obsUrl.port,
  path: `${obsUrl.pathname}${obsUrl.search}`,
  timeout: 3000,
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    debug(`GET observations → ${res.statusCode} (${data.length} bytes)`);
    try {
      const observations = JSON.parse(data);
      if (!Array.isArray(observations) || observations.length === 0) {
        debug('No recent observations, injecting MCP hint only');
        output({ systemMessage: MCP_HINT });
        return;
      }

      // Format as context message (chronological: oldest first)
      const sorted = observations.reverse();
      const lines = sorted.map((obs, i) => {
        const date = obs.created_at ? obs.created_at.replace('T', ' ').slice(0, 19) : '';
        const type = obs.type ? `[${obs.type}]` : '';
        return `  ${i + 1}. ${date} ${type} ${obs.title}`;
      });

      const recentCtx = `Recent memory for "${project}" (${observations.length} entries):\n${lines.join('\n')}`;
      const msg = `${MCP_HINT}\n\n${recentCtx}`;
      debug(`Injecting hint + ${observations.length} observations`);
      output({ systemMessage: msg });
    } catch (e) {
      debug(`Parse error: ${e.message}`);
      output({ systemMessage: MCP_HINT });
    }
  });
});

req.on('error', (e) => {
  debug(`GET observations error: ${e.message}`);
  // Server down — still inject the MCP hint so Claude knows tools exist
  output({ systemMessage: MCP_HINT });
});
req.on('timeout', () => {
  debug('GET observations timeout');
  req.destroy();
  output({ systemMessage: MCP_HINT });
});
