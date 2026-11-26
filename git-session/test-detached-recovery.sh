#!/usr/bin/env bash
# Regression coverage for detached SessionStart/SessionEnd handling.
# All repositories and remotes are temporary local scratch repositories.
set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/git-session.js"
PASS=0
FAIL=0

check() {
  local label="$1"; shift
  if "$@"; then printf '  PASS  %s\n' "$label"; PASS=$((PASS + 1))
  else printf '  FAIL  %s\n' "$label"; FAIL=$((FAIL + 1)); fi
}

setup() {
  local d
  d="$(mktemp -d -t agent-hooks-detached-XXXXXX)"
  git init -q --bare --initial-branch=main "$d/remote.git"
  git init -q -b main "$d/seed"
  git -C "$d/seed" config user.email test@test.local
  git -C "$d/seed" config user.name Test
  git -C "$d/seed" remote add origin "$d/remote.git"
  echo base >"$d/seed/file.txt"
  git -C "$d/seed" add file.txt
  git -C "$d/seed" commit -q -m base
  git -C "$d/seed" push -q -u origin main
  git -C "$d/seed" checkout -q -b dev
  echo dev >"$d/seed/dev.txt"
  git -C "$d/seed" add dev.txt
  git -C "$d/seed" commit -q -m dev-tip
  git -C "$d/seed" push -q -u origin dev
  git -C "$d/remote.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$d/remote.git" "$d/w"
  git -C "$d/w" fetch -q origin
  git -C "$d/w" remote set-head origin main
  git -C "$d/w" config user.email test@test.local
  git -C "$d/w" config user.name Test
  echo "$d"
}

run_start() {
  local dir="$1"; shift
  printf '{"cwd":"%s/w","hook_event_name":"SessionStart","session_id":"test"}' "$dir" \
    | (cd "$dir/w" && env "$@" node "$HOOK" --session-start)
}

echo 'Case 1: legacy repo prefers dev over origin/HEAD=main'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
echo remote-later >"$d/seed/later.txt"
git -C "$d/seed" add later.txt
git -C "$d/seed" commit -q -m remote-later
git -C "$d/seed" push -q origin dev
cached_dev="$(git -C "$d/w" rev-parse origin/dev)"
remote_dev="$(git --git-dir="$d/remote.git" rev-parse refs/heads/dev)"
run_start "$d" >"$d/out.json" 2>"$d/err"
branch="$(git -C "$d/w" branch --show-current)"
check 'recovered to named branch' test "$branch" '!=' HEAD
check 'named branch based on cached origin/dev tip' test "$(git -C "$d/w" rev-parse HEAD)" = "$cached_dev"
check 'recovery does not fetch or pull newer remote state' test "$(git -C "$d/w" rev-parse HEAD)" '!=' "$remote_dev"
check 'recovery outcome is visible' grep -q 'attached clean worktree to refs/remotes/origin/dev' "$d/out.json"
rm -rf "$d"

echo 'Case 2: dirty detached work preserves staged, unstaged and untracked state'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
echo staged >"$d/w/staged.txt"; git -C "$d/w" add staged.txt
echo unstaged >>"$d/w/file.txt"
echo untracked >"$d/w/new.txt"
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'branch uses prior detached SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'staged delta remains staged' test "$(git -C "$d/w" diff --cached --name-only)" = staged.txt
check 'unstaged delta remains unstaged' grep -q 'file.txt' <(git -C "$d/w" diff --name-only)
check 'untracked file remains' test "$(cat "$d/w/new.txt")" = untracked
rm -rf "$d"

echo 'Case 3: detached unique commit remains reachable'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
echo unique >"$d/w/unique.txt"; git -C "$d/w" add unique.txt; git -C "$d/w" commit -q -m unique
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'unique commit remains branch HEAD' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
rm -rf "$d"

echo 'Case 4: ambiguous legacy target fails closed'
d="$(setup)"
git -C "$d/seed" push -q origin dev:develop
git -C "$d/w" fetch -q origin
git -C "$d/w" checkout -q --detach origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'ambiguous target leaves HEAD detached' test "$(git -C "$d/w" branch --show-current)" = ''
check 'ambiguous target preserves SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'ambiguity is visible' grep -q 'both origin/dev and origin/develop exist' "$d/out.json"
rm -rf "$d"

echo 'Case 5: explicit integration override wins over ambiguous discovery'
d="$(setup)"
git -C "$d/seed" push -q origin dev:develop
git -C "$d/w" fetch -q origin
git -C "$d/w" checkout -q --detach origin/main
run_start "$d" GIT_HOOK_INTEGRATION_BRANCH=origin/dev >"$d/out.json" 2>"$d/err"
check 'override selects dev tip' test "$(git -C "$d/w" rev-parse HEAD)" = "$(git -C "$d/w" rev-parse origin/dev)"
rm -rf "$d"

echo 'Case 6: invalid explicit override fails closed'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" GIT_HOOK_INTEGRATION_BRANCH=../../invalid >"$d/out.json" 2>"$d/err"
check 'invalid override leaves HEAD detached' test "$(git -C "$d/w" branch --show-current)" = ''
check 'invalid override preserves SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'invalid override reports failure' grep -q 'not a valid origin tracking ref' "$d/out.json"
rm -rf "$d"

echo 'Case 7: unsupported policy model fails closed'
d="$(setup)"
printf '{"model":"typo"}\n' >"$d/w/.reconcile-gate.json"
git -C "$d/w" checkout -q --detach origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'unsupported policy leaves HEAD detached' test "$(git -C "$d/w" branch --show-current)" = ''
check 'unsupported policy preserves SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'unsupported policy is visible' grep -q 'unsupported' "$d/out.json"
rm -rf "$d"

echo 'Case 8: no legacy refs falls back to origin/HEAD'
d="$(setup)"
git -C "$d/w" update-ref -d refs/remotes/origin/dev
git -C "$d/w" update-ref -d refs/remotes/origin/develop
git -C "$d/w" checkout -q --detach origin/main
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'fallback selects origin/HEAD' test "$(git -C "$d/w" rev-parse HEAD)" = "$(git -C "$d/w" rev-parse origin/HEAD)"
rm -rf "$d"

echo 'Case 9: missing legacy target and origin/HEAD fails closed'
d="$(setup)"
git -C "$d/w" update-ref -d refs/remotes/origin/dev
git -C "$d/w" update-ref -d refs/remotes/origin/develop
git -C "$d/w" symbolic-ref --delete refs/remotes/origin/HEAD
git -C "$d/w" checkout -q --detach origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'missing target leaves HEAD detached' test "$(git -C "$d/w" branch --show-current)" = ''
check 'missing target preserves SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'missing target is visible' grep -q 'no legacy integration ref' "$d/out.json"
rm -rf "$d"

echo 'Case 10: invalid branch name fails without changing detached state'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" GIT_HOOK_BRANCH_PREFIX=bad..prefix >"$d/out.json" 2>"$d/err"
check 'branch creation failure leaves HEAD detached' test "$(git -C "$d/w" branch --show-current)" = ''
check 'branch creation failure preserves SHA' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'branch creation failure is visible' grep -q 'could not create' "$d/out.json"
rm -rf "$d"

echo 'Case 11: single-trunk repo follows origin/HEAD'
d="$(setup)"
printf '{"model":"single-trunk"}\n' >"$d/w/.reconcile-gate.json"
git -C "$d/w" checkout -q --detach origin/main
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'single-trunk branch based on origin/HEAD main' test "$(git -C "$d/w" rev-parse HEAD)" = "$(git -C "$d/w" rev-parse origin/main)"
rm -rf "$d"

echo 'Case 12: detached SessionEnd is visible and preserves dirty state'
d="$(setup)"
git -C "$d/w" checkout -q --detach origin/main
echo dirty >"$d/w/file.txt"
before="$(git -C "$d/w" rev-parse HEAD)"
printf '{"cwd":"%s/w","hook_event_name":"SessionEnd","session_id":"test"}' "$d" \
  | (cd "$d/w" && node "$HOOK" --session-end) >"$d/out.json" 2>"$d/err"
check 'no detached commit created' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
check 'dirty content remains' test "$(cat "$d/w/file.txt")" = dirty
check 'nothing committed message visible' grep -q 'nothing was committed' "$d/out.json"
rm -rf "$d"

echo 'Case 13: named feature branch is untouched'
d="$(setup)"
git -C "$d/w" checkout -q -b work/feature origin/main
before="$(git -C "$d/w" rev-parse HEAD)"
run_start "$d" >"$d/out.json" 2>"$d/err"
check 'branch name unchanged' test "$(git -C "$d/w" branch --show-current)" = work/feature
check 'branch SHA unchanged' test "$(git -C "$d/w" rev-parse HEAD)" = "$before"
rm -rf "$d"

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
