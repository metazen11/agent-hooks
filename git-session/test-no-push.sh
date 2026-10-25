#!/usr/bin/env bash
# Issue #33: git-session must never push, must never move a published
# branch (a PR head), and must never checkpoint agent runtime state.
#
# Every repo here has a LOCAL bare remote; nothing can reach a real remote.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/git-session.js"
PASS=0
FAIL=0
BR="work/t"

# repo with a bare remote; $1=publish → branch is pushed (has an upstream)
setup() {
    local d
    d="$(mktemp -d -t agent-hooks-nopush-XXXXXX)"
    git init -q --bare "$d/remote.git"
    git init -q -b "$BR" "$d/w"
    git -C "$d/w" config user.email "test@test.local"
    git -C "$d/w" config user.name "Test"
    git -C "$d/w" remote add origin "$d/remote.git"
    echo initial >"$d/w/file.txt"
    git -C "$d/w" add file.txt
    git -C "$d/w" commit -q -m initial
    [[ "${1:-}" == publish ]] && git -C "$d/w" push -q -u origin "$BR"
    echo "$d"
}

remote_refs() { git -C "$1/remote.git" for-each-ref --format='%(refname) %(objectname)'; }
head_sha() { git -C "$1/w" rev-parse HEAD; }

hook() { # $1=dir $2=mode
    if [[ "$2" == --session-end ]]; then
        printf '{"cwd":"%s","hook_event_name":"SessionEnd","reason":"other"}' "$1/w"
    else
        printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/w/file.txt"}}' "$1/w" "$1"
    fi | node "$HOOK" "$2" >/dev/null 2>&1 || true
}

check() { # label, then a command that must succeed
    local label="$1"; shift
    if "$@"; then printf '  PASS  %s\n' "$label"; PASS=$((PASS + 1))
    else printf '  FAIL  %s\n' "$label"; FAIL=$((FAIL + 1)); fi
}

echo "Case 1: session-end on an unpublished branch never pushes"
d="$(setup)"; before="$(remote_refs "$d")"
echo dirty >"$d/w/file.txt"
hook "$d" --session-end
check "remote refs unchanged" test "$before" == "$(remote_refs "$d")"
check "work committed locally" test -z "$(git -C "$d/w" status --porcelain)"
rm -rf "$d"

echo "Case 2: session-end on a published branch (PR head) leaves it untouched"
d="$(setup publish)"; before="$(remote_refs "$d")"; h="$(head_sha "$d")"
echo dirty >"$d/w/file.txt"
hook "$d" --session-end
check "remote refs unchanged" test "$before" == "$(remote_refs "$d")"
check "branch head not moved" test "$h" == "$(head_sha "$d")"
check "snapshot on refs/checkpoints/$BR" \
    test "$(git -C "$d/w" show "refs/checkpoints/$BR:file.txt" 2>/dev/null)" == dirty
check "working tree left as-is" test "$(cat "$d/w/file.txt")" == dirty
rm -rf "$d"

echo "Case 3: pre-edit checkpoint on a published branch goes to the side ref"
d="$(setup publish)"; h="$(head_sha "$d")"
echo dirty >"$d/w/file.txt"
hook "$d" --pre-edit
check "branch head not moved" test "$h" == "$(head_sha "$d")"
check "snapshot on refs/checkpoints/$BR" \
    test "$(git -C "$d/w" show "refs/checkpoints/$BR:file.txt" 2>/dev/null)" == dirty
rm -rf "$d"

echo "Case 4: runtime dirs (.agent-memory-codex/, .anvil/) are never checkpointed"
d="$(setup)"; h="$(head_sha "$d")"
mkdir -p "$d/w/.agent-memory-codex" "$d/w/.anvil"
echo s >"$d/w/.agent-memory-codex/state.json"; echo s >"$d/w/.anvil/run.json"
hook "$d" --pre-edit
check "runtime-only changes make no checkpoint" test "$h" == "$(head_sha "$d")"
echo dirty >"$d/w/file.txt"
hook "$d" --session-end
check "real change committed" test "$(git -C "$d/w" show HEAD:file.txt)" == dirty
check "runtime paths not in commit" \
    test -z "$(git -C "$d/w" ls-tree -r --name-only HEAD | grep -E '^\.(agent-memory-codex|anvil)/' || true)"
rm -rf "$d"

echo
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
