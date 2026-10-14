#!/usr/bin/env bash
# Test the reconcile-gate enforcement contract.
#
# Decision matrix:
#   gh pr create --base main --head dev          → allow
#   gh pr create --base main --head feat/x       → deny  (head not integration)
#   gh pr create --base feat/x --head dev        → deny  (base not production)
#   gh pr create --base master --head develop    → allow (alias both sides)
#   gh pr create --base=main --head=dev          → allow (= form)
#   gh pr create --base main                     → deny  (missing --head)
#   gh pr create --base main --head x --force-anyway → allow (bypass)
#   bash echo hi                                 → allow (not gh pr create)
#   gh pr list                                   → allow (not gh pr create)
#   mygh pr create --base x --head y             → allow (pattern is anchored)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/reconcile-gate.js"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────

# Run the hook with a synthetic stdin payload; return permission decision.
# Args: tool_name, command
decision() {
    local tool_name="$1" cmd="$2"
    local payload
    # Escape double quotes for JSON embedding.
    cmd="${cmd//\"/\\\"}"
    payload="{\"tool_name\":\"$tool_name\",\"cwd\":\"${HOOK_CWD:-/}\",\"tool_input\":{\"command\":\"$cmd\"}}"
    echo "$payload" \
        | node "$HOOK" \
        | node -e 'let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
            try{const o=JSON.parse(s);console.log(o.hookSpecificOutput.permissionDecision);}
            catch(e){console.log("ERROR:"+e.message);}
        });'
}

assert_decision() {
    local label="$1" expected="$2" tool="$3" cmd="$4"
    local actual
    actual=$(decision "$tool" "$cmd")
    if [[ "$expected" == "$actual" ]]; then
        printf "  PASS  %-60s [%s]\n" "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf "  FAIL  %-60s expected=%s actual=%s\n" "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

# ── tests ─────────────────────────────────────────────────────

echo "─── allow cases ────────────────────────────────────────"
assert_decision "main←dev (canonical)"    "allow" "Bash" "gh pr create --base main --head dev --title T --body B"
assert_decision "master←develop (alias)"  "allow" "Bash" "gh pr create --base master --head develop --title T"
assert_decision "main=dev = form"         "allow" "Bash" "gh pr create --base=main --head=dev --title T"
assert_decision "bypass flag"             "allow" "Bash" "gh pr create --base main --head feat/x --force-anyway --title T"
assert_decision "non-Bash tool"           "allow" "Edit" "gh pr create --base feat/x --head x"
assert_decision "gh pr list (not create)" "allow" "Bash" "gh pr list"
assert_decision "lookalike mygh"          "allow" "Bash" "mygh pr create --base feat/x --head x"
assert_decision "plain echo"              "allow" "Bash" "echo hi"
assert_decision "git push to dev"         "allow" "Bash" "git push origin dev"
assert_decision "short -B/-H form"        "allow" "Bash" "gh pr create -B main -H dev"

echo
echo "─── deny cases ─────────────────────────────────────────"
assert_decision "feature head"            "deny"  "Bash" "gh pr create --base main --head feat/x --title T"
assert_decision "feature base"            "deny"  "Bash" "gh pr create --base feat/x --head dev --title T"
assert_decision "missing --head"          "deny"  "Bash" "gh pr create --base main --title T"
assert_decision "missing --base"          "deny"  "Bash" "gh pr create --head dev --title T"
assert_decision "no flags at all"         "deny"  "Bash" "gh pr create"
assert_decision "main←main (silly)"       "deny"  "Bash" "gh pr create --base main --head main"
assert_decision "dev←main (wrong way)"    "deny"  "Bash" "gh pr create --base dev --head main"

echo
echo "─── per-project override (.reconcile-gate.json on trunk) ─"
PROJ="$(mktemp -d)"; NOGIT="$(mktemp -d)"; ORIGIN="$(mktemp -d)"; trap 'rm -rf "$PROJ" "$NOGIT" "$ORIGIN"' EXIT
git init -q --bare -b main "$ORIGIN"
G="git -C $PROJ -c user.email=t@t -c user.name=t"
$G init -q -b main && $G remote add origin "$ORIGIN" && mkdir -p "$PROJ/sub/dir" && echo x > "$PROJ/f" && $G add f && $G commit -qm init && $G push -q origin main
# two-trunk mode: the repo keeps an integration trunk, so origin/dev exists
$G push -q origin main:dev && $G fetch -q origin
export HOOK_CWD="$PROJ/sub/dir"
# commit_cfg <json>: commit the config on main (the only trusted location)
commit_cfg() { echo "$1" > "$PROJ/.reconcile-gate.json"; $G add .reconcile-gate.json; $G commit -qm cfg; $G push -q origin main; }

assert_decision "no config: feat→dev denied"               "deny"  "Bash" "gh pr create --base dev --head feat/x"
echo '{"allowed":[{"base":"dev","head":"*"}]}' > "$PROJ/.reconcile-gate.json"
assert_decision "UNCOMMITTED config is ignored"            "deny"  "Bash" "gh pr create --base dev --head feat/x"
echo '{"allowed":[{"base":"dev","head":"*"}]}' > "$PROJ/.reconcile-gate.json"; $G add .reconcile-gate.json; $G commit -qm local-only
assert_decision "LOCAL main only (not origin/main): ignored" "deny" "Bash" "gh pr create --base dev --head feat/x"
$G update-ref refs/remotes/origin/main main
assert_decision "FORGED origin/main (update-ref, unpushed): ignored" "deny" "Bash" "gh pr create --base dev --head feat/x"
$G push -q origin main
assert_decision "committed+pushed: feat→dev allowed (subdir)" "allow" "Bash" "gh pr create --base dev --head feat/x"
assert_decision "concatenated -Bdev -Hfeat/x allowed"      "allow" "Bash" "gh pr create -Bdev -Hfeat/x"
assert_decision "concatenated -Ro/r: override not applied" "deny"  "Bash" "gh pr create -Ro/r --base dev --head feat/x"
assert_decision "committed: canonical main←dev still ok"   "allow" "Bash" "gh pr create --base main --head dev"
assert_decision "NO cross-product: feat→main still denied" "deny"  "Bash" "gh pr create --base main --head feat/x"
assert_decision "unlisted base still denied"               "deny"  "Bash" "gh pr create --base release --head feat/x"
assert_decision "--repo other: override not applied"       "deny"  "Bash" "gh pr create --repo o/r --base dev --head feat/x"
assert_decision "-R other: override not applied"           "deny"  "Bash" "gh pr create -R o/r --base dev --head feat/x"
commit_cfg '{"allowed":[{"base":"dev","head":"work/x"}]}'
assert_decision "specific head pair allowed"               "allow" "Bash" "gh pr create --base dev --head work/x"
assert_decision "other head denied"                        "deny"  "Bash" "gh pr create --base dev --head work/y"
commit_cfg '{not json'
assert_decision "malformed committed config: fail closed"  "deny"  "Bash" "gh pr create --base dev --head feat/x"
assert_decision "malformed config: canonical denied too"   "deny"  "Bash" "gh pr create --base main --head dev"
commit_cfg '{"allowed":[{"base":"*","head":"*"}]}'
assert_decision "wildcard base rejected: fail closed"      "deny"  "Bash" "gh pr create --base main --head feat/x"
commit_cfg '{"allowedBases":["dev"]}'
assert_decision "old/wrong schema: fail closed"            "deny"  "Bash" "gh pr create --base dev --head feat/x"
echo '{"allowed":[{"base":"dev","head":"*"}]}' > "$NOGIT/.reconcile-gate.json"
HOOK_CWD="$NOGIT" assert_decision "non-git dir w/ config: ignored" "deny" "Bash" "gh pr create --base dev --head feat/x"
unset HOOK_CWD

echo
echo "─── trunk detection (single-trunk default vs two-trunk opt-in) ─"
# Single-trunk repo: origin has main only (no dev/develop).
ST="$(mktemp -d)"; STO="$(mktemp -d)"
trap 'rm -rf "$PROJ" "$NOGIT" "$ORIGIN" "$ST" "$STO"' EXIT
git init -q --bare -b main "$STO"
S="git -C $ST -c user.email=t@t -c user.name=t"
$S init -q -b main && $S remote add origin "$STO" && echo x > "$ST/f" && $S add f && $S commit -qm init && $S push -q origin main && $S fetch -q origin
export HOOK_CWD="$ST"
assert_decision "single-trunk: feat→main allowed"          "allow" "Bash" "gh pr create --base main --head feat/x --title T"
assert_decision "single-trunk: feat→master allowed"        "allow" "Bash" "gh pr create --base master --head work/y"
assert_decision "single-trunk: feat→dev still denied"      "deny"  "Bash" "gh pr create --base dev --head feat/x"
assert_decision "single-trunk: missing --head still denied" "deny" "Bash" "gh pr create --base main"
# dev present => two-trunk rule (today's behaviour).
$S push -q origin main:dev && $S fetch -q origin
assert_decision "dev present: feat→main denied"            "deny"  "Bash" "gh pr create --base main --head feat/x"
assert_decision "dev present: dev→main allowed"            "allow" "Bash" "gh pr create --base main --head dev"
$S push -q origin --delete dev && $S fetch -q --prune origin
# develop (not dev) also counts as an integration trunk.
$S push -q origin main:develop && $S fetch -q origin
assert_decision "develop present: feat→main denied"        "deny"  "Bash" "gh pr create --base main --head feat/x"
assert_decision "develop present: develop→main allowed"    "allow" "Bash" "gh pr create --base main --head develop"
$S push -q origin --delete develop && $S fetch -q --prune origin
assert_decision "develop removed: feat→main allowed again" "allow" "Bash" "gh pr create --base main --head feat/x"
# Fail closed: git cannot answer (not a repo) => two-trunk rule.
HOOK_CWD="$NOGIT" assert_decision "git fails: feat→main denied (fail closed)" "deny" "Bash" "gh pr create --base main --head feat/x"
HOOK_CWD="$NOGIT" assert_decision "git fails: dev→main still allowed"         "allow" "Bash" "gh pr create --base main --head dev"
# --repo targets another repo: local refs say nothing about it => fail closed.
assert_decision "--repo other: feat→main denied (fail closed)" "deny" "Bash" "gh pr create --repo o/r --base main --head feat/x"
# Bypass still works; config pairs still ADD in single-trunk mode.
assert_decision "single-trunk: bypass flag still allowed"  "allow" "Bash" "gh pr create --base release --head x --force-anyway"
echo '{"allowed":[{"base":"release","head":"*"}]}' > "$ST/.reconcile-gate.json"; $S add .reconcile-gate.json; $S commit -qm cfg; $S push -q origin main
assert_decision "single-trunk + config: feat→release allowed" "allow" "Bash" "gh pr create --base release --head feat/x"
assert_decision "single-trunk + config: feat→main still allowed" "allow" "Bash" "gh pr create --base main --head feat/x"
unset HOOK_CWD

echo
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
