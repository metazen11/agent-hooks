#!/usr/bin/env bash
# Issue #36: git-session must scope status/log/add/commit to the session cwd
# subtree. Parent repo has sibling dirs a/ and b/; session cwd = a/.
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/git-session.js"
PASS=0; FAIL=0
ok()  { printf "  PASS  %s\n" "$1"; PASS=$((PASS+1)); }
bad() { printf "  FAIL  %s\n" "$1"; FAIL=$((FAIL+1)); }

mkrepo() {
    local d; d="$(mktemp -d -t agent-hooks-scope-XXXXXX)"
    git -C "$d" init -q -b work/test
    git -C "$d" config user.email t@t.local; git -C "$d" config user.name T
    mkdir "$d/a" "$d/b"
    echo a >"$d/a/f.txt"; echo b >"$d/b/f.txt"
    git -C "$d" add -A; git -C "$d" commit -q -m "init"
    echo b2 >"$d/b/f.txt"; git -C "$d" commit -qam "sibling-b-work"
    echo a2 >"$d/a/f.txt"; git -C "$d" commit -qam "project-a-work"
    echo "$d"
}
run() { # mode cwd
    printf '{"cwd":"%s","reason":"other"}' "$2" | GIT_HOOK_AUTO_PUSH=false GIT_HOOK_AUTO_PULL=false node "$HOOK" "$1"
}
edit() { # cwd repo
    printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/a/f.txt"}}' "$1" "$2" | node "$HOOK" --pre-edit >/dev/null
}

echo "Case A: cwd=a/ subdir of parent repo"
d="$(mkrepo)"
echo a3 >"$d/a/f.txt"; echo b3 >"$d/b/f.txt"; echo n >"$d/b/new.txt"
out="$(run --session-start "$d/a")"
grep -q "project-a-work" <<<"$out" && ok "start context shows a/ commit" || bad "start context missing a/ commit"
grep -q "sibling-b-work" <<<"$out" && bad "start context leaks b/ commit" || ok "start context excludes b/ commit"
run --session-end "$d/a" >/dev/null
files="$(git -C "$d" show --name-only --format= HEAD)"
[[ "$files" == "a/f.txt" ]] && ok "session-end commit contains only a/f.txt" || bad "session-end commit files: $files"
git -C "$d" log -1 --format=%s | grep -q "1 modified" && ok "summary counts only a/" || bad "summary: $(git -C "$d" log -1 --format=%s)"
st="$(git -C "$d" status --porcelain)"
{ grep -q "b/f.txt" <<<"$st" && grep -q "b/new.txt" <<<"$st"; } && ok "b/ stays dirty" || bad "b/ not dirty: $st"

echo "Case B: pre-edit checkpoint in a/ ignores dirty b/"
d="$(mkrepo)"; echo b3 >"$d/b/f.txt"
before="$(git -C "$d" rev-list --count HEAD)"
edit "$d/a" "$d"
[[ "$(git -C "$d" rev-list --count HEAD)" == "$before" ]] && ok "no checkpoint when only b/ dirty" || bad "checkpoint committed b/"
echo a3 >"$d/a/f.txt"
edit "$d/a" "$d"
[[ "$(git -C "$d" show --name-only --format= HEAD)" == "a/f.txt" ]] && ok "checkpoint contains only a/" || bad "checkpoint files: $(git -C "$d" show --name-only --format= HEAD)"

echo "Case C: true repo root unchanged (everything in scope)"
d="$(mkrepo)"; echo a3 >"$d/a/f.txt"; echo b3 >"$d/b/f.txt"
out="$(run --session-start "$d")"
{ grep -q "project-a-work" <<<"$out" && grep -q "sibling-b-work" <<<"$out"; } && ok "root context shows both" || bad "root context: $out"
run --session-end "$d" >/dev/null
files="$(git -C "$d" show --name-only --format= HEAD | sort | tr '\n' ' ')"
[[ "$files" == "a/f.txt b/f.txt " ]] && ok "root commit contains a/ and b/" || bad "root commit files: $files"
[[ -z "$(git -C "$d" status --porcelain)" ]] && ok "root tree clean" || bad "root tree dirty"

echo "Case D: squash of checkpoints works from a subdir"
d="$(mkrepo)"; git -C "$d" branch main HEAD~2   # squash boundary = merge-base with a protected branch
for i in 1 2; do echo "a$i$i" >"$d/a/f.txt"; edit "$d/a" "$d"; sleep 0.1; done
# cooldown (30s) is in-process only, each invocation is a fresh process
[[ "$(git -C "$d" log --format=%s | grep -c '^Checkpoint before')" == "2" ]] || bad "setup: expected 2 checkpoints"
run --session-end "$d/a" >/dev/null
[[ "$(git -C "$d" log --format=%s | grep -c 'squash 2 auto-checkpoints')" == "1" ]] && ok "checkpoints squashed from subdir" || bad "squash did not run: $(git -C "$d" log --format=%s | head -3 | tr '\n' '|')"

echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
