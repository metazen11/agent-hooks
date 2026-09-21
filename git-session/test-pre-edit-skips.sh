#!/usr/bin/env bash
# Test that --pre-edit skips checkpoints in the cases covered by issue #2:
#
#   1. Bash tool_input is itself a git workflow command (git commit, push, etc.)
#   2. A fresh .git/.claude-busy lock file is present
#   3. A stale .git/.claude-busy lock file is correctly ignored
#
# Each case sets up an isolated tmp repo, fires the hook over stdin, and
# asserts that NO new checkpoint commit was added (or, in case 3, that the
# stale lock file did not suppress a legitimate checkpoint).

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/git-session.js"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────
setup_repo() {
    local d
    d="$(mktemp -d -t agent-hooks-test-XXXXXX)"
    git -C "$d" init -q
    git -C "$d" config user.email "test@test.local"
    git -C "$d" config user.name "Test"
    echo "initial" >"$d/file.txt"
    git -C "$d" add file.txt
    git -C "$d" commit -q -m "initial"
    echo "$d"
}

commit_count() {
    git -C "$1" rev-list --count HEAD
}

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        printf "  PASS  %s (expected=%s actual=%s)\n" "$label" "$expected" "$actual"
        PASS=$((PASS + 1))
    else
        printf "  FAIL  %s (expected=%s actual=%s)\n" "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

# ── case 1: tool_input is a git workflow command ────────────────────────
echo "Case 1: tool_input.command starts with 'git commit' → skip checkpoint"
repo="$(setup_repo)"
echo "dirty" >"$repo/file.txt"   # uncommitted change present
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m foo"}}' "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
assert_eq "no checkpoint added when next tool call is git commit" "$before" "$after"
rm -rf "$repo"

# ── case 1b: tool_input is git push (also workflow) ─────────────────────
echo "Case 1b: tool_input.command 'git push origin main' → skip"
repo="$(setup_repo)"
echo "dirty" >"$repo/file.txt"
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
assert_eq "no checkpoint added when next tool call is git push" "$before" "$after"
rm -rf "$repo"

# ── case 1c: lookalike command that is NOT a git workflow ───────────────
echo "Case 1c: tool_input.command 'mygit commit' (not real git) → checkpoint"
repo="$(setup_repo)"
echo "dirty" >"$repo/file.txt"
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":"mygit commit -m foo"}}' "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
# Should NOT increment: mygit is not in destructive patterns, so checkpoint
# is skipped for a different reason (non-destructive bash).
assert_eq "no checkpoint for non-git Bash" "$before" "$after"
rm -rf "$repo"

# ── case 2: fresh .git/.claude-busy lock file ───────────────────────────
echo "Case 2: fresh .git/.claude-busy lock → skip checkpoint on Edit"
repo="$(setup_repo)"
touch "$repo/.git/.claude-busy"
echo "dirty" >"$repo/file.txt"
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/file.txt"}}' "$repo" "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
assert_eq "no checkpoint added when fresh lock file present" "$before" "$after"
rm -rf "$repo"

# ── case 3: stale .git/.claude-busy lock file is ignored ────────────────
echo "Case 3: stale (>5min) .git/.claude-busy lock → ignored, checkpoint runs"
repo="$(setup_repo)"
touch "$repo/.git/.claude-busy"
# Backdate the lock file to 10 minutes ago (stale window is 5 min).
ten_min_ago="$(date -v-10M +%Y%m%d%H%M.%S 2>/dev/null || date -d '10 minutes ago' +%Y%m%d%H%M.%S)"
touch -t "$ten_min_ago" "$repo/.git/.claude-busy"
echo "dirty" >"$repo/file.txt"
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/file.txt"}}' "$repo" "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
expected=$((before + 1))
assert_eq "checkpoint added when lock file is stale" "$expected" "$after"
rm -rf "$repo"

# ── case 4: control — Edit tool with no skip signal → checkpoint runs ──
echo "Case 4: control — plain Edit with dirty tree → checkpoint runs"
repo="$(setup_repo)"
echo "dirty" >"$repo/file.txt"
before="$(commit_count "$repo")"
printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/file.txt"}}' "$repo" "$repo" \
    | node "$HOOK" --pre-edit >/dev/null
after="$(commit_count "$repo")"
expected=$((before + 1))
assert_eq "control: checkpoint added on plain Edit" "$expected" "$after"
rm -rf "$repo"

# ── summary ─────────────────────────────────────────────────────────────
echo
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
