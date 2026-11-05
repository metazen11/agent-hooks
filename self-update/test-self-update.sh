#!/usr/bin/env bash
# Self-test for self-update. Run: ./test-self-update.sh
# Builds a throwaway remote + clone and drives every refusal path.
set -uo pipefail
cd "$(dirname "$0")"; HOOK=$PWD/self-update.js
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# Throttle state lives under $HOME/.claude/state: keep it out of the real home.
export HOME="$TMP/home"; mkdir -p "$HOME"
pass=0; fail=0
ok(){ printf '  ✓  %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  ✗  %s\n' "$1"; fail=$((fail+1)); }
chk(){ [ "$2" = "$3" ] && ok "$1" || { no "$1"; printf '       want=%s got=%s\n' "$3" "$2"; }; }

git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/up" 2>/dev/null
( cd "$TMP/up"; git config user.email t@t; git config user.name T
  echo v1 > f.txt; git add .; git commit -qm v1; git branch -M dev; git push -qu origin dev )
git clone -q "$TMP/remote.git" "$TMP/w" 2>/dev/null
( cd "$TMP/w"; git config user.email t@t; git config user.name T; git checkout -q dev )
( cd "$TMP/up"; echo v2 >> f.txt; git commit -qam v2; git push -q )

cat > "$TMP/repos.json" <<JSON
{"repos":[{"slug":"fx","path":"$TMP/w","branch":"dev"}]}
JSON
cp "$HOOK" "$TMP/self-update.js"
RUN(){ ( cd "$TMP" && SELF_UPDATE_EVERY_HOURS=0 node self-update.js "$@" 2>&1 ); }
HEAD_OF(){ git -C "$TMP/w" rev-parse HEAD; }

echo "self-update self-test"; echo "────────────────────────────────"

echo "throttle parsing:"
chk "EVERY=0 forces a check (not 24h)" "$(RUN --session-start | grep -c '^- fx:')" 1
# Second identical run must ALSO fire: EVERY=0 means never throttle.
chk "EVERY=0 not throttled on re-run"  "$(RUN --session-start | grep -c '^- fx:')" 1
# ...whereas the default 24h window suppresses the second check.
( cd "$TMP" && node self-update.js --session-start >/dev/null 2>&1 )
chk "default window throttles re-run"  "$( cd "$TMP" && node self-update.js --session-start 2>&1 | grep -c 'ASK THE USER')" 0

echo "notify-only default:"
B=$(HEAD_OF); out=$(RUN --session-start)
chk "prompts when behind"      "$(echo "$out" | grep -c 'ASK THE USER')" 1
chk "HEAD untouched"           "$(HEAD_OF)" "$B"

echo "refusals (local work must survive):"
echo dirty >> "$TMP/w/f.txt"; B=$(HEAD_OF)
chk "dirty tree refused"       "$(RUN --apply --now | grep -c 'uncommitted')" 1
chk "  HEAD untouched"         "$(HEAD_OF)" "$B"
chk "  local edit survived"    "$(grep -c dirty "$TMP/w/f.txt")" 1
git -C "$TMP/w" checkout -q -- f.txt

git -C "$TMP/w" checkout -qb side; B=$(HEAD_OF)
chk "wrong branch refused"     "$(RUN --apply --now | grep -c "not 'dev'")" 1
chk "  HEAD untouched"         "$(HEAD_OF)" "$B"
git -C "$TMP/w" checkout -q dev

echo local > "$TMP/w/l.txt"; git -C "$TMP/w" add .; git -C "$TMP/w" commit -qm local; B=$(HEAD_OF)
chk "diverged refused"         "$(RUN --apply --now | grep -c 'diverged')" 1
chk "  local commit survived"  "$(HEAD_OF)" "$B"
git -C "$TMP/w" reset -q --hard HEAD~1

# #44: NOTIFY answers "does this checkout lack commits that are on
# origin/<branch>?" whatever is checked out — git-session parks every checkout
# on work/session-*. It reports and never modifies; --apply still refuses.
SNAP(){ git -C "$TMP/w" rev-parse --abbrev-ref HEAD; HEAD_OF; git -C "$TMP/w" status --porcelain; git -C "$TMP/w" stash list; }
NOTE(){ echo "$out" | grep -c "^- fx: 1 new commit on origin/dev; $1"; }

echo "notify whatever is checked out (#44):"
WB=work/session-fixture
git -C "$TMP/w" checkout -qb "$WB"
echo wip > "$TMP/w/wip.txt"; git -C "$TMP/w" add .; git -C "$TMP/w" commit -qm wip
B=$(SNAP); out=$(RUN --session-start)
chk "work branch + behind reported"  "$(NOTE "on '$WB', not 'dev'")" 1
chk "  no merge command offered"     "$(echo "$out" | grep -c 'merge --ff-only')" 0
chk "  repo untouched"               "$(SNAP)" "$B"
chk "--apply on work branch refused" "$(RUN --apply --now | grep -c "not 'dev'")" 1
chk "  repo untouched"               "$(SNAP)" "$B"

git -C "$TMP/w" merge -q --no-edit origin/dev   # work branch now holds all of origin/dev
chk "work branch + up to date: checked, current" "$(RUN | grep -c '^  current  *fx ')" 1
chk "  silent in hook mode"          "$(RUN --session-start)" ""
git -C "$TMP/w" checkout -q dev

echo dirty >> "$TMP/w/f.txt"; B=$(SNAP); out=$(RUN --session-start)
chk "dirty + behind reported"        "$(NOTE '1 uncommitted change')" 1
chk "  no merge command offered"     "$(echo "$out" | grep -c 'merge --ff-only')" 0
chk "  HEAD, branch, tree untouched" "$(SNAP)" "$B"
chk "  local edit survived"          "$(grep -c dirty "$TMP/w/f.txt")" 1
git -C "$TMP/w" checkout -q -- f.txt

echo local > "$TMP/w/l.txt"; git -C "$TMP/w" add .; git -C "$TMP/w" commit -qm local
B=$(SNAP); out=$(RUN --session-start)
chk "diverged + behind reported"     "$(NOTE 'diverged')" 1
chk "  no merge command offered"     "$(echo "$out" | grep -c 'merge --ff-only')" 0
chk "  local commit survived"        "$(SNAP)" "$B"
git -C "$TMP/w" reset -q --hard HEAD~1

touch "$TMP/w/.git/MERGE_HEAD"; B=$(SNAP)
chk "in-progress op: notify silent"  "$(RUN --session-start)" ""
chk "  --apply refused"              "$(RUN --apply --now | grep -c 'MERGE_HEAD in progress')" 1
rm -f "$TMP/w/.git/MERGE_HEAD"
chk "  repo untouched"               "$(SNAP)" "$B"

echo "apply (the one safe case):"
B=$(HEAD_OF); RUN --apply --now >/dev/null
[ "$(HEAD_OF)" != "$B" ] && ok "fast-forwarded when clean+behind" || no "should have advanced"
chk "  content correct"        "$(tr -d '\n' < "$TMP/w/f.txt")" "v1v2"

echo "────────────────────────────────"; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
