#!/usr/bin/env bash
#
# pre-commit-quality-gate.sh — Validates plans/*.json on commit
#
# Finds staged plans/*.json files and validates each against the
# quality gate schema. Blocks commit if any fail.
# No-op if no plans/*.json files are staged.
#
# Expects either Python (with jsonschema) or Node.js to be available.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Find staged plans/*.json files
STAGED_PLANS=$(git diff --cached --name-only --diff-filter=ACM | grep '^plans/.*\.json$' || true)

if [[ -z "$STAGED_PLANS" ]]; then
  exit 0
fi

echo ""
echo "=========================================="
echo "  Quality Gate — Plan Validation"
echo "=========================================="
echo ""

# Detect validator
VALIDATOR=""
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import jsonschema" 2>/dev/null; then
    VALIDATOR="python3 ${REPO_ROOT}/scripts/validate_quality_gate.py"
  fi
fi

if [[ -z "$VALIDATOR" ]] && command -v node >/dev/null 2>&1; then
  if [[ -f "${REPO_ROOT}/scripts/validate_quality_gate_node.js" ]]; then
    VALIDATOR="node ${REPO_ROOT}/scripts/validate_quality_gate_node.js"
  fi
fi

if [[ -z "$VALIDATOR" ]]; then
  echo -e "${YELLOW}[WARN]${NC} No validator available (need Python+jsonschema or Node.js)"
  echo "  Skipping plan validation."
  exit 0
fi

ERRORS=0
TOTAL=0

for file in $STAGED_PLANS; do
  ((TOTAL++))
  if [[ ! -f "$file" ]]; then
    continue
  fi

  echo -n "  Validating ${file}... "

  if $VALIDATOR "$file" >/dev/null 2>/tmp/quality-gate-err.txt; then
    echo -e "${GREEN}PASS${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    cat /tmp/quality-gate-err.txt | sed 's/^/    /'
    ((ERRORS++))
  fi
done

rm -f /tmp/quality-gate-err.txt

echo ""

if [[ $ERRORS -gt 0 ]]; then
  echo -e "${RED}Quality gate FAILED${NC} — $ERRORS of $TOTAL plan(s) invalid"
  echo ""
  echo "Fix the violations above and try again."
  echo "To bypass (not recommended): git commit --no-verify"
  exit 1
fi

echo -e "${GREEN}Quality gate PASSED${NC} — $TOTAL plan(s) validated"
echo ""
exit 0
