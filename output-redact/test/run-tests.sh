#!/usr/bin/env bash
# Test harness for output-redact.
#
# Pipes fixtures.json through output-redact.js, then asserts against the ACTUAL
# harness contract — the hook must emit hookSpecificOutput.updatedToolOutput,
# which is the only field Claude Code uses to replace the model-visible output.
# (Asserting the internal tool_response.stdout would pass even when the hook is
# a silent no-op, which is the bug this suite now guards against.)
#
#   0. The hook emits hookSpecificOutput.updatedToolOutput (the contract field).
#   1. Every category in expected-categories.txt appears as [REDACTED:CATEGORY].
#   2. Allowed private IPs (192.168.*, 127.*, 172.17.*) appear UNREDACTED.
#   3. No raw fixture token strings survive in the replacement output.
#   4. A redaction summary is present.
#   5. Clean input (no secrets) emits NOTHING (no replacement → original stands).
#
# Exit 0 = all assertions pass.
# Exit non-zero = at least one assertion failed; details printed.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../output-redact.js"
FIXTURE="$HERE/fixtures.json"
EXPECTED="$HERE/expected-categories.txt"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: hook not executable at $HOOK"
  exit 1
fi

# The Stripe test vector is assembled at runtime from fragments rather than
# stored in fixtures.json — a committed sk_live_ + 20+ alnum string trips
# GitHub secret-scanning push protection (and is a real Stripe-key shape).
# We inject it into the fixture's stdout just before piping to the hook, so the
# STRIPE_KEY redaction assertion stays fully valid with nothing secret in git.
STRIPE_VECTOR="stripe live: sk_${STRIPE_ENV:-live}_abc123$(printf '%s' 'ABCDEFGHIJKLMNOPQRSTUV')"
INPUT="$(STRIPE_VECTOR="$STRIPE_VECTOR" node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    const j=JSON.parse(d);
    j.tool_response.stdout = (j.tool_response.stdout||"") + "\n" + process.env.STRIPE_VECTOR;
    process.stdout.write(JSON.stringify(j));
  });' < "$FIXTURE")"

OUT="$(printf '%s' "$INPUT" | node "$HOOK")"

FAIL=0

# Assertion 0 (CONTRACT): the hook must emit hookSpecificOutput.updatedToolOutput.
# This is the field the harness honors to replace what the model sees. If it is
# absent, the hook is a silent no-op and the secret reaches the model.
if echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.exit(j.hookSpecificOutput&&typeof j.hookSpecificOutput.updatedToolOutput==="string"?0:1)}catch{process.exit(1)}})'; then
  echo "PASS: hook emits hookSpecificOutput.updatedToolOutput (harness will replace output)"
else
  echo "FAIL: hook did NOT emit hookSpecificOutput.updatedToolOutput — redaction is a NO-OP"
  echo "  raw hook stdout: ${OUT:0:200}"
  FAIL=1
fi

# The replacement text the model will actually see.
STDOUT="$(echo "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.hookSpecificOutput&&j.hookSpecificOutput.updatedToolOutput)||"")}catch{process.stdout.write("")}})')"

# Assertion 1: each expected category must appear as [REDACTED:CAT]
while IFS= read -r cat; do
  [ -z "$cat" ] && continue
  case "$cat" in '#'*) continue ;; esac
  if echo "$STDOUT" | grep -qF "[REDACTED:$cat]"; then
    echo "PASS: category $cat redacted"
  else
    echo "FAIL: category $cat NOT redacted in output"
    FAIL=1
  fi
done < "$EXPECTED"

# Assertion 2: private/loopback/docker IPs survive unredacted
for allowed in "192.168.1.10" "127.0.0.1" "172.17.0.5"; do
  if echo "$STDOUT" | grep -qF "$allowed"; then
    echo "PASS: allowed IP $allowed survived (not redacted)"
  else
    echo "FAIL: allowed IP $allowed was incorrectly redacted"
    FAIL=1
  fi
done

# Assertion 3: no raw fixture tokens remain
# (Take known-leaky substrings from fixtures and grep them in output.)
# Note: the sk_live_ Stripe token is injected at runtime (see STRIPE_VECTOR
# above), not stored in the fixture, so it is not listed as a fixture needle.
# Its redaction is still asserted via the STRIPE_KEY category check above.
for needle in "gho_1234567890" "AKIA1234567890" "xoxb-1234567890" "AIzaSy" "sk-ant-api03" "wordpress-1234567" "example_staging_automation" "BEGIN OPENSSH PRIVATE KEY"; do
  if echo "$STDOUT" | grep -qF "$needle"; then
    echo "FAIL: raw fixture token survived: $needle"
    FAIL=1
  else
    echo "PASS: raw fixture token absent: $needle"
  fi
done

# Assertion 4: summary line was appended
if echo "$STDOUT" | grep -q "\[output-redact:"; then
  echo "PASS: redaction summary line present"
else
  echo "FAIL: redaction summary line missing"
  FAIL=1
fi

# Assertion 5: clean input (no secrets) must emit NOTHING → no replacement, so
# the original output stands unchanged. Emitting an empty/way-different output
# for benign commands would corrupt normal tool results.
CLEAN_IN='{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":{"stdout":"just a normal line, nothing secret here","stderr":"","exit_code":0}}'
CLEAN_OUT="$(printf '%s' "$CLEAN_IN" | node "$HOOK")"
if [ -z "$CLEAN_OUT" ]; then
  echo "PASS: clean input emits nothing (original output preserved)"
else
  echo "FAIL: clean input produced output (would wrongly replace benign result): ${CLEAN_OUT:0:120}"
  FAIL=1
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✅ ALL TESTS PASSED"
  exit 0
else
  echo "❌ TESTS FAILED — see above"
  exit 1
fi
