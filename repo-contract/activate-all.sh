#!/usr/bin/env bash
# activate-all.sh — retrofit EXISTING clones.
#
#   ./activate-all.sh [root]          # default root: ~/_CODING
#   ./activate-all.sh [root] --dry-run
#
# A git template only applies at clone time, so repos you already have stay
# inert. This walks a directory tree and activates the contract in every repo
# that ships a .githooks/ directory.
#
# Never overrides an existing core.hooksPath — an explicit choice wins.
set -uo pipefail

ROOT="${1:-$HOME/_CODING}"
[ "$ROOT" = "--dry-run" ] && { ROOT="$HOME/_CODING"; DRY=1; } || DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

[ -d "$ROOT" ] || { echo "no such directory: $ROOT" >&2; exit 1; }

echo "  scanning $ROOT${DRY:+ (dry run)}"
n_act=0; n_skip=0; n_none=0

# -prune keeps us out of nested worktrees, node_modules and venvs.
while IFS= read -r gitdir; do
    repo="$(dirname "$gitdir")"
    if [ ! -d "$repo/.githooks" ]; then
        n_none=$((n_none+1)); continue
    fi
    current="$(git -C "$repo" config --get core.hooksPath 2>/dev/null || true)"
    if [ "$current" = ".githooks" ]; then
        printf "  ·  %-38s already active\n" "$(basename "$repo")"; n_skip=$((n_skip+1)); continue
    fi
    if [ -n "$current" ]; then
        printf "  ⚠  %-38s hooksPath='%s' — left alone\n" "$(basename "$repo")" "$current"
        n_skip=$((n_skip+1)); continue
    fi
    if [ "$DRY" = "1" ]; then
        printf "  →  %-38s would activate\n" "$(basename "$repo")"
    else
        git -C "$repo" config core.hooksPath .githooks
        printf "  ✓  %-38s activated\n" "$(basename "$repo")"
    fi
    n_act=$((n_act+1))
done < <(find "$ROOT" -maxdepth 4 -type d \( -name node_modules -o -name .venv -o -name worktrees \) -prune -o -type d -name .git -print 2>/dev/null)

echo
echo "  ${n_act} activated, ${n_skip} already set, ${n_none} without .githooks"
