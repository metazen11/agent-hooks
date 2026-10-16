#!/usr/bin/env bash
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.js"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/repo/.claude/worktrees/agent-1" "$ROOT/repo/main"
check() {
  local expected="$1"; shift
  local result
  local payload
  payload=$(node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Bash",tool_input:{command:process.argv[2]}}))' "$ROOT/repo/.claude/worktrees/agent-1" "$1")
  result=$(printf '%s\n' "$payload" | node "$HOOK")
  if [[ "$expected" == allow ]]; then
    [[ -z "$result" || "$result" == *'"allow"'* ]]
  else
    [[ "$result" == *'"deny"'* ]]
  fi
}
check allow "cat $ROOT/repo/main/note.md"
check allow $'cat > note.md <<\x27EOF\x27\nThis note mentions '$ROOT'/repo/main and git push origin main.\nEOF'
check deny "echo data > $ROOT/repo/main/out.txt"
check deny "cd $ROOT/repo/main && rm file"
check deny "(cd $ROOT/repo/main && rm file)"
check deny "cat local.txt >$ROOT/repo/main/out.txt"
check deny "find $ROOT/repo/main -exec touch {} \\;"
check deny "echo \"\$(rm $ROOT/repo/main/out.txt)\""
check allow "echo '\$(rm $ROOT/repo/main/out.txt)'"
echo "3 command-parsing cases passed"
