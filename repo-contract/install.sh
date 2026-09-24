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
cp "$SRC/workflows/contract-integrity.yml" .github/workflows/contract-integrity.yml
[ -f CONTRIBUTING.md ] || cp "$SRC/CONTRIBUTING.md" CONTRIBUTING.md

# README section — idempotent: only added when absent, so re-running never
# duplicates it. The README is the file people actually open first; without a
# pointer here the contract is invisible to anyone who does not know to look
# in CONTRIBUTING.md.
if [ -f README.md ] && ! grep -q '^## Branching contract' README.md; then
    python3 - "$SRC/README-section.md" <<'PYEOF'
import re, sys, pathlib
sec = pathlib.Path(sys.argv[1]).read_text().rstrip() + "\n"
p = pathlib.Path("README.md"); s = p.read_text()
m = list(re.finditer(r"^## ", s, re.M))
idx = m[1].start() if len(m) >= 2 else (m[0].start() if m else len(s))
p.write_text(s[:idx] + sec + "\n" + s[idx:])
PYEOF
    echo "  ✓ README.md (branching contract section)"
fi

git config core.hooksPath .githooks

echo "  ✓ .githooks/pre-push"
echo "  ✓ .github/workflows/trunk-drift.yml"
echo "  ✓ .github/workflows/contract-integrity.yml"
echo "  ✓ CONTRIBUTING.md"
echo "  ✓ core.hooksPath -> .githooks"
echo
echo "  Commit these, then run once per clone on every other machine:"
echo "      git config core.hooksPath .githooks"
