#!/usr/bin/env bash
# Test the hf-launch-gate enforcement contract.
#
# NOTE: this test NEVER submits a real Hugging Face job. It only feeds
# synthetic tool-call payloads to the hook and inspects the permission
# decision it would return. No `hf` binary is invoked.
#
# Decision matrix (paid-launch class → deny; everything else → allow):
#   hf jobs run …                              → deny  (paid launch)
#   hf jobs uv run …                           → deny  (paid launch)
#   ./launch_pilot_4b.sh --launch              → deny  (launcher WITH --launch)
#   bash run_hf_job.sh --launch                → deny  (launcher WITH --launch)
#   ./launch_pilot_4b.sh                       → allow (dry-run, no --launch)
#   ./launch_pilot_4b.sh --dry-run             → allow (dry-run, no --launch)
#   hf jobs logs <id>                          → allow (read-only)
#   hf jobs inspect|ls|ps|status|cancel …      → allow (read-only/control)
#   hf jobs run … --force-anyway               → allow (auditable override)
#   HF_LAUNCH_APPROVED=55 hf jobs run …        → allow (auditable override)
#   hf whoami / hf download …                  → allow (not a job launch)
#   git push / echo …                          → allow (unrelated)
#   non-Bash tool                              → allow

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/hf-launch-gate.js"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────

# Run the hook with a synthetic stdin payload; print the permission
# decision (or "allow" when the hook emits no JSON, i.e. plain exit-0 allow).
# Args: tool_name, command  [, env-prefix like "HF_LAUNCH_APPROVED=55"]
decision() {
    local tool_name="$1" cmd="$2" envkv="${3:-}"
    local payload esc
    esc="${cmd//\"/\\\"}"
    payload="{\"tool_name\":\"$tool_name\",\"tool_input\":{\"command\":\"$esc\"}}"
    # shellcheck disable=SC2086
    echo "$payload" \
        | env ${envkv} node "$HOOK" \
        | node -e 'let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
            if(!s.trim()){console.log("allow");return;}
            try{const o=JSON.parse(s);console.log(o.hookSpecificOutput.permissionDecision);}
            catch(e){console.log("ERROR:"+e.message);}
        });'
}

assert_decision() {
    local label="$1" expected="$2" tool="$3" cmd="$4" envkv="${5:-}"
    local actual
    actual=$(decision "$tool" "$cmd" "$envkv")
    if [[ "$expected" == "$actual" ]]; then
        printf "  PASS  %-58s [%s]\n" "$label" "$actual"
        PASS=$((PASS + 1))
    else
        printf "  FAIL  %-58s expected=%s actual=%s\n" "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

# ── deny cases (paid launch, no override) ────────────────────

echo "─── deny cases (paid launch) ───────────────────────────"
assert_decision "hf jobs run"                 "deny"  "Bash" "hf jobs run a10g my/img python train.py"
assert_decision "hf jobs uv run"              "deny"  "Bash" "hf jobs uv run --flavor a10g train.py"
assert_decision "launcher --launch (./)"      "deny"  "Bash" "./launch_pilot_4b.sh --launch"
assert_decision "launcher --launch (bash)"    "deny"  "Bash" "bash run_hf_job.sh --launch"
assert_decision "launcher --launch + args"    "deny"  "Bash" "scripts/launch_pilot_4b.sh --launch --gpu a10g"
assert_decision "launch behind &&"            "deny"  "Bash" "cd /tmp && ./launch_pilot_4b.sh --launch"
assert_decision "hf jobs (unknown subcmd)"    "deny"  "Bash" "hf jobs frobnicate --now"

echo
echo "─── allow cases (dry-run / read-only / unrelated) ──────"
assert_decision "launcher no --launch"        "allow" "Bash" "./launch_pilot_4b.sh"
assert_decision "launcher --dry-run"          "allow" "Bash" "./launch_pilot_4b.sh --dry-run"
assert_decision "hf jobs logs"                "allow" "Bash" "hf jobs logs job-abc123"
assert_decision "hf jobs inspect"             "allow" "Bash" "hf jobs inspect job-abc123"
assert_decision "hf jobs ls"                  "allow" "Bash" "hf jobs ls"
assert_decision "hf jobs ps"                  "allow" "Bash" "hf jobs ps"
assert_decision "hf jobs cancel"              "allow" "Bash" "hf jobs cancel job-abc123"
assert_decision "hf whoami (not a launch)"    "allow" "Bash" "hf whoami"
assert_decision "hf download (not a launch)"  "allow" "Bash" "hf download meta-llama/x"
assert_decision "git push"                    "allow" "Bash" "git push origin dev"
assert_decision "plain echo"                  "allow" "Bash" "echo hi"
assert_decision "non-Bash tool"              "allow" "Edit" "hf jobs run a10g img train.py"

echo
echo "─── allow cases (auditable override) ───────────────────"
assert_decision "run + --force-anyway"        "allow" "Bash" "hf jobs run a10g img train.py --force-anyway"
assert_decision "launcher --launch + bypass"  "allow" "Bash" "./launch_pilot_4b.sh --launch --force-anyway"
assert_decision "inline HF_LAUNCH_APPROVED"   "allow" "Bash" "HF_LAUNCH_APPROVED=55 hf jobs run a10g img train.py"
assert_decision "env HF_LAUNCH_APPROVED"      "allow" "Bash" "hf jobs run a10g img train.py" "HF_LAUNCH_APPROVED=55"
assert_decision "empty approval still blocks" "deny"  "Bash" "hf jobs run a10g img train.py" "HF_LAUNCH_APPROVED="
assert_decision "non-numeric approval blocks" "deny"  "Bash" "hf jobs run a10g img train.py" "HF_LAUNCH_APPROVED=yes"

echo
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
