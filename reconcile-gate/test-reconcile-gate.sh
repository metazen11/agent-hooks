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
    payload="{\"tool_name\":\"$tool_name\",\"tool_input\":{\"command\":\"$cmd\"}}"
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
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
