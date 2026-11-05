#!/usr/bin/env bash
# Runs every node test suite: <pkg>/test.js and <pkg>/tests/*.test.js.
# Run: ./test-node-suites.sh
#
# CI discovers only test-*.sh, so this wrapper is what puts the node suites in
# front of it. Suites are discovered, not listed, so a new one cannot be left
# out. Each runs from its own package directory, as its package.json does.
set -uo pipefail
cd "$(dirname "$0")"
ran=0; fail=0

for suite in */test.js */tests/*.test.js; do
  [ -f "$suite" ] || continue
  pkg=${suite%%/*}; file=${suite#*/}
  echo "──── $suite ────"
  case "$file" in
    # `node --test` takes files: a directory argument fails on newer Node.
    test.js) ( cd "$pkg" && node test.js ) ;;
    *)       ( cd "$pkg" && node --test "$file" ) ;;
  esac || { printf '  ✗  %s failed\n' "$suite"; fail=$((fail+1)); }
  ran=$((ran+1))
done

echo "────────────────────────────────"; echo "  $ran suites run, $fail failed"
# Zero suites found is a broken discovery, not a pass.
[ "$ran" -gt 0 ] && [ "$fail" -eq 0 ]
