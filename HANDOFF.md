# Session Handoff

**Last updated:** 2026-02-10

## What Happened This Session

### Investigated: Python Crash Storm (26+ segfaults)

**Problem:** 26+ Python process crashes (SIGSEGV) on Feb 9-10, all generating macOS crash reports in `~/Library/Logs/DiagnosticReports/`.

**Root Cause:** The `claude-mem` plugin (thedotmack, v10.0.1) uses ChromaDB 1.5.0 for vector/semantic search. ChromaDB's Rust bindings (`chromadb_rust_bindings.abi3.so`) have a thread-safety bug:
- Multiple tokio-runtime-worker threads contend on `std::__1::mutex::lock()` inside the Rust bindings
- One thread accesses a freed object (null pointer dereference at offset 0xcc)
- The process is spawned by `uv` using Python 3.13

**Evidence:**
- Every single crash report (26+) shows `chromadb_rust_bindings.abi3.so` as the faulting image
- Crash threads vary (28-38), confirming concurrency issue
- `~/.claude-mem/vector-db/chroma.sqlite3` is 379MB and was returning `database is locked`
- Worker logs show `Chroma connection lost: MCP error -32000: Connection closed` after crashes

**Fix Applied:**
- Changed `CLAUDE_MEM_PYTHON_VERSION` from `"3.13"` to `"3.12"` in `~/.claude-mem/settings.json`
- Killed worker daemon (PID 10552) so it restarts with new config

**If crashes continue on Python 3.12:**
- Move `~/.claude-mem/vector-db/` aside to disable ChromaDB entirely (plugin falls back to SQLite-only search)
- Consider filing issue with claude-mem plugin author (thedotmack)
- Relevant upstream issues:
  - https://github.com/chroma-core/chroma/issues/675 (segfault with concurrent requests)
  - https://github.com/chroma-core/chroma/issues/5937 (Rust bindings hang)
  - https://github.com/chroma-core/chroma/issues/3651 (Python 3.13 compatibility)

## Project State

- Branch: `main`
- No code changes made to the hooks project itself
- All hooks (env-guard, git-session, memory-context, pre-commit) are unchanged and working
