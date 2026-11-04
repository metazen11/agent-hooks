#!/usr/bin/env bash
# Shared CLI tests + one smoke test per adapter (Claude hook, Codex, Anvil). bash 3.2 safe.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset WORKTREE_CAP WORKTREE_CAP_DISABLE
export WORKTREE_CAP_STATE_DIR="$T/state"
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
[[ ! -e "$W/.landing-ready" ]]; ok $? "attestation is NOT written inside the worktree"
grep -rq "^review: APPROVE $(git -C "$W" rev-parse HEAD)" "$T/state"; ok $? "attestation stored in state dir for full HEAD"
node "$D/landing-ready.js" "$W" >/dev/null; eq $? 0 "landing-ready idempotent (O_EXCL, already attested)"
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
has "$out" "SessionStart" "SessionStart emits context"; hasnt "$out" "READY TO LAND" "stale attestation not labelled ready"

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

# ── security: self-attestation, sanitizing, fail-closed, symlinks, parser ──
newrepo v; unlanded "$T/v" v1; V="$T/v/.worktrees/v1"; SHA=$(git -C "$V" rev-parse HEAD)
printf 'review: APPROVE %s\naudit: PASS %s\n' "$SHA" "$SHA" > "$V/.landing-ready"
node "$D/cli.js" stop "$T/v" >/dev/null 2>&1; eq $? 0 "in-worktree .landing-ready does NOT count as reviewed"
out=$(node "$D/cli.js" report "$T/v" 2>&1); hasnt "$out" "READY TO LAND" "self-written marker not labelled reviewed"
unlink "$V/.landing-ready"
mkdir -p "$T/state/x"; printf 'review: APPROVE %s\naudit: PASS %s\n' "${SHA:0:10}" "${SHA:0:10}" > "$T/state/x/${SHA:0:10}.attest"
node "$D/cli.js" stop "$T/v" >/dev/null 2>&1; eq $? 0 "short-sha attestation rejected (40 chars required)"
printf 'ok\033[2J\033]0;pwn\007%0300d\n' 0 > "$V/.landing-hold"
node "$D/landing-ready.js" "$V" >/dev/null
out=$(node "$D/cli.js" report "$T/v" 2>&1)
[[ "$out" != *$'\033'* ]]; ok $? "report strips escape chars from hold reason"
[[ "$out" != *"0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"* ]]; ok $? "hold reason truncated"
git -C "$V" add -f .landing-hold; git -C "$V" commit -q -m "hold tracked"
node "$D/cli.js" stop "$T/v" >/dev/null 2>&1; eq $? 0 "tracked .landing-hold: HEAD moved so attestation stale"
node "$D/landing-ready.js" "$V" >/dev/null
node "$D/cli.js" stop "$T/v" >/dev/null 2>&1; eq $? 2 "tracked .landing-hold NOT honoured -> blocks"
git -C "$V" rm -q -f .landing-hold; git -C "$V" commit -q -m "untrack"
node "$D/landing-ready.js" "$V" >/dev/null
echo secret > "$T/target"; ln -s "$T/target" "$V/.landing-hold"
node "$D/cli.js" stop "$T/v" >/dev/null 2>&1; eq $? 2 "symlinked hold not honoured -> still blocks"
unlink "$V/.landing-hold"
SHA=$(git -C "$V" rev-parse HEAD); K=$(basename "$(dirname "$(find "$T/state" -name "$SHA.attest" | head -1)")")
unlink "$T/state/$K/$SHA.attest"; ln -s "$T/target" "$T/state/$K/$SHA.attest"
node "$D/landing-ready.js" "$V" >/dev/null 2>&1; eq $? 1 "landing-ready refuses symlinked attestation path"
[[ "$(cat "$T/target")" == secret ]]; ok $? "symlink target not overwritten"
unlink "$T/state/$K/$SHA.attest"
WORKTREE_CAP_STATE_DIR="$T/v/st" node "$D/landing-ready.js" "$V" >/dev/null 2>&1; eq $? 1 "landing-ready refuses state dir inside repo"
newrepo l; unlanded "$T/l" l1; echo 50 > "$T/capsrc"; ln -s "$T/capsrc" "$T/l/.worktree-cap"
out=$(hook "$(bashj "$T/l" 'git worktree add .worktrees/n -b n')"); has "$out" '"deny"' "symlinked .worktree-cap -> deny"; has "$out" "not a regular file" "message names mechanism"
eq "$(cat "$T/capsrc")" 50 "symlink target not rewritten"
node "$D/cli.js" check "$T/l" >/dev/null 2>&1; eq $? 2 "cli check fails closed on symlinked cap file"
unlink "$T/l/.worktree-cap"; printf 'SECRETPAYLOAD\n' > "$T/l/.worktree-cap"
out=$(node "$D/cli.js" check "$T/l" 2>&1); hasnt "$out" SECRETPAYLOAD "cap file contents never echoed"
eq "$(cap "$T/l")" 4 "garbage cap re-baselined to unlanded+3"
newrepo z; unlanded "$T/z" z1; unlink "$T/z/.git/worktrees/z1/HEAD"
out=$(node "$D/cli.js" check "$T/z" --json 2>&1); has "$out" '"count":1' "unreadable worktree counts as unlanded"
out=$(node "$D/cli.js" report "$T/z" 2>&1); hasnt "$out" "prunable /" "unreadable worktree never prunable"
newrepo g; unlanded "$T/g" g1; echo 1 > "$T/g/.worktree-cap"
for c in "git -C $T/g worktree add x" "git -c core.x=1 -C $T/g worktree add x" "git --no-pager -C '$T/g' worktree add x" "git -C \"$T/g\" worktree add x" "cd $T/g && git worktree add x" "(cd $T/g; git worktree add x)" "echo hi; cd '$T/g' && git worktree add x" "git --git-dir=$T/g/.git worktree add x" "env FOO=1 git -C $T/g worktree add x" "bash -c 'cd $T/g && git worktree add x'" "sudo git -C $T/g worktree  add   x"; do
  out=$(hook "$(bashj /tmp "$c")"); has "$out" '"deny"' "parser blocks: $c"
done
out=$(HOME="$T" hook "$(bashj /tmp "cd ~/g && git worktree add x")"); has "$out" '"deny"' "parser handles tilde"
out=$(hook "$(bashj /tmp 'git -C $REPO worktree add x')"); has "$out" "cannot statically resolve" "unresolvable -C fails closed"
out=$(hook "$(bashj /tmp 'cd $(pwd) && git worktree add x')"); has "$out" "cannot statically resolve" "dynamic cd fails closed"
out=$(hook "$(bashj "$T/g" "echo 'git worktree add x'")"); eq "$out" "" "quoted text is not a command"
out=$(hook "$(bashj "$T/g" 'git worktree list; git status')"); eq "$out" "" "other worktree subcommands allowed"

# ── adapter smoke: Codex + Anvil via installer in scratch HOME/project ──
H="$T/home"; mkdir -p "$H/.codex/rules" "$H/.claude" "$T/proj"; echo '{}' > "$H/.claude/settings.json"
HOME="$H" node "$D/install.js" --wire --codex --project "$T/proj" --anvil "$T/proj" >/dev/null
grep -q 'decision="forbidden"' "$H/.codex/rules/default.rules"; ok $? "codex rule installed"
eq "$(grep -c 'prefix_rule' "$H/.codex/rules/default.rules")" 5 "codex rule covers git global-option variants"
grep -q 'worktree-cap-start (codex-agents)' "$T/proj/AGENTS.md"; ok $? "codex AGENTS.md block"
grep -q 'worktree-cap-start (anvil)' "$T/proj/.anvil/CONTRACTS.md"; ok $? "anvil CONTRACTS.md block"
node -e 'const s=require(process.argv[1]);process.exit(["PreToolUse","SessionStart","Stop"].every(e=>s.hooks[e]&&s.hooks[e].length===1)?0:1)' "$H/.claude/settings.json"; ok $? "claude wired once each"
HOME="$H" node "$D/install.js" --wire --codex --project "$T/proj" --anvil "$T/proj" >/dev/null
eq "$(grep -c 'worktree-cap-start (codex)' "$H/.codex/rules/default.rules")" 1 "install idempotent"
printf '# worktree-cap-start (codex)\n# worktree-cap-end (codex)\n' > "$H/.codex/rules/default.rules"
HOME="$H" node "$D/install.js" --codex >/dev/null
eq "$(grep -c 'prefix_rule' "$H/.codex/rules/default.rules")" 5 "empty marker block repaired to 5 rules"
HOME="$H" node "$D/install.js" --codex >/dev/null; HOME="$H" node "$D/install.js" --wire --codex >/dev/null
eq "$(grep -c 'prefix_rule' "$H/.codex/rules/default.rules")" 5 "consecutive installs keep 5 rules (no toggle)"
eq "$(grep -c 'worktree-cap-start (codex)' "$H/.codex/rules/default.rules")" 1 "single block after re-runs"
HOME="$H" node "$D/install.js" --uncodex >/dev/null
eq "$(grep -c 'worktree-cap' "$H/.codex/rules/default.rules")" 0 "--uncodex removes block"
HOME="$H" node "$D/install.js" --codex >/dev/null
HOME="$H" node "$D/install.js" --uninstall --project "$T/proj" --anvil "$T/proj" >/dev/null
! grep -q worktree-cap "$H/.codex/rules/default.rules" "$T/proj/AGENTS.md" "$T/proj/.anvil/CONTRACTS.md" "$H/.claude/settings.json"; ok $? "uninstall removes everything"

echo "$((n-fails))/$n worktree-cap checks passed"
exit $((fails>0))
