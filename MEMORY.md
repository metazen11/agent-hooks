# Memory: claude-mem Plugin Issues

Accumulated knowledge from debugging the `claude-mem` plugin (by thedotmack). This document exists so future sessions don't re-investigate the same problems.

---

## The Core Problem

The claude-mem plugin has a **PostToolUse hook** that fires on every single tool call (`matcher: "*"`, 120-second timeout). Each invocation:

1. Tries to start a worker-service daemon via `bun-runner.js`
2. Sends an HTTP POST observation to the worker on port 37777
3. The worker tries to sync with ChromaDB (vector database)
4. ChromaDB fails due to Rust binding bugs on macOS ARM64
5. The hook blocks waiting for the slow/broken worker to respond

**Symptoms:**
- Multi-second pauses after every tool call
- 80+ zombie `worker-service.cjs --daemon` processes accumulating
- Session becoming progressively slower
- ChromaDB segfaults generating crash reports in `~/Library/Logs/DiagnosticReports/`

---

## The Fix

Run `fix-claude-mem.sh` from this repo. It removes the PostToolUse hook from all cached plugin versions, kills zombie processes, and optionally removes the vector-db.

```bash
./fix-claude-mem.sh              # full fix
./fix-claude-mem.sh --status     # check current state
./fix-claude-mem.sh --dry-run    # preview changes
./fix-claude-mem.sh --keep-db    # skip vector-db removal
```

**Must be re-run after any claude-mem plugin update** — updates overwrite `hooks.json`.

---

## What Gets Removed vs. What Keeps Working

| Component | After Fix | Notes |
|---|---|---|
| PostToolUse observation hook | **Removed** | This is the one causing hangs |
| SessionStart context hook | Works | Injects recent memories into session |
| UserPromptSubmit hook | Works | Records user prompts |
| Stop/summarize hook | Works | End-of-session summary |
| MCP search tools (`mcp-search`) | Works | Uses SQLite, not ChromaDB |
| `save_memory` MCP tool | Works | Writes to SQLite |
| ChromaDB vector search | **Broken** | Rust bindings segfault on ARM64 |

The main loss is automatic observation recording during tool use. The MCP search tools, memory saving, and session context all continue working because they use the SQLite database (`~/.claude-mem/claude-mem.db`), not ChromaDB.

---

## Architecture Understanding

### Process Tree

A healthy claude-mem setup runs:

- **1** `worker-service.cjs --daemon` — HTTP API on port 37777, processes observation queue
- **1-2** `chroma-mcp` — ChromaDB MCP server (spawned by worker for vector sync)
- **1** `mcp-server.cjs` — MCP tools server (search, save_memory, etc.)

The bug spawns **duplicate** worker daemons because:
- Each hook invocation calls `worker-service.cjs start`
- If the existing worker is slow to respond to the health check, a new one spawns
- Multiple workers contend on the same SQLite/Chroma files, making everything slower
- This creates a cascading failure loop

### Key Files

| File | Purpose |
|---|---|
| `~/.claude-mem/settings.json` | Plugin configuration (model, port, log level) |
| `~/.claude-mem/claude-mem.db` | Main SQLite database — observations, sessions, prompts |
| `~/.claude-mem/vector-db/` | ChromaDB storage — **source of crashes** |
| `~/.claude-mem/logs/claude-mem-YYYY-MM-DD.log` | Daily worker logs |
| `~/.claude/plugins/cache/thedotmack/claude-mem/*/hooks/hooks.json` | Hook definitions per version |

### ChromaDB Failure Modes

1. **Segfault** — Rust bindings (`chromadb_rust_bindings.abi3.so`) crash on macOS ARM64 due to thread-safety bug in mutex handling. Multiple tokio workers contend on `std::__1::mutex::lock()`.

2. **Connection lost** — Worker logs show `"Connection lost during collection check"` (228+ times in a single day). The Chroma MCP subprocess dies and the worker can't reconnect.

3. **Circuit breaker** — After 3 consecutive failures, the Chroma client stops trying for 60 seconds (`MAX_FAILURES=3`, `CIRCUIT_OPEN_MS=60000`). This adds 60-second stalls to observation processing.

4. **No disable switch** — The worker code has a `disabled` flag on the Chroma class, but `DbManager` unconditionally instantiates it with `new Lh("claude-mem")`. There's no config option to disable Chroma.

### Relevant Upstream Issues

- [chroma-core/chroma#675](https://github.com/chroma-core/chroma/issues/675) — Segfault with concurrent requests
- [chroma-core/chroma#5937](https://github.com/chroma-core/chroma/issues/5937) — Rust bindings hang
- [chroma-core/chroma#3651](https://github.com/chroma-core/chroma/issues/3651) — Python 3.13 compatibility

---

## Previous Fixes Applied

### 2026-02-10: Python downgrade
- Changed `CLAUDE_MEM_PYTHON_VERSION` from `3.13` to `3.12` in `~/.claude-mem/settings.json`
- Reduced crash frequency but didn't eliminate the root cause

### 2026-02-11: PostToolUse hook removal
- Removed PostToolUse from `hooks.json` in versions 10.0.3 and 10.0.4
- Killed 83 zombie worker-service daemons
- Removed `~/.claude-mem/vector-db/` (379MB)
- Created `fix-claude-mem.sh` to automate this

### 2026-02-11: Comprehensive fix
- Extended script to patch ALL cached versions (7.0.10, 9.1.0, 9.1.1, 10.0.0, 10.0.1, 10.0.3, 10.0.4)
- Added `--status`, `--dry-run`, `--keep-db` flags for safe operation
