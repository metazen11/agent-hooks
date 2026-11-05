#!/usr/bin/env bash
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/reconcile-gate.js"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email test@example.invalid
git -C "$ROOT" config user.name test
git -C "$ROOT" commit --allow-empty -qm init
git -C "$ROOT" remote add origin https://github.com/metazen11/agent-memory.git
git -C "$ROOT" branch dev
payload() { node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]},cwd:process.argv[2]}))' "$1" "$ROOT"; }
fails=0
expect() { payload "$2" | node "$HOOK" | grep -q "\"$1\"" || { printf 'FAIL expected %s: %q\n' "$1" "$2"; fails=$((fails + 1)); }; }
allow() { expect allow "$1"; }
deny() { expect deny "$1"; }
cat_script=$(printf 'cat <<\x27EOF\x27\ngit push origin main\nEOF')
bash_script=$(printf 'bash <<\x27EOF\x27\ngit push origin main\nEOF')
allow "$cat_script"
deny "$bash_script"
allow 'echo "\$(git push origin main)"'
deny 'echo "$(git push origin main)"'
allow "printf '%s\\n' 'git push /repo/main'"
deny $'cat <<\x27EOF\x27 | /bin/bash\ngit push origin main\nEOF'
deny $'cat <<\x27EOF\x27\nprose mentions git push origin main\nEOF\ngit push origin main'
deny $'echo "fake <<EOF"\ngit push origin main'
deny $'cat <<EOF\n$(git push origin main)\nEOF'
deny $'cat <<EOF\nprose $(git push origin main) and $(printf x)\nEOF'
deny $'cat <<END-DOC\nprose\nEND-DOC\ngit push origin main'
deny $'cat <<\x27END DOC\x27\nprose\nEND DOC\ngit push origin main'
# Issue #51: a heredoc feeds the LAST simple command before `<<`, not the first
# word of the line. Quoted bodies are inert wherever that command sits in a chain.
note=$'cat > a.md <<\x27EOF\x27\nThe same `gh pr create` was refused once.\ngit push origin main\nEOF'
for sep in '&&' '||' ';' '|'; do allow "true $sep $note"; done
allow "mkdir -p \$(dirname a/b) 2>&1 && $note"
# ...and a shell later in the chain still executes its heredoc, whatever precedes it.
doc=$'<<\x27EOF\x27\ngit push origin main\nEOF'
for owner in 'cat x; bash' 'cat x && bash' 'echo hi & sh' 'true && bash'; do deny "$owner $doc"; done
deny $'true && cat <<\x27EOF\x27 | bash\ngit push origin main\nEOF'
deny $'true && cat <<\x27EOF\x27\nprose\nEOF\ngit push origin main'
deny $'true && cat <<EOF\n$(git push origin main)\nEOF'
# Owner not provable from the line (group, substitution, escape, redirect,
# comment): the body stays visible, fail closed.
for owner in 'bash -s $(true; true) cat' '(bash; cat )' 'bash -s `true; true` cat' \
    'bash -s a\; cat' 'bash -s >| cat' 'true # && cat' 'echo { ; bash -s } cat' 'eval $(true; cat'; do
    deny "$owner $doc"
done
deny "echo \$(bash $doc"$'\n)'
[ "$fails" -eq 0 ] && echo "heredoc parsing cases passed"
