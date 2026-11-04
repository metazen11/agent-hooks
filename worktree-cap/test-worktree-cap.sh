#!/usr/bin/env bash
# Shared CLI tests + one smoke test per adapter (Claude hook, Codex, Anvil). bash 3.2 safe.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset WORKTREE_CAP WORKTREE_CAP_DISABLE
fails=0; n=0
ok() { n=$((n+1)); if [[ "$1" == 0 ]]; then :; else fails=$((fails+1)); echo "FAIL: $2"; fi; }
eq() { [[ "$1" == "$2" ]]; ok $? "$3 (got '$1', want '$2')"; }
has() { [[ "$1" == *"$2"* ]]; ok $? "$3 (missing '$2' in: $1)"; }
hasnt() { [[ "$1" != *"$2"* ]]; ok $? "$3 (unexpected '$2')"; }

newrepo() { # name -> repo with origin/main
  git init -q --bare "$T/$1.git"; git clone -q "$T/$1.git" "$T/$1" 2>/dev/null
  git -C "$T/$1" checkout -q -b main; git -C "$T/$1" commit -q --allow-empty -m init; git -C "$T/$1" push -q origin main 2>/dev/null
}
unlanded() { # repo name  -> worktree with 1 commit ahead of origin/main
  git -C "$1" worktree add -q -b "$2" "$1/.worktrees/$2" origin/main; git -C "$1/.worktrees/$2" commit -q --allow-empty -m "w $2"
}
hook() { # json -> stdout
  printf '%s' "$1" | node "$D/worktree-cap.js" 2>/dev/null
}
bashj() { node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Bash",tool_input:{command:process.argv[2]}}))' "$1" "$2"; }
agentj() { node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Agent",tool_input:{isolation:process.argv[2]||undefined,prompt:"x"}}))' "$1" "${2:-}"; }
cap() { cat "$1/.worktree-cap" 2>/dev/null | tr -d '\n'; }

# ── cap blocks at 3, allows at 2 (cap file = 3) ──
newrepo a; echo 3 > "$T/a/.worktree-cap"
unlanded "$T/a" w1; unlanded "$T/a" w2
out=$(hook "$(bashj "$T/a" 'git worktree add .worktrees/x -b x')"); eq "$out" "" "allows at 2 unlanded"
unlanded "$T/a" w3
out=$(hook "$(bashj "$T/a" 'git worktree add .worktrees/x -b x')")
has "$out" '"deny"' "blocks at 3 (Bash)"; has "$out" "$T/a/.worktrees/w1" "block lists worktree path"
has "$out" "branch=w2" "block lists branch"; has "$out" "+1 commits" "block lists commits ahead"
has "$out" "/reconcile" "block gives next step"; has "$out" "cap is 3" "block shows cap"
out=$(hook "$(bashj "$T/a" 'git -C . worktree add .worktrees/x')"); has "$out" '"deny"' "blocks git -C form"
out=$(hook "$(agentj "$T/a" worktree)"); has "$out" '"deny"' "blocks Agent isolation=worktree"
out=$(hook "$(agentj "$T/a")"); eq "$out" "" "allows Agent without isolation"
out=$(hook "$(bashj "$T/a" 'git worktree list')"); eq "$out" "" "allows other git worktree cmds"
out=$(hook "$(bashj "$T/a" 'echo hi')"); eq "$out" "" "allows unrelated Bash"
out=$(WORKTREE_CAP_DISABLE=true hook "$(bashj "$T/a" 'git worktree add y')"); eq "$out" "" "bypass env"
out=$(hook "$(bashj /nonexistent 'git worktree add y')"); eq "$out" "" "non-repo allowed"
# CLI exit codes + JSON
node "$D/cli.js" check "$T/a" >/dev/null 2>&1; eq $? 2 "cli check exit 2 at cap"
out=$(node "$D/cli.js" check "$T/a" --json 2>/dev/null); has "$out" '"blocked":true' "cli json blocked"
node "$D/cli.js" add "$T/a" "$T/a/.worktrees/zz" -b zz >/dev/null 2>&1; eq $? 2 "cli add refused at cap"
[[ ! -d "$T/a/.worktrees/zz" ]]; ok $? "cli add created nothing"
echo 4 > "$T/a/.worktree-cap"
node "$D/cli.js" add "$T/a" "$T/a/.worktrees/zz" -b zz >/dev/null 2>&1; eq $? 0 "cli add succeeds under cap"
[[ -d "$T/a/.worktrees/zz" ]]; ok $? "cli add created worktree"

# ── ratchet: baseline 10 -> 13; cleanup to 4 -> 7; never increases ──
newrepo r; for i in 1 2 3 4 5 6 7 8 9 10; do unlanded "$T/r" r$i; done
node "$D/cli.js" check "$T/r" >/dev/null 2>&1; eq "$(cap "$T/r")" 13 "baseline 10 -> cap 13"
for i in 5 6 7 8 9 10; do git -C "$T/r" worktree remove --force ".worktrees/r$i"; done
node "$D/cli.js" check "$T/r" >/dev/null 2>&1; eq "$(cap "$T/r")" 7 "cleanup to 4 -> cap 7"
unlanded "$T/r" r11; unlanded "$T/r" r12
node "$D/cli.js" check "$T/r" >/dev/null 2>&1; eq "$(cap "$T/r")" 7 "cap not raised when count grows back"
for i in 1 2 3; do git -C "$T/r" worktree remove --force ".worktrees/r$i"; done
node "$D/cli.js" report "$T" >/dev/null 2>&1; node "$D/cli.js" report "$T/r" >/dev/null 2>&1
eq "$(cap "$T/r")" 6 "report also ratchets (3 unlanded -> 6)"
echo 2 > "$T/r/.worktree-cap"; node "$D/cli.js" check "$T/r" >/dev/null 2>&1; eq "$(cap "$T/r")" 2 "hand-lowered cap respected, not raised"
echo 4 > "$T/r/.worktree-cap"; WORKTREE_CAP=9 node "$D/cli.js" check "$T/r" >/dev/null 2>&1; eq "$(cap "$T/r")" 4 "env override not persisted"

# ── Stop: marker-based block ──
newrepo s; unlanded "$T/s" s1; unlanded "$T/s" s2
W="$T/s/.worktrees/s1"
node "$D/cli.js" stop "$T/s" >/dev/null 2>&1; eq $? 0 "stop allows with no marker"
node "$D/landing-ready.js" "$W" --evidence "reports: ok" >/dev/null; eq $? 0 "landing-ready writes marker"
grep -q "^review: APPROVE $(git -C "$W" rev-parse HEAD)" "$W/.landing-ready"; ok $? "marker has review line for HEAD"
[[ -z "$(git -C "$W" status --porcelain)" ]]; ok $? "marker excluded from git status"
node "$D/landing-ready.js" "$T/s" >/dev/null 2>&1; eq $? 1 "landing-ready refuses main worktree"
node "$D/cli.js" stop "$T/s" >/dev/null 2>&1; eq $? 2 "stop BLOCKS reviewed+audited unlanded"
out=$(printf '{"cwd":"%s","hook_event_name":"Stop"}' "$T/s" | node "$D/unlanded-report.js")
has "$out" '"decision":"block"' "Claude Stop hook blocks"; has "$out" ".landing-hold" "Stop message names the escape"
out=$(printf '{"cwd":"%s","hook_event_name":"Stop","stop_hook_active":true}' "$T/s" | node "$D/unlanded-report.js")
has "$out" '"decision":"block"' "stop_hook_active is not an escape"
echo "" > "$W/.landing-hold"; node "$D/cli.js" stop "$T/s" >/dev/null 2>&1; eq $? 2 "empty hold does not count"
echo "waiting on human review" > "$W/.landing-hold"; node "$D/cli.js" stop "$T/s" >/dev/null 2>&1; eq $? 0 "hold with reason allows stop"
rm "$W/.landing-hold"; git -C "$W" commit -q --allow-empty -m more
node "$D/cli.js" stop "$T/s" >/dev/null 2>&1; eq $? 0 "marker stale after new commit (re-review needed)"
out=$(printf '{"cwd":"%s","hook_event_name":"SessionStart"}' "$T/s" | node "$D/unlanded-report.js")
has "$out" "SessionStart" "SessionStart emits context"; has "$out" "stale/invalid" "stale marker flagged"

# ── prunable: nothing ahead, idle 7d+ ──
newrepo p; git -C "$T/p" worktree add -q -b old "$T/p/.worktrees/old" origin/main
OLD="$(( $(date +%s) - 864000 )) +0000"; GIT_COMMITTER_DATE="$OLD" GIT_AUTHOR_DATE="$OLD" git -C "$T/p/.worktrees/old" commit -q --allow-empty -m old
git -C "$T/p" push -q origin old:main 2>/dev/null; git -C "$T/p" fetch -q
git -C "$T/p" worktree add -q -b fresh "$T/p/.worktrees/fresh" origin/main
git -C "$T/p/.worktrees/fresh" commit -q --allow-empty -m new; git -C "$T/p/.worktrees/fresh" push -q origin fresh:main 2>/dev/null; git -C "$T/p" fetch -q
out=$(node "$D/cli.js" report "$T/p" 2>&1)
has "$out" "prunable $T/p/.worktrees/old" "stale landed worktree listed prunable"
hasnt "$out" "fresh" "recent landed worktree not listed"
eq "$(node "$D/cli.js" check "$T/p" --json | grep -o '"count":[0-9]*')" '"count":0' "prunable not counted toward cap"

# ── report scans child repos (fire-map folder layout) ──
mkdir "$T/parent"; newrepo c1; mv "$T/c1" "$T/parent/c1"; unlanded "$T/parent/c1" k1
out=$(node "$D/cli.js" report "$T/parent" 2>&1); has "$out" "k1" "report finds child repo worktrees"

# ── adapter smoke: Codex + Anvil via installer in scratch HOME/project ──
H="$T/home"; mkdir -p "$H/.codex/rules" "$H/.claude" "$T/proj"; echo '{}' > "$H/.claude/settings.json"
HOME="$H" node "$D/install.js" --wire --codex --project "$T/proj" --anvil "$T/proj" >/dev/null
grep -q 'decision="forbidden"' "$H/.codex/rules/default.rules"; ok $? "codex rule installed"
grep -q 'worktree-cap-start (codex-agents)' "$T/proj/AGENTS.md"; ok $? "codex AGENTS.md block"
grep -q 'worktree-cap-start (anvil)' "$T/proj/.anvil/CONTRACTS.md"; ok $? "anvil CONTRACTS.md block"
node -e 'const s=require(process.argv[1]);process.exit(["PreToolUse","SessionStart","Stop"].every(e=>s.hooks[e]&&s.hooks[e].length===1)?0:1)' "$H/.claude/settings.json"; ok $? "claude wired once each"
HOME="$H" node "$D/install.js" --wire --codex --project "$T/proj" --anvil "$T/proj" >/dev/null
eq "$(grep -c 'worktree-cap-start (codex)' "$H/.codex/rules/default.rules")" 1 "install idempotent"
HOME="$H" node "$D/install.js" --uninstall --project "$T/proj" --anvil "$T/proj" >/dev/null
! grep -q worktree-cap "$H/.codex/rules/default.rules" "$T/proj/AGENTS.md" "$T/proj/.anvil/CONTRACTS.md" "$H/.claude/settings.json"; ok $? "uninstall removes everything"

echo "$((n-fails))/$n worktree-cap checks passed"
exit $((fails>0))
