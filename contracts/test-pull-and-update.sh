#!/usr/bin/env bash
# Self-test for pull-and-update.sh. Run: ./test-pull-and-update.sh
# Builds a throwaway remote + clone carrying this package, points HOME at a
# temp dir, and drives the real script end to end: pull, then reinstall.
set -uo pipefail
cd "$(dirname "$0")"; SRC=$(cd .. && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok(){ printf '  ✓  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  ✗  %s\n' "$1"; fail=$((fail+1)); }
chk(){ [ "$2" = "$3" ] && ok "$1" || { no "$1"; printf '       want=%s got=%s\n' "$3" "$2"; }; }

# Every agent "detected", so --all exercises all four installers.
FAKE_HOME=$TMP/home
mkdir -p "$FAKE_HOME/.claude" "$FAKE_HOME/.anvil" "$FAKE_HOME/.codex" "$FAKE_HOME/.gemini"

git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/up" 2>/dev/null
# The package plus the tracked instruction files the installer appends to: the
# real repo carries them, so a reinstall must leave the tree clean.
cp -R "$SRC/contracts" "$SRC/.anvil" "$SRC/AGENTS.md" "$SRC/GEMINI.md" "$TMP/up/"
( cd "$TMP/up"; git config user.email t@t; git config user.name T
  git add -A; git commit -qm v1; git branch -M main; git push -qu origin main )
git clone -q -b main "$TMP/remote.git" "$TMP/hooks" 2>/dev/null
( cd "$TMP/up"; echo v2 > f.txt; git add .; git commit -qm v2; git push -q )

RUN(){ HOME="$FAKE_HOME" CONTRACTS_HOOKS_REPO="$TMP/hooks" bash "$TMP/hooks/contracts/pull-and-update.sh" 2>&1; }
LINK=$FAKE_HOME/.claude/hooks/contracts

echo "pull-and-update self-test"; echo "────────────────────────────────"

echo "update available:"
out=$(RUN); rc=$?
chk "exits 0"                      "$rc" 0
[ "$rc" -eq 0 ] || printf '%s\n' "$out" | sed 's/^/       /'
chk "fast-forwarded to remote"     "$(git -C "$TMP/hooks" rev-parse HEAD)" "$(git -C "$TMP/up" rev-parse HEAD)"
chk "claude hook symlinked"        "$(cd "$LINK" 2>/dev/null && pwd -P)" "$(cd "$TMP/hooks/contracts" && pwd -P)"
chk "PreToolUse entry wired"       "$(grep -c 'contracts-hook.js' "$FAKE_HOME/.claude/settings.json" 2>/dev/null)" 1
chk "tree left clean"              "$(git -C "$TMP/hooks" status --porcelain | wc -l | tr -d ' ')" 0

echo "nothing to update (re-run is idempotent):"
out=$(RUN); rc=$?
chk "exits 0"                      "$rc" 0
chk "PreToolUse entry not doubled" "$(grep -c 'contracts-hook.js' "$FAKE_HOME/.claude/settings.json" 2>/dev/null)" 1

echo "────────────────────────────────"; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
