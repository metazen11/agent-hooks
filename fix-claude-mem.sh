#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# fix-claude-mem.sh  —  Fix claude-mem PostToolUse hook hangs
# ─────────────────────────────────────────────────────────────
#
# Problem:
#   The claude-mem plugin registers a PostToolUse hook that fires
#   on EVERY tool call (matcher: "*") with a 120-second timeout.
#   Each invocation:
#     1. Spawns a new worker-service daemon (they pile up — 80+)
#     2. Sends an observation to the worker via HTTP
#     3. Worker tries to sync with ChromaDB vector database
#     4. ChromaDB connections fail (Rust bindings segfault on ARM64)
#     5. Hook blocks until timeout or Chroma gives up
#
#   Result: Multi-second hangs after every single tool call.
#
# Fix:
#   1. Remove PostToolUse from all cached claude-mem hooks.json files
#   2. Kill zombie worker-service daemons and chroma-mcp processes
#   3. Remove the ChromaDB vector-db directory (optional, --keep-db to skip)
#
#   The remaining hooks (Setup, SessionStart, UserPromptSubmit, Stop)
#   and the MCP search tools (SQLite-based) continue to work normally.
#
# Usage:
#   ./fix-claude-mem.sh              # full fix (recommended)
#   ./fix-claude-mem.sh --keep-db    # fix hooks + kill zombies, keep vector-db
#   ./fix-claude-mem.sh --dry-run    # show what would happen, change nothing
#   ./fix-claude-mem.sh --status     # just show current state
#
# Note:
#   Plugin updates will re-add PostToolUse to hooks.json.
#   Re-run this script after any claude-mem plugin update.
#
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ─────────────────────────────────────────────────

PLUGIN_CACHE_DIR="$HOME/.claude/plugins/cache/thedotmack/claude-mem"
VECTOR_DB_DIR="$HOME/.claude-mem/vector-db"

# ── CLI flags ──────────────────────────────────────────────

DRY_RUN=false
KEEP_DB=false
STATUS_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --keep-db)    KEEP_DB=true ;;
    --status)     STATUS_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] [--keep-db] [--status]"
      echo ""
      echo "  --dry-run   Show what would happen, change nothing"
      echo "  --keep-db   Skip removing the ChromaDB vector-db directory"
      echo "  --status    Just show current state and exit"
      echo ""
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)"
      exit 1
      ;;
  esac
done

# ── Helpers ────────────────────────────────────────────────

ok()   { echo "  ✓  $1"; }
skip() { echo "  ·  $1"; }
warn() { echo "  ⚠  $1"; }
info() { echo "  →  $1"; }

# Count matching processes (excludes grep itself)
count_procs() {
  ps aux 2>/dev/null | grep -v grep | grep -c "$1" || echo 0
}

# ── Status ─────────────────────────────────────────────────

show_status() {
  echo ""
  echo "claude-mem status"
  echo "────────────────────────────────────────"

  # Worker daemons
  local workers
  workers=$(count_procs 'worker-service.cjs --daemon')
  if [ "$workers" -gt 1 ]; then
    warn "$workers worker-service daemons running (expected 0-1)"
  elif [ "$workers" -eq 1 ]; then
    ok "1 worker-service daemon running"
  else
    info "No worker-service daemons running"
  fi

  # Chroma processes
  local chromas
  chromas=$(count_procs 'chroma-mcp')
  if [ "$chromas" -gt 2 ]; then
    warn "$chromas chroma-mcp processes running (expected 0-2)"
  elif [ "$chromas" -gt 0 ]; then
    ok "$chromas chroma-mcp process(es) running"
  else
    info "No chroma-mcp processes running"
  fi

  # MCP servers
  local mcps
  mcps=$(count_procs 'claude-mem.*mcp-server.cjs')
  info "$mcps MCP server process(es) running"

  # Vector DB
  if [ -d "$VECTOR_DB_DIR" ]; then
    local db_size
    db_size=$(du -sh "$VECTOR_DB_DIR" 2>/dev/null | cut -f1)
    warn "Vector-db directory exists ($db_size)"
  else
    ok "Vector-db directory does not exist"
  fi

  # PostToolUse hooks in cached plugin versions
  echo ""
  echo "  PostToolUse hook status:"
  local found_any=false
  if [ -d "$PLUGIN_CACHE_DIR" ]; then
    for version_dir in "$PLUGIN_CACHE_DIR"/*/; do
      local hooks_file="$version_dir/hooks/hooks.json"
      if [ -f "$hooks_file" ]; then
        local version
        version=$(basename "$version_dir")
        if grep -q '"PostToolUse"' "$hooks_file" 2>/dev/null; then
          warn "  $version — PostToolUse PRESENT (will cause hangs)"
          found_any=true
        else
          ok "  $version — PostToolUse removed"
        fi
      fi
    done
  fi

  if [ "$found_any" = false ]; then
    ok "  All versions patched"
  fi

  echo ""
}

# If --status, show and exit
if [ "$STATUS_ONLY" = true ]; then
  show_status
  exit 0
fi

# ── Banner ─────────────────────────────────────────────────

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "fix-claude-mem (DRY RUN)"
else
  echo "fix-claude-mem"
fi
echo "────────────────────────────────────────"

# ── Step 1: Patch hooks.json files ────────────────────────
#
# Remove the PostToolUse section from each cached plugin version.
# Uses python3 for reliable JSON manipulation (always available on macOS).

echo ""
echo "  Step 1: Patch hooks.json files"
echo ""

if [ ! -d "$PLUGIN_CACHE_DIR" ]; then
  skip "Plugin cache not found at $PLUGIN_CACHE_DIR"
  skip "claude-mem may not be installed"
else
  patched=0
  skipped=0

  for version_dir in "$PLUGIN_CACHE_DIR"/*/; do
    hooks_file="$version_dir/hooks/hooks.json"

    if [ ! -f "$hooks_file" ]; then
      continue
    fi

    version=$(basename "$version_dir")

    # Check if PostToolUse exists
    if ! grep -q '"PostToolUse"' "$hooks_file" 2>/dev/null; then
      skip "$version — already patched"
      skipped=$((skipped + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      info "$version — would remove PostToolUse"
      patched=$((patched + 1))
      continue
    fi

    # Remove PostToolUse key from the hooks object using python3.
    # This preserves all other keys and formatting.
    python3 -c "
import json, sys
with open('$hooks_file', 'r') as f:
    data = json.load(f)
if 'PostToolUse' in data.get('hooks', {}):
    del data['hooks']['PostToolUse']
    with open('$hooks_file', 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    sys.exit(0)
else:
    sys.exit(1)
" && ok "$version — PostToolUse removed" || warn "$version — patch failed"

    patched=$((patched + 1))
  done

  if [ $patched -eq 0 ] && [ $skipped -gt 0 ]; then
    ok "All versions already patched ($skipped checked)"
  fi
fi

# ── Step 2: Kill zombie processes ─────────────────────────
#
# Worker daemons accumulate because each SessionStart + PostToolUse
# invocation calls `worker-service.cjs start`, which spawns a new
# daemon if it can't reach the existing one (port conflict, slow
# startup, etc). They all compete for the same SQLite/Chroma files.

echo ""
echo "  Step 2: Kill zombie processes"
echo ""

# Kill worker-service daemons
worker_count=$(count_procs 'worker-service.cjs --daemon')
if [ "$worker_count" -gt 0 ]; then
  if [ "$DRY_RUN" = true ]; then
    info "Would kill $worker_count worker-service daemon(s)"
  else
    pkill -f 'worker-service.cjs --daemon' 2>/dev/null && \
      ok "Killed $worker_count worker-service daemon(s)" || \
      warn "Failed to kill worker-service daemons"
  fi
else
  skip "No worker-service daemons running"
fi

# Kill chroma-mcp processes
chroma_count=$(count_procs 'chroma-mcp')
if [ "$chroma_count" -gt 0 ]; then
  if [ "$DRY_RUN" = true ]; then
    info "Would kill $chroma_count chroma-mcp process(es)"
  else
    pkill -f 'chroma-mcp' 2>/dev/null && \
      ok "Killed $chroma_count chroma-mcp process(es)" || \
      warn "Failed to kill chroma-mcp processes"
  fi
else
  skip "No chroma-mcp processes running"
fi

# ── Step 3: Remove vector-db (optional) ──────────────────
#
# The ChromaDB vector database causes most of the problems:
# - Rust bindings segfault on macOS ARM64 (thread-safety bug)
# - 300MB+ SQLite file with WAL contention from multiple workers
# - Circuit breaker adds 60s delays after 3 consecutive failures
#
# Removing it forces claude-mem to fall back to its own SQLite
# database for search (via the MCP tools), which works fine.
# The directory will be recreated on next session start, but
# without PostToolUse hooks it won't cause hangs.

echo ""
echo "  Step 3: Remove vector-db"
echo ""

if [ "$KEEP_DB" = true ]; then
  skip "Skipped (--keep-db flag)"
elif [ ! -d "$VECTOR_DB_DIR" ]; then
  skip "Vector-db directory does not exist"
else
  db_size=$(du -sh "$VECTOR_DB_DIR" 2>/dev/null | cut -f1)
  if [ "$DRY_RUN" = true ]; then
    info "Would remove $VECTOR_DB_DIR ($db_size)"
  else
    rm -rf "$VECTOR_DB_DIR"
    ok "Removed vector-db ($db_size)"
  fi
fi

# ── Done ───────────────────────────────────────────────────

echo ""
echo "────────────────────────────────────────"
if [ "$DRY_RUN" = true ]; then
  echo "  Dry run complete. No changes made."
else
  echo "  Done. Restart Claude Code to activate."
  echo ""
  echo "  Re-run after claude-mem plugin updates."
fi
echo ""
