# Hooks

Git hooks and agent hooks for development workflows.

## Installation

```bash
./hooks/install.sh
```

## Available Hooks

### pre-commit

Runs before each commit to ensure code quality:

1. **Simplicity Check** - Detects over-engineering patterns
   - Deep inheritance chains
   - Overly complex comprehensions

2. **Security Check** - OWASP-style vulnerability scan
   - SQL injection patterns
   - Command injection risks
   - Hardcoded secrets
   - XSS vulnerabilities (JS)

3. **Naming Conventions**
   - Python: snake_case functions, PascalCase classes
   - JavaScript: camelCase functions
   - Descriptive variable names

4. **Test Verification**
   - Runs related tests for changed files
   - Blocks commit on test failure

5. **Documentation**
   - Checks docstring coverage
   - Flags TODO/FIXME comments
   - Warns on overly long lines

## Bypassing Hooks

In emergencies, bypass with:

```bash
git commit --no-verify
```

**Not recommended** - fix the issues instead.

## Agent Hooks

### env-guard

Prevents agents from surfacing `.env` secrets in conversations. Blocks Read/Edit on secret files, returns masked variable names.

```bash
cd env-guard
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

See [`env-guard/README.md`](env-guard/README.md) for full documentation.

### git-session

Automated git workflow for Claude Code sessions. Handles branch management, checkpoints, and session cleanup.

- **SessionStart**: Pull latest, create working branch if on protected branch
- **PreToolUse**: Checkpoint commit before destructive operations (Edit, Write, rm, etc.)
- **SessionEnd**: Commit all changes, push to remote

```bash
cd git-session
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Configure via environment variables: `GIT_HOOK_PROTECTED_BRANCHES`, `GIT_HOOK_AUTO_PUSH`, `GIT_HOOK_AUTO_PULL`, `GIT_HOOK_CHECKPOINT`, `GIT_HOOK_VERBOSE`.

### memory-context (legacy)

Injects recent claude-mem observations into session context on startup. Queries the local SQLite database for the 3 most recent memories matching the current project.

```bash
cd memory-context
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Requires claude-mem plugin with SQLite database at `~/.claude-mem/claude-mem.db`.

> **Note**: Superseded by `agent-memory` (below) which uses Postgres + pgvector for better search and includes its own context injection.

---

### agent-memory

Persistent cross-session memory for AI coding agents. Every tool call is observed, processed by a local LLM, embedded, and stored in Postgres with pgvector. The agent can then search past sessions to recall bugs, decisions, patterns, and prior work.

**Components:**

| Component | Description |
|-----------|-------------|
| **Hooks** (this repo) | 3 lifecycle hooks that wire into Claude Code |
| **Server** ([agentMemory](../agentMemory/)) | FastAPI backend + background worker on port 3377 |
| **MCP Server** ([mcp_server.py](../agentMemory/mcp_server.py)) | Standalone stdio MCP server for in-session querying |

#### Architecture

```
Claude Code session
  │
  ├─ SessionStart hook ──► FastAPI :3377  (register session)
  │                    └──► inject system prompt (MCP usage guide + recent observations)
  │
  ├─ PostToolUse hook ───► FastAPI :3377/api/queue  (fire-and-forget, ~40ms)
  │                           └──► background worker ──► local LLM ──► embeddings ──► Postgres
  │
  ├─ MCP tools ──────────► mcp_server.py (stdio subprocess, direct Postgres queries)
  │                           search, timeline, get_observations, save_memory
  │
  └─ Stop hook ──────────► FastAPI :3377  (mark session completed)
```

#### Lifecycle Hooks

| Hook | Event | Timeout | What it does |
|------|-------|---------|-------------|
| `session-start.js` | SessionStart | 5s | Registers session with server. Injects MCP usage guide + recent observations as `systemMessage`. Debug on by default. |
| `post-tool-use.js` | PostToolUse | 5s | Sends tool call data to `/api/queue` for async observation processing. Fire-and-forget via `socket.unref()` — stdout writes immediately, HTTP completes in background (~40ms). Skips low-value tools (TaskCreate, AskUserQuestion, etc.). Debug opt-in. |
| `session-end.js` | Stop | 10s | PATCHes session status to `completed`. Debug on by default. |

**PostToolUse matcher** — only fires for tools that produce useful observations:

```
Read|Edit|Write|Bash|Grep|Glob|NotebookEdit|WebFetch|WebSearch
```

#### MCP Server Tools

The MCP server (`mcp_server.py`) runs as a stdio subprocess spawned by Claude Code. It connects directly to Postgres with its own connection pool and embedding model — no dependency on the FastAPI server.

| Tool | Description |
|------|-------------|
| `memory_search_guide` | Usage instructions (always visible in tool listing) |
| `search(query)` | Step 1: Hybrid vector + full-text search. Returns index with IDs and titles. Supports `project`, `type`, `dateStart`, `dateEnd` filters. |
| `timeline(anchor=ID)` | Step 2: Get observations around a result (same session context). Also accepts `query` to auto-find anchor. |
| `get_observations([IDs])` | Step 3: Fetch full details for specific IDs. Always filter with search first. |
| `save_memory(text)` | Manually save a memory for future sessions. |

**3-layer search workflow** (injected into every session via the guide tool + session-start hint):

```
1. search(query)          → index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID)    → context around interesting results
3. get_observations([IDs]) → full details ONLY for filtered IDs
```

Never skip to step 3. Always filter first. 10x token savings.

#### Slash Command

The `/mem-search` skill is installed at `~/.claude/skills/mem-search/SKILL.md`. It teaches Claude when and how to search memory, and is invocable by the user or auto-triggered when asking about past work.

```
/mem-search how did we fix the ChromaDB crash?
/mem-search authentication architecture decisions
```

Claude will also auto-invoke when you ask naturally: *"Did we already solve this?"*, *"What did we decide about X?"*

#### Installation

**Prerequisites:**

- The [agentMemory](../agentMemory/) FastAPI server running on port 3377
- Postgres with pgvector (Docker: `pgvector/pgvector:pg16` on port 5433, database `agentic`)
- Python venv at `agentMemory/.venv` with `mcp`, `asyncpg`, `sentence-transformers`

**1. Start the backend:**

```bash
# Start Postgres (if not already running)
cd /path/to/agentmz/docker && docker compose --env-file ../.env up -d db

# Start FastAPI server
cd /path/to/agentMemory
source .venv/bin/activate
uvicorn app.main:app --port 3377
```

**2. Install hooks into Claude Code:**

```bash
cd agent-memory
node install.js            # symlinks into ~/.claude/hooks/ + patches settings.json
node install.js --uninstall
```

This creates symlinks in `~/.claude/hooks/` and adds hook entries to `~/.claude/settings.json`.

**3. Register the MCP server:**

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "agent-memory": {
      "type": "stdio",
      "command": "/path/to/agentMemory/.venv/bin/python",
      "args": ["/path/to/agentMemory/mcp_server.py"]
    }
  }
}
```

**4. Install the `/mem-search` skill:**

```bash
mkdir -p ~/.claude/skills/mem-search
cp agent-memory/skills/mem-search/SKILL.md ~/.claude/skills/mem-search/SKILL.md
```

**5. Restart Claude Code** — new sessions will show the MCP tools, receive the usage guide, and have `/mem-search` available.

#### Debug Mode

All hooks log to stderr. Debug output is visible in Claude Code's hook execution output.

| Hook | Default | Enable | Disable |
|------|---------|--------|---------|
| session-start | **ON** | (default) | `AGENT_MEMORY_DEBUG=0` |
| post-tool-use | OFF | `AGENT_MEMORY_DEBUG=1` | (default) |
| session-end | **ON** | (default) | `AGENT_MEMORY_DEBUG=0` |

Post-tool-use is off by default because it fires on every tool call. Session-start and session-end fire once per session so debug is safe to leave on.

To enable debug for all hooks:

```bash
AGENT_MEMORY_DEBUG=1 claude
```

Example debug output (session-start):

```
[agent-memory:session-start] project=myapp cwd=/Users/me/myapp
[agent-memory:session-start] POST /api/sessions → 201
[agent-memory:session-start] GET observations → 200 (3421 bytes)
[agent-memory:session-start] Injecting hint + 5 observations
```

#### Configuration

| Env Variable | Used By | Default | Description |
|-------------|---------|---------|-------------|
| `AGENT_MEMORY_DEBUG` | All hooks | `0` (post-tool-use), `1` (others) | Enable/disable stderr logging |
| `AGENT_MEMORY_DATABASE_URL` | MCP server | `postgresql://wfhub:@localhost:5433/agentic` | Postgres connection string |
| `AGENT_MEMORY_EMBEDDING_MODEL` | MCP server | `nomic-ai/nomic-embed-text-v1.5` | Sentence-transformers model for search |

#### Integration with Other Agents

The hooks and MCP server are designed for Claude Code but the underlying system is agent-agnostic. To integrate with another agent:

**Option A: HTTP API (any language)**

The FastAPI server exposes REST endpoints that any agent can call:

```bash
# Queue an observation
curl -X POST http://localhost:3377/api/queue \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"my-session","tool_name":"Read","tool_input":{"file":"/app.py"},"tool_response_preview":"...","cwd":"/project"}'

# Search observations
curl 'http://localhost:3377/api/search?q=authentication+bug&limit=10'

# Get recent observations
curl 'http://localhost:3377/api/observations?project=myapp&limit=5'

# Session lifecycle
curl -X POST http://localhost:3377/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"my-session","project":"myapp","agent_type":"custom-agent"}'

curl -X PATCH http://localhost:3377/api/sessions/my-session \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed"}'
```

**Option B: MCP (any MCP-compatible agent)**

Register `mcp_server.py` in your agent's MCP config. The server is self-contained — it only needs Python, `asyncpg`, and `sentence-transformers`. No FastAPI dependency.

```json
{
  "type": "stdio",
  "command": "/path/to/venv/bin/python",
  "args": ["/path/to/mcp_server.py"],
  "env": {
    "AGENT_MEMORY_DATABASE_URL": "postgresql://user:pass@host:5433/dbname"
  }
}
```

**Option C: Direct Postgres (advanced)**

Query the database directly. Key tables:

| Table | Purpose |
|-------|---------|
| `mem_observations` | All observations with embeddings (768-dim vectors) |
| `mem_sessions` | Session metadata (project, agent type, status) |
| `mem_projects` | Project registry |

```sql
-- Vector similarity search
SELECT id, title, type, 1 - (embedding <=> $1::vector) as score
FROM mem_observations
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT 20;

-- Full-text search
SELECT id, title, type
FROM mem_observations
WHERE tsv @@ plainto_tsquery('english', 'authentication bug')
ORDER BY ts_rank(tsv, plainto_tsquery('english', 'authentication bug')) DESC;
```

---

## Utilities

### fix-claude-mem.sh (legacy)

Fixes the claude-mem plugin's PostToolUse hook that causes multi-second hangs after every tool call. Removes the problematic hook, kills zombie processes, and optionally cleans up the ChromaDB vector database.

```bash
./fix-claude-mem.sh              # full fix
./fix-claude-mem.sh --status     # check current state
./fix-claude-mem.sh --dry-run    # preview changes
```

Re-run after claude-mem plugin updates. See [`MEMORY.md`](MEMORY.md) for full background.
