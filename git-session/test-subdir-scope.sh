#!/usr/bin/env bash
# Issue #36: git-session must scope status/log/add/commit to the session cwd
# subtree. Parent repo has sibling dirs a/ and b/; session cwd = a/.
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/git-session.js"
PASS=0; FAIL=0
TMPS=()
trap 'for t in ${TMPS[@]+"${TMPS[@]}"}; do find "$t" -delete; done' EXIT
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
    TMPS+=("$d")
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
[[ "$(git -C "$d" log --format=%s | grep -c '^Checkpoint before')" == "2" ]] || { bad "setup: expected 2 checkpoints"; exit 1; }
run --session-end "$d/a" >/dev/null
[[ "$(git -C "$d" log --format=%s | grep -c 'squash 2 auto-checkpoints')" == "1" ]] && ok "checkpoints squashed from subdir" || bad "squash did not run: $(git -C "$d" log --format=%s | head -3 | tr '\n' '|')"

ckpt() { # cwd repo file(relative to repo): dirty the file, fire pre-edit from cwd
    echo "$RANDOM" >"$2/$3"
    printf '{"cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/%s"}}' "$1" "$2" "$3" | node "$HOOK" --pre-edit >/dev/null
}
subjects() { git -C "$1" log --format=%s | head -6 | tr '\n' '|'; }

echo "Case E: squash from a/ must not wipe dirty/staged b/ when commit fails (data loss)"
d="$(mkrepo)"; git -C "$d" branch main HEAD~2
ckpt "$d/a" "$d" a/f.txt; ckpt "$d/a" "$d" a/f.txt
echo "b-dirty" >"$d/b/f.txt"; echo "b-staged" >"$d/b/staged.txt"; git -C "$d" add b/staged.txt
git -C "$d" config commit.gpgsign true; git -C "$d" config gpg.program /usr/bin/false
run --session-end "$d/a" >/dev/null || true
[[ "$(cat "$d/b/f.txt" 2>/dev/null)" == "b-dirty" ]] && ok "dirty b/f.txt survives" || bad "dirty b/f.txt lost"
{ [[ "$(cat "$d/b/staged.txt" 2>/dev/null)" == "b-staged" ]] && git -C "$d" diff --cached --name-only | grep -q "b/staged.txt"; } && ok "staged b/staged.txt survives" || bad "staged b/staged.txt lost"

echo "Case F: sibling-only checkpoints + dirty b/ (no forced failure)"
d="$(mkrepo)"; git -C "$d" branch main HEAD~2
ckpt "$d/b" "$d" b/f.txt; ckpt "$d/b" "$d" b/f.txt
echo "b-dirty" >"$d/b/f.txt"
n="$(git -C "$d" rev-list --count HEAD)"
run --session-end "$d/a" >/dev/null || true
[[ "$(cat "$d/b/f.txt")" == "b-dirty" ]] && ok "dirty b/f.txt survives" || bad "dirty b/f.txt lost"
[[ "$(git -C "$d" rev-list --count HEAD)" == "$n" ]] && ok "history untouched" || bad "history rewritten: $(subjects "$d")"

echo "Case G: interleaved b/ checkpoint must not be dropped by an a/ squash"
d="$(mkrepo)"; git -C "$d" branch main HEAD~2
ckpt "$d/a" "$d" a/f.txt; ckpt "$d/b" "$d" b/f.txt; ckpt "$d/a" "$d" a/f.txt
n="$(git -C "$d" rev-list --count HEAD)"; bval="$(cat "$d/b/f.txt")"
run --session-end "$d/a" >/dev/null || true
[[ "$(git -C "$d" rev-list --count HEAD)" == "$n" ]] && ok "no squash across sibling checkpoint" || bad "history rewritten: $(subjects "$d")"
[[ "$(git -C "$d" show HEAD:b/f.txt)" == "$bval" ]] && ok "b/ change still in HEAD" || bad "b/ change dropped from HEAD"
[[ -z "$(git -C "$d" status --porcelain)" ]] && ok "nothing left staged/dirty" || bad "left: $(git -C "$d" status --porcelain | tr '\n' ' ')"

echo "Case H: root context keeps an empty commit (no 'log -- .' simplification)"
d="$(mkrepo)"; git -C "$d" commit -q --allow-empty -m EMPTY-MARKER
out="$(run --session-start "$d")"
grep -q "EMPTY-MARKER" <<<"$out" && ok "root context shows empty commit" || bad "empty commit vanished from root context"

echo "Case I: a/.anvil runtime dir is never checkpointed from a/"
d="$(mkrepo)"; mkdir "$d/a/.anvil"; echo x >"$d/a/.anvil/state"
before="$(git -C "$d" rev-list --count HEAD)"
edit "$d/a" "$d"
[[ "$(git -C "$d" rev-list --count HEAD)" == "$before" ]] && ok "runtime-only change: no checkpoint" || bad "checkpointed runtime dir"
echo a9 >"$d/a/f.txt"; edit "$d/a" "$d"
git -C "$d" show --name-only --format= HEAD | grep -q ".anvil" && bad "a/.anvil in checkpoint" || ok "checkpoint excludes a/.anvil"

echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
