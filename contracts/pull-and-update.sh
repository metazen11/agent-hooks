#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# pull-and-update.sh — Fast-forward the hooks repo and reinstall
# ─────────────────────────────────────────────────────────────
#
# Purpose:
#   Pull the latest `contracts/` hook package from origin/main (fast-forward
#   only per CONTRACT §7 reversibility — no merge, no rebase) and reinstall
#   for every detected agent on this machine.
#
# Usage:
#   ./pull-and-update.sh
#
# Exit codes:
#   0  success (or nothing to update)
#   1  pull failed (non-fast-forward, network error, dirty tree, etc.)
#   2  install step failed
#
# Configuration surface:
#   CONTRACTS_HOOKS_REPO  Absolute path to hooks git repo (default:
#                         ~/_CODING/hooks).
#   CONTRACTS_REMOTE      Remote name (default: origin).
#   CONTRACTS_BRANCH      Branch to pull (default: main).
#
# Per CONTRACT §6: no AI attribution in commit/PR text or comments.

set -euo pipefail

HOOKS_REPO="${CONTRACTS_HOOKS_REPO:-$HOME/_CODING/hooks}"
REMOTE="${CONTRACTS_REMOTE:-origin}"
BRANCH="${CONTRACTS_BRANCH:-main}"

fail() {
  printf '  \033[31mx\033[0m  %s\n' "$*" >&2
  exit "${2:-1}"
}

info() {
  printf '  \033[36m*\033[0m  %s\n' "$*"
}

ok() {
  printf '  \033[32m+\033[0m  %s\n' "$*"
}

if [[ ! -d "$HOOKS_REPO/.git" ]]; then
  fail "not a git repo: $HOOKS_REPO"
fi

cd "$HOOKS_REPO"

# Refuse to pull on top of a dirty tree (matches --ff-only semantics but with
# a clearer message than git's default).
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree has uncommitted changes in $HOOKS_REPO — resolve before updating"
fi

info "pulling $REMOTE/$BRANCH into $(git rev-parse --abbrev-ref HEAD) (fast-forward only)"

if ! git pull --ff-only "$REMOTE" "$BRANCH"; then
  fail "git pull --ff-only failed — resolve conflicts manually (CONTRACT §7)"
fi

SHORT_SHA="$(git rev-parse --short HEAD)"
ok "repo now at $SHORT_SHA"

INSTALL_JS="$HOOKS_REPO/contracts/install.js"
if [[ ! -f "$INSTALL_JS" ]]; then
  fail "install.js not found at $INSTALL_JS" 2
fi

info "reinstalling contracts hook for all detected agents"
cd "$HOOKS_REPO/contracts"

if ! node "$INSTALL_JS" --all; then
  fail "install.js --all exited non-zero" 2
fi

ok "contracts hook updated to $SHORT_SHA"
