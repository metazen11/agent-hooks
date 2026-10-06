#!/usr/bin/env bash
# Tests for context-primer.js. Run: ./test-context-primer.sh
# Claude Code natively loads every CLAUDE.md (~/.claude and cwd + ancestors);
# injecting them again duplicates ~13k tokens/session.
set -uo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok(){ printf '  ✓  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  ✗  %s\n' "$1"; fail=$((fail+1)); }
has(){ case "$2" in *"$3"*) ok "$1";; *) no "$1 (missing: $3)";; esac; }
lacks(){ case "$2" in *"$3"*) no "$1 (found: $3)";; *) ok "$1";; esac; }

export HOME="$TMP/home"
mkdir -p "$HOME/.claude" "$TMP/proj/sub" "$TMP/state"
git -C "$TMP/proj" init -q
echo "GLOBAL-CLAUDE-BODY" > "$HOME/.claude/CLAUDE.md"
echo "PROJECT-CLAUDE-BODY" > "$TMP/proj/CLAUDE.md"
echo "SUB-CLAUDE-BODY" > "$TMP/proj/sub/CLAUDE.md"
echo "AGENTS-BODY" > "$TMP/proj/AGENTS.md"
echo "CODING-REQ-BODY" > "$TMP/proj/coding_requirements.md"
export TMPDIR="$TMP/state"

echo "context-primer tests"; echo "────────────────────────────────"
IN='{"hook_event_name":"SessionStart","cwd":"'"$TMP/proj/sub"'","session_id":"t1"}'
out=$(echo "$IN" | node context-primer.js --session-start)
echo "session-start:"
lacks "no BEGIN marker for ~/.claude/CLAUDE.md"  "$out" "BEGIN $HOME/.claude/CLAUDE.md"
lacks "no BEGIN marker for project CLAUDE.md"    "$out" "BEGIN $TMP/proj/CLAUDE.md"
lacks "no BEGIN marker for cwd CLAUDE.md"        "$out" "BEGIN $TMP/proj/sub/CLAUDE.md"
lacks "no CLAUDE body text"                      "$out" "CLAUDE-BODY"
has   "AGENTS.md still injected"                 "$out" "AGENTS-BODY"
has   "coding_requirements.md still injected"    "$out" "CODING-REQ-BODY"

echo "reprime (turn 50):"
node -e 'const l=[];for(let i=0;i<50;i++)l.push(JSON.stringify({type:"user",message:{role:"user",content:"hi"}}));require("fs").writeFileSync(process.argv[1],l.join("\n")+"\n")' "$TMP/t.jsonl"
out=$(echo '{"hook_event_name":"UserPromptSubmit","cwd":"'"$TMP/proj"'","session_id":"t2","transcript_path":"'"$TMP/t.jsonl"'"}' | node context-primer.js --user-prompt)
has   "reprime fired"                            "$out" "turn 50 refresh"
lacks "reprime omits CLAUDE.md"                  "$out" "CLAUDE-BODY"
has   "reprime keeps AGENTS.md"                  "$out" "AGENTS-BODY"

echo "safety-net gate:"
out=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","cwd":"'"$TMP/proj"'","session_id":"t3"}' | node context-primer.js)
has   "denies once, listing AGENTS.md"           "$out" "AGENTS.md"
lacks "read list omits CLAUDE.md"                "$out" "CLAUDE.md"
out=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Edit","cwd":"'"$TMP/proj"'","session_id":"t3"}' | node context-primer.js)
has   "second call allowed"                      "$out" '"allow"'

echo "only-CLAUDE.md project never denies:"
mkdir -p "$TMP/p2"; git -C "$TMP/p2" init -q; echo X > "$TMP/p2/CLAUDE.md"
out=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"'"$TMP/p2"'","session_id":"t4"}' | node context-primer.js)
has   "allowed"                                  "$out" '"allow"'

echo "────────────────────────────────"; echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
