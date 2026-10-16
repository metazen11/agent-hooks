#!/usr/bin/env bash
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.js"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/repo/.claude/worktrees/agent-1" "$ROOT/repo/main"
check() {
  local expected="$1"; shift
  local result
  result=$(printf '%s\n' "$1" | node "$HOOK")
  if [[ "$expected" == allow ]]; then
    [[ -z "$result" || "$result" == *'"allow"'* ]]
  else
    [[ "$result" == *'"deny"'* ]]
  fi
}
read_payload="{\"cwd\":\"$ROOT/repo/.claude/worktrees/agent-1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $ROOT/repo/main/note.md\"}}"
check allow "$read_payload"
prose_payload="{\"cwd\":\"$ROOT/repo/.claude/worktrees/agent-1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat > note.md <<'EOF'\\nThis note mentions $ROOT/repo/main and git push origin main.\\nEOF\"}}"
check allow "$prose_payload"
write_payload="{\"cwd\":\"$ROOT/repo/.claude/worktrees/agent-1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo data > $ROOT/repo/main/out.txt\"}}"
check deny "$write_payload"
echo "3 command-parsing cases passed"
