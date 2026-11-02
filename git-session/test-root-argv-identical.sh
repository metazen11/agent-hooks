#!/usr/bin/env bash
# Issue #36 AC3: at a TRUE repo root the git argv sequence of the hook is
# byte-identical to the baseline (origin/main) hook. A PATH shim logs every git
# call; SessionStart, 2x PreEdit, SessionEnd (squash), SessionEnd (commit) and a
# squash whose commit is forced to fail are run with both hooks and the
# normalised traces are diffed.
#   BASELINE=<path to baseline git-session.js> overrides `git show origin/main:`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NEW="$HERE/git-session.js"
W0="$(mktemp -d -t agent-hooks-argv-XXXXXX)"; W0="$(cd "$W0" && pwd -P)"
trap 'find "$W0" -delete' EXIT
BASE="${BASELINE:-$W0/baseline.js}"
[[ -n "${BASELINE:-}" ]] || git -C "$HERE" show origin/main:git-session/git-session.js >"$BASE"
mkdir "$W0/shim"
cat >"$W0/shim/git" <<'SH'
#!/bin/bash
{ printf '%s |' "${PWD#$TRACE_ROOT}"; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$TRACE_LOG"
exec /usr/bin/git "$@"
SH
chmod +x "$W0/shim/git"

G() { /usr/bin/git -c user.email=t@t -c user.name=T "$@"; }
mk() { # repo with an empty commit and a no-ff merge commit (history-simplification bait)
    local r=$1; mkdir -p "$r/a" "$r/b"; G -C "$r" init -q -b main
    echo a >"$r/a/f.txt"; echo b >"$r/b/f.txt"; G -C "$r" add -A; G -C "$r" commit -qm base
    G -C "$r" checkout -qb work/test; G -C "$r" commit -q --allow-empty -m EMPTY-COMMIT
    G -C "$r" checkout -qb side; echo s >"$r/b/s.txt"; G -C "$r" add -A; G -C "$r" commit -qm side-work
    G -C "$r" checkout -q work/test; G -C "$r" merge -q --no-ff side -m MERGE-COMMIT; G -C "$r" branch -qd side
}
hook() { # hook.js mode cwd [file]
    local j
    if [[ "$2" == --pre-edit ]]; then
        j=$(printf '{"cwd":"%s","session_id":"s1","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$3" "$4")
    else
        j=$(printf '{"cwd":"%s","session_id":"s1","reason":"other"}' "$3")
    fi
    echo "=== $2" >>"$TRACE_LOG"
    printf '%s' "$j" | PATH="$W0/shim:$PATH" node "$1" "$2" >/dev/null 2>&1 || true
}
trace() { # hook.js outfile
    local H=$1 W="$W0/run-$(basename "$2")"; mkdir "$W"
    export TRACE_ROOT=$W TRACE_LOG=$W/trace.log GIT_CEILING_DIRECTORIES=$W0
    export GIT_HOOK_AUTO_PULL=false GIT_HOOK_AUTO_PUSH=false
    export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
    : >"$TRACE_LOG"
    local R=$W/r; mk "$R"
    hook "$H" --session-start "$R"
    echo x1 >>"$R/a/f.txt"; hook "$H" --pre-edit "$R" "$R/a/f.txt"
    echo x2 >>"$R/b/f.txt"; hook "$H" --pre-edit "$R" "$R/b/f.txt"
    hook "$H" --session-end "$R"                      # squash path
    echo x3 >>"$R/b/f.txt"; hook "$H" --session-end "$R"   # commit path
    local R2=$W/r2; mk "$R2"                           # squash + forced commit failure
    echo y1 >>"$R2/a/f.txt"; hook "$H" --pre-edit "$R2" "$R2/a/f.txt"
    echo y2 >>"$R2/a/f.txt"; hook "$H" --pre-edit "$R2" "$R2/a/f.txt"
    G -C "$R2" config commit.gpgsign true; G -C "$R2" config gpg.program /usr/bin/false
    hook "$H" --session-end "$R2"
    sed -E -e "s#$W#<W>#g" -e 's/[0-9a-f]{40}/<SHA>/g' -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z/<STAMP>/g' \
        -e 's/squash-msg-[0-9]+/squash-msg-<MS>/g' "$TRACE_LOG" >"$2"
}
trace "$BASE" "$W0/old.norm"
trace "$NEW" "$W0/new.norm"
n="$(wc -l <"$W0/old.norm" | tr -d ' ')"
if [[ "$n" -lt 40 ]]; then echo "FAIL  baseline trace suspiciously short ($n lines)"; exit 1; fi
if diff "$W0/old.norm" "$W0/new.norm" >"$W0/diff.txt"; then
    echo "  PASS  root git argv identical to baseline ($n calls)"; echo "Result: 1 passed, 0 failed"
else
    echo "  FAIL  root git argv differs from baseline: $(grep -c '^[<>]' "$W0/diff.txt") differing lines"
    head -20 "$W0/diff.txt"; echo "Result: 0 passed, 1 failed"; exit 1
fi
