#!/usr/bin/env bash
# install.sh — install the branching contract into a repo.
#
#   ./install.sh /path/to/repo        # copy contract files + activate hooks
#   ./install.sh /path/to/repo --check # report what is/isn't installed
#
# Copies .githooks/pre-push, .github/workflows/trunk-drift.yml and
# CONTRIBUTING.md into the target repo, then activates the hook path.
#
# The hook path (`core.hooksPath`) is LOCAL config — it is not cloned. So
# every machine must run this once per clone. That is the known limit of the
# local layer; GitHub branch protection is the layer that needs no bootstrap.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?usage: install.sh /path/to/repo [--check]}"
CHECK="${2:-}"

[ -d "$TARGET/.git" ] || { echo "not a git repo: $TARGET" >&2; exit 1; }
cd "$TARGET"

if [ "$CHECK" = "--check" ]; then
    echo "  contract status for $TARGET:"
    printf "    %-34s %s\n" "core.hooksPath" "$(git config --get core.hooksPath || echo '(unset — hooks INACTIVE)')"
    for f in .githooks/pre-push .github/workflows/trunk-drift.yml .github/workflows/contract-integrity.yml CONTRIBUTING.md; do
        printf "    %-34s %s\n" "$f" "$([ -f "$f" ] && echo present || echo MISSING)"
    done
    exit 0
fi

mkdir -p .githooks .github/workflows
cp "$SRC/githooks/pre-push" .githooks/pre-push
chmod +x .githooks/pre-push
cp "$SRC/workflows/trunk-drift.yml" .github/workflows/trunk-drift.yml
[ -f CONTRIBUTING.md ] || cp "$SRC/CONTRIBUTING.md" CONTRIBUTING.md

git config core.hooksPath .githooks

echo "  ✓ .githooks/pre-push"
echo "  ✓ .github/workflows/trunk-drift.yml"
echo "  ✓ .github/workflows/contract-integrity.yml"
echo "  ✓ CONTRIBUTING.md"
echo "  ✓ core.hooksPath -> .githooks"
echo
echo "  Commit these, then run once per clone on every other machine:"
echo "      git config core.hooksPath .githooks"
