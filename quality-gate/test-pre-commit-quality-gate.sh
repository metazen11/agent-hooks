#!/usr/bin/env bash
# The plan-validation pre-commit hook must count plans without aborting:
# bash >= 4.1 exits on `((n++))` from 0 under `set -e`, which blocked every
# commit that staged a plan before validation ran. Run under both shells.
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/hooks/pre-commit-quality-gate.sh"
T=$(mktemp -d); trap 'find "$T" -delete' EXIT
cd "$T" || exit 1
git init -q .; git config user.email t@example.invalid; git config user.name t
mkdir -p plans scripts
# Stub validators (the hook picks python+jsonschema, else node): a plan is
# valid when it contains "ok"; otherwise print a reason on stderr and fail.
cat > scripts/validate_quality_gate.py <<'EOF'
import sys
if "ok" in open(sys.argv[1]).read(): sys.exit(0)
sys.stderr.write("stub: plan rejected\n"); sys.exit(1)
EOF
cat > scripts/validate_quality_gate_node.js <<'EOF'
if (require('fs').readFileSync(process.argv[2], 'utf8').includes('ok')) process.exit(0);
process.stderr.write('stub: plan rejected\n'); process.exit(1);
EOF
fails=0
check() { # check <label> <want-exit> <needle>...
  local label=$1 want=$2; shift 2
  local out rc needle
  out=$(bash "$HOOK" 2>&1); rc=$?
  [ "$rc" -eq "$want" ] || { echo "FAIL $label: exit $rc, want $want"; fails=1; }
  for needle in "$@"; do
    case "$out" in *"$needle"*) ;; *) echo "FAIL $label: missing '$needle'"; fails=1;; esac
  done
}

echo '{"ok": true}' > plans/good.json; git add plans/good.json
check "one valid plan" 0 "Quality gate PASSED" "1 plan(s) validated"

echo '{"bad": true}' > plans/bad.json; git add plans/bad.json
check "valid + invalid" 1 "stub: plan rejected" "Quality gate FAILED" "1 of 2 plan(s) invalid"

[ "$fails" -eq 0 ] && echo PASS
exit "$fails"
