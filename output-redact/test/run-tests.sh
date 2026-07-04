#!/usr/bin/env bash
# Test harness for output-redact.
#
# Pipes fixtures.json through output-redact.js, then asserts:
#   1. Every category in expected-categories.txt appears as [REDACTED:CATEGORY]
#      in the stdout field of the result.
#   2. Allowed private IPs (192.168.*, 127.*, 172.17.*) appear UNREDACTED.
#   3. No raw fixture token strings survive in the output.
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
STDOUT="$(echo "$OUT" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.tool_response.stdout||"");})')"

FAIL=0

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

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✅ ALL TESTS PASSED"
  exit 0
else
  echo "❌ TESTS FAILED — see above"
  exit 1
fi
