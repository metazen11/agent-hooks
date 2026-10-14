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
echo "─── single-trunk is POSITIVE opt-in (marker on SHA-verified origin/main) ─"
# Absence of dev/develop must NEVER imply single-trunk (offline, shallow clone,
# forged refs all look like "no dev"). Only the committed marker opts in.
ST="$(mktemp -d)"; STO="$(mktemp -d)"; SH="$(mktemp -d)"
trap 'rm -rf "$PROJ" "$NOGIT" "$ORIGIN" "$ST" "$STO" "$SH"' EXIT
git init -q --bare -b main "$STO"
S="git -C $ST -c user.email=t@t -c user.name=t"
$S init -q -b main && $S remote add origin "$STO" && echo x > "$ST/f" && $S add f && $S commit -qm init && $S push -q origin main && $S fetch -q origin
export HOOK_CWD="$ST"
FEAT="gh pr create --base main --head feat/x --title T"
assert_decision "no marker, no dev: feat→main DENIED"        "deny"  "Bash" "$FEAT"
echo '{"model":"single-trunk"}' > "$ST/.reconcile-gate.json"
assert_decision "marker in working tree only: DENIED"        "deny"  "Bash" "$FEAT"
$S checkout -q -b feat/x && $S add .reconcile-gate.json && $S commit -qm cfg && $S push -q origin feat/x
assert_decision "marker on feature branch only: DENIED"      "deny"  "Bash" "$FEAT"
$S checkout -q main && $S merge -q --ff-only feat/x && $S update-ref refs/remotes/origin/main main
assert_decision "FORGED origin/main w/ marker (unpushed): DENIED" "deny" "Bash" "$FEAT"
# shallow clone of a repo with NO marker: still two-trunk
git clone -q --depth=1 "file://$STO" "$SH/nomarker" 2>/dev/null
HOOK_CWD="$SH/nomarker" assert_decision "shallow clone, no marker: DENIED" "deny" "Bash" "$FEAT"
# publish the marker on real main
$S push -q origin main && $S fetch -q origin
assert_decision "marker on verified origin/main: feat→main allowed"   "allow" "Bash" "$FEAT"
assert_decision "marker: feat→master allowed too" "allow" "Bash" "gh pr create --base master --head feat/x"
assert_decision "marker: feat→dev still denied"              "deny"  "Bash" "gh pr create --base dev --head feat/x"
assert_decision "marker: missing --head still denied"        "deny"  "Bash" "gh pr create --base main"
git clone -q --depth=1 "file://$STO" "$SH/marked" 2>/dev/null
HOOK_CWD="$SH/marked" assert_decision "shallow clone WITH marker: allowed" "allow" "Bash" "$FEAT"
# marker + integration trunk present: explicit opt-in still wins
$S push -q origin main:dev && $S fetch -q origin
assert_decision "marker + dev present: feat→main allowed"    "allow" "Bash" "$FEAT"
$S push -q origin --delete dev && $S fetch -q --prune origin
# ls-remote failure => cannot verify => marker untrusted => two-trunk
$S remote set-url origin "$SH/does-not-exist"
assert_decision "ls-remote fails: marker untrusted, DENIED"  "deny"  "Bash" "$FEAT"
$S remote set-url origin "$STO"
# malformed / wrong-model config => fail closed
echo '{"model":"banana"}' > "$ST/.reconcile-gate.json"; $S add .reconcile-gate.json; $S commit -qm bad; $S push -q origin main
assert_decision "unknown model value: fail closed"           "deny"  "Bash" "$FEAT"
echo '{not json' > "$ST/.reconcile-gate.json"; $S add .reconcile-gate.json; $S commit -qm bad2; $S push -q origin main
assert_decision "malformed config: DENIED"                   "deny"  "Bash" "$FEAT"
# legacy equivalent: allowed main/* is the same opt-in
echo '{"allowed":[{"base":"main","head":"*"}]}' > "$ST/.reconcile-gate.json"; $S add .reconcile-gate.json; $S commit -qm legacy; $S push -q origin main
assert_decision "legacy allowed main/*: feat→main allowed"   "allow" "Bash" "$FEAT"
assert_decision "bypass flag still allowed"                  "allow" "Bash" "gh pr create --base release --head x --force-anyway"
assert_decision "--repo other: marker not applied"           "deny"  "Bash" "gh pr create --repo o/r --base main --head feat/x"
HOOK_CWD="$NOGIT" assert_decision "git fails: feat→main denied" "deny" "Bash" "$FEAT"

echo
echo "─── always-deny: gh pr merge --admin, direct push to trunk ─"
assert_decision "gh pr merge 5 --squash: allowed"            "allow" "Bash" "gh pr merge 5 --squash"
assert_decision "gh pr merge 5 --admin: DENIED"              "deny"  "Bash" "gh pr merge 5 --squash --admin"
assert_decision "gh pr merge --admin + bypass: still DENIED" "deny"  "Bash" "gh pr merge 5 --admin --force-anyway"
assert_decision "git push origin HEAD:main: DENIED"          "deny"  "Bash" "git push origin HEAD:main"
assert_decision "git push origin main: DENIED"               "deny"  "Bash" "git push origin main"
assert_decision "git push -u origin HEAD:refs/heads/main: DENIED" "deny" "Bash" "git push -u origin HEAD:refs/heads/main"
assert_decision "git push origin +feat:master: DENIED"       "deny"  "Bash" "git push origin +feat:master"
assert_decision "git push origin :refs/heads/main: DENIED"   "deny"  "Bash" "git push origin :refs/heads/main"
assert_decision "git push origin feat/x: allowed"            "allow" "Bash" "git push origin feat/x"
assert_decision "git push origin HEAD:feat/main-fix: allowed" "allow" "Bash" "git push origin HEAD:feat/main-fix"
assert_decision "git push (no args): allowed"                "allow" "Bash" "git push"
unset HOOK_CWD

echo
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
