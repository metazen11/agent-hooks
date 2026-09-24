#!/usr/bin/env bash
# bootstrap.sh — make a MACHINE contract-ready, in one idempotent command.
#
#   ./bootstrap.sh              # template + retrofit ~/_CODING
#   ./bootstrap.sh /some/root   # retrofit a different tree
#   ./bootstrap.sh --check      # report, change nothing
#
# Safe to run repeatedly and safe to call from another installer (e.g. the
# prompt-pack sync): it never overrides an explicit core.hooksPath, and it
# exits 0 when there is nothing to do.
#
# This is the ONE command a new machine needs. Everything else follows:
#   · future clones self-activate (git template)
#   · existing clones get retrofitted (activate-all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$HOME/_CODING}"

if [ "${1:-}" = "--check" ]; then
    echo "contract bootstrap — status"
    "$HERE/install-template.sh" --check
    echo
    "$HERE/activate-all.sh" "$HOME/_CODING" --dry-run
    exit 0
fi

echo "contract bootstrap"
echo "─────────────────────────────────────────────"
echo "1. git template (future clones self-activate)"
"$HERE/install-template.sh"
echo
echo "2. retrofit existing clones under $ROOT"
"$HERE/activate-all.sh" "$ROOT"
echo "─────────────────────────────────────────────"
echo "Done. New clones activate themselves; existing ones are wired."
