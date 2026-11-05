#!/usr/bin/env bash
# The pre-commit hook must run related tests with the project's venv pytest,
# from the main checkout and from a linked worktree, not whatever is on PATH.
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/pre-commit"
T=$(mktemp -d); trap 'chmod -R u+w "$T"; find "$T" -delete' EXIT
R="$T/repo"; M="$T/used"
mkdir -p "$R/.venv/bin" "$R/tests"; cd "$R" || exit 1
git init -q .; git config user.email t@example.invalid; git config user.name t
printf '.venv/\n' > .gitignore
printf '#!/bin/sh\necho venv >> "%s"\n' "$M" > .venv/bin/pytest; chmod +x .venv/bin/pytest
printf 'X = 1\n' > foo.py; printf 'def test_x():\n    pass\n' > tests/test_foo.py
git add -A; git commit -qm init
printf 'X = 2\n' > foo.py; git add foo.py
bash "$HOOK" >/dev/null 2>&1
[ "$(cat "$M" 2>/dev/null)" = "venv" ] || { echo "FAIL main checkout did not use venv pytest"; exit 1; }
: > "$M"; git commit -qm two
git worktree add -q "$T/wt" -b wt; cd "$T/wt" || exit 1
printf 'X = 3\n' > foo.py; git add foo.py
bash "$HOOK" >/dev/null 2>&1
[ "$(cat "$M" 2>/dev/null)" = "venv" ] || { echo "FAIL linked worktree did not use main venv pytest"; exit 1; }
echo PASS
