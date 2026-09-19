#!/usr/bin/env bash
# Self-test for iron-rules. Run: ./test-iron-rules.sh
#
# The critical case is TURN COUNTING: Claude Code writes every TOOL RESULT as a
# `"type":"user"` line. A naive count of those lines overcounts real user turns
# by ~9x (measured: 2251 vs 243 on a real 50MB transcript) and makes the
# throttle fire in bursts. Fixtures here mimic the REAL transcript shape.

set -uo pipefail
cd "$(dirname "$0")"
HOOK=./iron-rules.js
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok(){ printf '  ✓  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  ✗  %s\n' "$1"; fail=$((fail+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || { no "$1"; printf '       want=%s got=%s\n' "$3" "$2"; }; }

# Build a transcript with N real user turns and VARYING tool results per turn.
# Varying matters: with a uniform T per turn, naive = real*(1+T), so a naive
# counter hits multiples of 10 exactly when the real one does and the test
# cannot discriminate. Real sessions vary, so the fixtures must too.
mk(){ : > "$TMP/t.jsonl"; local i=0
  for _ in $(seq 1 "$1"); do
    i=$((i+1))
    echo '{"type":"user","message":{"role":"user","content":"hello"}}' >> "$TMP/t.jsonl"
    echo '{"type":"assistant","message":{"role":"assistant"}}'        >> "$TMP/t.jsonl"
    # 0..4 tool results, varying per turn (i % 5)
    for _ in $(seq 1 $(( i % 5 )) ); do
      echo '{"type":"user","toolUseResult":{"stdout":"x"},"message":{"role":"user"}}' >> "$TMP/t.jsonl"
    done
  done; }
naive(){ grep -c '"type":"user"' "$TMP/t.jsonl"; }
fires(){ [ -n "$(echo "{\"transcript_path\":\"$TMP/t.jsonl\"}" | node $HOOK --user-prompt 2>&1)" ] && echo yes || echo no; }

echo "iron-rules self-test"; echo "────────────────────────────────"

echo "turn counting (tool results must NOT count as turns):"
mk 10; check "10 real turns (naive=$(mk 10; naive)) → fires"  "$(mk 10; fires)" yes
mk 9;  check "9 real turns  (naive=$(mk 9; naive))  → silent" "$(mk 9; fires)"  no
mk 7;  check "7 real turns  (naive=$(mk 7; naive))  → silent" "$(mk 7; fires)"  no
mk 4;  check "4 real turns  (naive=$(mk 4; naive))  → silent" "$(mk 4; fires)"  no
mk 20; check "20 real turns (naive=$(mk 20; naive)) → fires"  "$(mk 20; fires)" yes

: > "$TMP/t.jsonl"
for _ in $(seq 1 5);  do echo '{"type":"user","isMeta":true,"message":{"role":"user"}}' >> "$TMP/t.jsonl"; done
for _ in $(seq 1 10); do echo '{"type":"user","message":{"role":"user"}}'               >> "$TMP/t.jsonl"; done
check "isMeta excluded (naive=15) → fires at 10 real" "$(fires)" yes

echo "cadence override:"
mk 20; check "EVERY=20 at 20 real turns → fires" "$(IRON_RULES_EVERY=20 fires)" yes
mk 10; check "EVERY=20 at 10 real turns → silent" "$(IRON_RULES_EVERY=20 fires)" no

echo "degradation (must all be silent + exit 0):"
for desc in "missing transcript:/nope/x.jsonl" "no key:" ; do
  p="${desc#*:}"; d="${desc%%:*}"
  out=$(echo "{\"transcript_path\":\"$p\"}" | node $HOOK --user-prompt 2>&1); rc=$?
  [ -z "$out" ] && [ $rc -eq 0 ] && ok "$d" || no "$d (rc=$rc)"
done
out=$(echo 'not json' | node $HOOK --user-prompt 2>&1); rc=$?
[ -z "$out" ] && [ $rc -eq 0 ] && ok "malformed stdin" || no "malformed stdin"

echo "digest parsing:"
n=$(node $HOOK --session-start | grep -cE '^[0-9]+\. ')
[ "$n" -ge 5 ] && ok "session-start emits $n rules" || no "expected >=5 rules, got $n"

echo "────────────────────────────────"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
