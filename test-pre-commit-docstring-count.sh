#!/usr/bin/env bash
# Documentation check and warning accounting of the pre-commit hook:
#  - counts are single integers (no bash "[[: syntax error" on files without
#    defs/docstrings) and the low-coverage warning still fires when it should;
#  - the TODO/FIXME warning fires only for files that contain one;
#  - a warning never aborts the hook (bash >= 4.1 exits on `((n++))` from 0
#    under `set -e`), so the summary is printed and the commit proceeds.
set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/pre-commit"
T=$(mktemp -d); trap 'find "$T" -delete' EXIT
cd "$T" || exit 1
git init -q .; git config user.email t@example.invalid; git config user.name t
printf 'X = 1\n' > nodefs.py
printf 'X = 1  # TODO: tidy\n' > todo.py
printf 'def a():\n    pass\ndef b():\n    pass\ndef c():\n    pass\ndef d():\n    pass\n' > many.py
printf 'def a():\n    """a."""\ndef b():\n    """b."""\ndef c():\n    """c."""\ndef d():\n    """d."""\n' > good.py
git add -A
OUT=$(bash "$HOOK" 2>&1); RC=$?
case "$OUT" in *'syntax error'*|*'[[:'*) echo "FAIL count is not a single integer"; exit 1;; esac
case "$OUT" in *'Low docstring coverage in many.py'*) ;; *) echo "FAIL no warning for undocumented many.py"; exit 1;; esac
case "$OUT" in *'Low docstring coverage in good.py'*) echo "FAIL warned on documented good.py"; exit 1;; esac
case "$OUT" in *'TODO/FIXME comments in todo.py'*) ;; *) echo "FAIL no TODO warning for todo.py"; exit 1;; esac
case "$OUT" in *'TODO/FIXME comments in nodefs.py'*) echo "FAIL TODO warning on a file without one"; exit 1;; esac
case "$OUT" in *'warning(s) found'*) ;; *) echo "FAIL hook aborted before the summary"; exit 1;; esac
[ "$RC" -eq 0 ] || { echo "FAIL warnings blocked the commit (exit $RC)"; exit 1; }
echo PASS
