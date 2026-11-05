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
note=$'<<\x27EOF\x27\nThe same `gh pr create` was refused once.\ngit push origin main\nEOF'
for sep in '&&' '||' ';' '|'; do allow "true $sep cat > a.md $note"; done
allow "cd repo && S=x && cat > \$S/a.md 2>&1 $note"
# ...and a shell later in the chain still executes its heredoc, whatever precedes it.
doc=$'<<\x27EOF\x27\ngit push origin main\nEOF'
for owner in 'cat x; bash' 'cat x && bash' 'echo hi & sh' 'true && bash'; do deny "$owner $doc"; done
deny $'true && cat <<\x27EOF\x27 | bash\ngit push origin main\nEOF'
deny $'true && cat <<\x27EOF\x27\nprose\nEOF\ngit push origin main'
deny $'true && cat <<EOF\n$(git push origin main)\nEOF'
# Recognition is an allowlist: quoting, escaping, grouping or a comment before `<<`
# means the owner cannot be read off the line, so the body stays visible.
for owner in 'bash -s $(true; echo ) cat' '(bash; cat )' 'bash -s `true; echo ` cat' \
    'bash -s a\; cat' 'bash -s >| cat' 'true # && cat' 'echo { ; bash -s } cat' 'eval $(true; cat' \
    'cat \>; bash' 'bash -s "$(echo "a ; cat " )"' "bash -s 'a\\' '; cat '" '>cat bash -s' 'bash -s >>| cat'; do
    deny "$owner $doc"
done
deny "echo \$(bash $doc"$'\n)'
deny $'cat <<\x27EO\x27F\nprose\nEOF\ngit push origin main\nEO'
# Nothing is recognised while a quote, parenthesis or line continuation may be
# open from earlier lines, or on a line that leaves one open.
gated=$'The same `gh pr create` was refused once.\ngit push origin main'
deny $'echo "start\nx; cat <<\x27EOF\x27"\ngit push origin main\nEOF'
deny $'echo "start\ncat <<\x27EOF\x27"\ngit push origin main\nEOF'
deny $'cat <<\x27EOF\x27 "\n`git push origin main`\n"\nEOF'
deny $'bash -s a \\\ncat <<\x27EOF\x27\ngit push origin main\nEOF'
deny $'(\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n) | bash'
deny $'{ : }\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n} | bash'
deny $'case x in x) :;; esac\n(\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n) | bash'
deny $'echo "$(echo "\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n")"'
deny $'echo "${x:-"\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"}"'
deny $'echo "`echo "\ncat <<\x27EOF\x27\n$(git push origin main)\nEOF\n"`"'
deny $'echo $\x27a\\\x27\x27 "it\x27s\ncat <<\x27EOF\x27\n"\\"\ngit push origin main'
deny $'true # "\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"'
deny $'# say "hi\necho "x\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"'
allow $'grep -q x <<< "$v"\ntrue && cat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'echo \x27a\\\x27\ntrue && cat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'gh issue create --title t --body "Repro:\ncd repo && cat > f <<\x27EOF\x27\nis refused when chained\n"'
allow $'git commit -m "subject\n\nit\x27s the body"\ntrue && cat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'(echo "5\\" pipe" it\\\x27s\n) # group closed\ntrue && cat > a.md <<\x27EOF\x27 > "${OUT}" # a note\n'"$gated"$'\nEOF'
# Heredoc bodies are raw text for every owner: they neither open quotes nor nest heredocs.
allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'git commit -F - <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
# A `<<` that is not recognised may start a body that is not shell text, so
# recognition stops for the rest of the command.
deny $'cat > "f" <<\x27EOF\x27\nsay "hi\nEOF\ngit commit -m "x\ny; cat <<\x27EOF2\x27\n`git push origin main`\n"'
[ "$fails" -eq 0 ] && echo "heredoc parsing cases passed"
