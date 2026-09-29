#!/usr/bin/env bash
# Tests for lib/transcript.js. Run: ./test-transcript.sh
set -uo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok(){ printf '  ✓  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  ✗  %s\n' "$1"; fail=$((fail+1)); }
chk(){ [ "$2" = "$3" ] && ok "$1" || { no "$1"; printf '       want=%s got=%s\n' "$3" "$2"; }; }

# count with the cache DISABLED unless a test is specifically about caching,
# so results cannot be masked by a stale entry from an earlier case.
count(){ node -e '
const {countUserTurns}=require("./transcript.js");
console.log(countUserTurns(process.argv[1],{cache:process.argv[2]==="1"}));' "$1" "${2:-0}"; }

user(){ echo '{"type":"user","message":{"role":"user","content":"hi"}}'; }
tool(){ echo '{"type":"user","toolUseResult":{"stdout":"x"},"message":{"role":"user"}}'; }
meta(){ echo '{"type":"user","isMeta":true,"message":{"role":"user"}}'; }
asst(){ echo '{"type":"assistant","message":{"role":"assistan"}}'; }   # same byte length as user()

echo "transcript.js tests"; echo "────────────────────────────────"

echo "correctness — what counts as a turn:"
{ user; asst; user; } > "$TMP/a.jsonl"
chk "2 plain user turns"                 "$(count "$TMP/a.jsonl")" 2
{ user; tool; tool; tool; user; } > "$TMP/b.jsonl"
chk "tool results excluded (naive=5)"    "$(count "$TMP/b.jsonl")" 2
{ meta; meta; user; } > "$TMP/c.jsonl"
chk "isMeta excluded (naive=3)"          "$(count "$TMP/c.jsonl")" 1
: > "$TMP/empty.jsonl"
chk "empty file"                          "$(count "$TMP/empty.jsonl")" 0
{ user; echo 'not json{'; user; } > "$TMP/d.jsonl"
chk "malformed line skipped"              "$(count "$TMP/d.jsonl")" 2

echo "degradation — must never throw:"
chk "missing file -> 0"                   "$(count "$TMP/nope.jsonl")" 0
chk "directory -> 0"                      "$(count "$TMP")" 0
chk "empty path -> 0"                     "$(count "")" 0

echo "incremental cache:"
{ user; user; } > "$TMP/inc.jsonl"
chk "first call (cold)"                   "$(count "$TMP/inc.jsonl" 1)" 2
user >> "$TMP/inc.jsonl"
chk "after append: counts new line only"  "$(count "$TMP/inc.jsonl" 1)" 3
chk "unchanged file: same answer"         "$(count "$TMP/inc.jsonl" 1)" 3
# Compaction: file REWRITTEN shorter. An incremental count would be wrong.
{ user; } > "$TMP/inc.jsonl"
chk "after shrink (compaction) re-counts" "$(count "$TMP/inc.jsonl" 1)" 1
# Rewritten IN PLACE to the SAME size — inode and size both unchanged, so a
# key of (inode,size) alone returns a stale count. This caught a real bug.
{ user; user; user; } > "$TMP/same.jsonl"
chk "3 turns before rewrite"              "$(count "$TMP/same.jsonl" 1)" 3
{ asst; asst; asst; } > "$TMP/same.jsonl"
chk "same-size rewrite is detected"       "$(count "$TMP/same.jsonl" 1)" 0

# cached vs uncached must agree
{ user; tool; user; tool; user; } > "$TMP/agree.jsonl"
a=$(count "$TMP/agree.jsonl" 1); b=$(count "$TMP/agree.jsonl" 0)
chk "cached == uncached"                  "$a" "$b"

echo "chunk boundaries (a turn split across a 1MiB read):"
node -e '
const fs=require("fs");
const p=process.argv[1];
const pad=JSON.stringify({type:"assistant",pad:"x".repeat(2000)});
let out="";
for(let i=0;i<600;i++) out+=pad+"\n";            // ~1.2MB of filler
out+=JSON.stringify({type:"user",message:{role:"user"}})+"\n";
for(let i=0;i<600;i++) out+=pad+"\n";
out+=JSON.stringify({type:"user",message:{role:"user"}})+"\n";
fs.writeFileSync(p,out);' "$TMP/big.jsonl"
chk "turns found across chunk splits"     "$(count "$TMP/big.jsonl")" 2

echo "────────────────────────────────"; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
