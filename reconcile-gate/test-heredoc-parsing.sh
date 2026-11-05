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
# Issue #58 (tightening only). A quoted body is dropped only when the heredoc's
# command is the first and only command on its line, the text before `<<` is
# plain, the delimiter is a plain quoted word and only redirections follow it.
# A body that used to be dropped but fails any of this is shown instead.
gated=$'The same `gh pr create` was refused once.\ngit push origin main'
doc=$'<<\x27EOF\x27\ngit push origin main\nEOF'
# AC4: plain first-on-line quoted heredocs stay data, whatever the body mentions.
for line in "cat > a.md <<'EOF'" "cat <<'EOF' > a.md" "tee a.md <<'EOF'" "cat > \$S/a.md <<'EOF'" \
    "cat <<'EOF' > \$S/a.md 2>&1 # a note" 'cat <<"EOF"' "cat << 'EOF'" "echo <<'EOF'" "printf x <<'EOF'"; do
    allow "$line"$'\n'"$gated"$'\nEOF'
done
allow $'cat <<-\x27EOF\x27\n\t'"$gated"$'\n\tEOF'
# AC3: a heredoc whose command follows a separator is not recognised (body visible).
for sep in '&&' '||' ';' '|' '&'; do deny "true $sep cat > a.md <<'EOF'"$'\n'"$gated"$'\nEOF'; done
deny "cd repo && S=x && cat > \$S/a.md <<'EOF'"$'\n'"$gated"$'\nEOF'
deny $'true && cat <<\x27EOF\x27 | bash\ngit push origin main\nEOF'
deny $'true && cat <<\x27EOF\x27\nprose\nEOF\ngit push origin main'
deny $'true && cat <<EOF\n$(git push origin main)\nEOF'
deny $'true && cat <<-\x27EOF\x27\n\tprose\n\tEOF\ngit push origin main'
# AC2, class 1: the heredoc feeds a shell that follows an inert-looking first
# command on the same line. More generally the text before `<<` must be plain.
for owner in 'cat x; bash' 'cat x && bash' 'echo hi & sh' 'cat \>; bash' 'echo { ; bash -s } cat' 'cat #'; do
    deny "$owner $doc"
done
deny "echo \$(bash $doc"$'\n)'
deny $'cat \\<<\x27EOF\x27\ngit push origin main\nEOF'
# Not recognised on origin/main either, and still not: the first word is not `cat`.
deny "cat>a.md $doc"
deny "X=1 cat $doc"
# AC2, class 2: the body goes to a consumer the shell-pipe check does not know, to
# a process substitution, or to a file run on the same line; or the pipe ends the
# line and the consumer follows the terminator.
for tail in '| nice bash' '| command bash' '| nohup bash' '| sudo bash' '|& bash' '> >(bash)' \
    '| xargs -0 bash -c' '| source /dev/stdin' '| . /dev/stdin' '| (bash)' '| exec bash' '| eval $(cat)' \
    "| python3 -c 'import os,sys;os.system(sys.stdin.read())'" '| while read l; do eval "$l"; done' \
    '| tee /dev/null | bash' '> /dev/stdout | bash' '> x.sh; bash x.sh' '> x.sh && sh x.sh' '# | bash' '>| bash'; do
    for pre in '' 'true && '; do deny "${pre}cat <<'EOF' $tail"$'\ngit push origin main\nEOF'; done
done
deny "tee x.sh <<'EOF' >/dev/null; . ./x.sh"$'\ngit push origin main\nEOF'
deny "cat <<'EOF' |"$'\ngit push origin main\nEOF\nbash'
deny "cat <<'EOF' | \\"$'\ngit push origin main\nEOF\nbash'
deny $'cat <<\x27EOF\x27 "\n`git push origin main`\n"\nEOF'
# AC2, class 3: `cat` was rebound earlier in the command, ...
for earlier in 'cat() ( bash )' 'cat () { bash; }' 'function cat { bash; }' 'cat() bash' 'alias cat=bash' \
    "eval 'cat() ( bash )'" 'exec 3> >(bash)' 'source ./lib.sh' '. ./lib.sh' 'hash -p /bin/bash cat' "trap 'x' DEBUG" \
    'builtin alias cat=bash' 'command alias cat=bash' 'enable -n cat' 'PATH=/tmp/x:$PATH' 'export IFS=x' 'BASH_ENV=./rc true'; do
    deny "$earlier"$'\n'"cat $doc"
done
for form in 'cat <<"EOF"' "cat <<-'EOF'" "cat << 'EOF'"; do deny $'cat() ( bash )\n'"$form"$'\ngit push origin main\nEOF'; done
deny $'source /dev/stdin <<\x27EOF\x27\ncat() ( bash )\nEOF\ncat <<\x27EOF\x27\ngit push origin main\nEOF'
# ... or the heredoc sits inside a compound command whose output is piped, ...
deny $'if true; then\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nfi | bash'
deny $'while true; do\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nbreak; done | bash'
deny $'time while true; do\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nbreak; done | bash'
deny $'! if true; then\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nfi | bash'
deny $'( case x in\nx)\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n;; esac ) | bash'
# (not a complete command on its own: pins that `)` ends a command, so `do` is a command word)
deny $'(true) do\ncat <<\x27EOF\x27\ngit push origin main\nEOF\ndone | bash'
# ... or inside a quote, group or continuation left open by an earlier line.
deny $'echo "start\ncat <<\x27EOF\x27"\ngit push origin main\nEOF'
deny $'echo "start\nx; cat <<\x27EOF\x27"\ngit push origin main\nEOF'
deny $'bash -s a \\\ncat <<\x27EOF\x27\ngit push origin main\nEOF'
deny $'(\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n) | bash'
deny $'{ : }\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n} | bash'
deny $': )\n(\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n) | bash'
deny $'echo "$(echo "\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n")"'
deny $'echo "${x:-"\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"}"'
deny $'echo "`echo "\ncat <<\x27EOF\x27\n$(git push origin main)\nEOF\n"`"'
deny $'echo $\x27a\\\x27\x27 "it\x27s\ncat <<\x27EOF\x27\n"\\"\ngit push origin main'
deny $'true # "\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"'
deny $'# say "hi\necho "x\ncat <<\x27EOF\x27\n`git push origin main`\nEOF\n"'
# Any other `<<` on an earlier line may start a body that is not shell text.
deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'git commit -F - <<\x27EOF\x27\nmsg\nEOF\ncat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
deny $'grep -q x <<< "$v"\ncat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
# AC2, class 4: the shell ends the body at the delimiter exactly (`<<-` strips
# leading tabs only) and ends the delimiter word only at a blank or a redirect.
deny $'cat <<\x27EOF\x27\n  EOF\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\nEOF \ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'cat <<-\x27EOF\x27\n \tEOF\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'cat <<-\x27EOF\x27\n\tprose\n\tEOF\ngit push origin main'
deny $'cat <<\x27EO\x27F\nprose\nEOF\ngit push origin main\nEO'
deny $'cat <<\x27EOF\x272>&1\nEOF\ncat <<\x27X\x27\nEOF2\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\r\nEOF\ncat <<\x27X\x27\nEOF\r\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\xc2\xa0x\nEOF\ncat <<\x27X\x27\nEOF\xc2\xa0x\ngit push origin main\nX'
# A body that is shown cannot hide what follows it: its quotes are not the shell's.
deny $'cat > "a.md" <<\x27EOF\x27\ndon\x27t\nEOF\ngit push origin main'
deny $'cat <<\x27EOF\x27 | nice bash\necho "\nEOF\ngit push origin main'
# Ordinary earlier lines leave nothing open: the heredoc after them is still data.
allow $'echo done\ncat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'echo \x27a\\\x27\ncat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'git commit -m "subject\n\nit\x27s the body"\ncat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'(echo "5\\" pipe" it\\\x27s\n) # group closed\ncat > a.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ncat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
allow $'gh issue create --title t --body "Repro:\ncd repo && cat > f <<\x27EOF\x27\nis refused when chained\n"'
# AC5: one 200 KB line of word-initial `#` is decided (deny) well inside the 5 s hook budget.
node -e 'const { spawnSync } = require("child_process");
const command = "echo x " + " #".repeat(100000) + "\ngit push origin main";
const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.argv[2] });
const started = Date.now();
const out = spawnSync("node", [process.argv[1]], { input, encoding: "utf8" }).stdout;
const ms = Date.now() - started;
if (!out.includes("\"deny\"") || ms > 2500) { console.log("FAIL 200 KB line: " + ms + " ms, " + out.slice(0, 80)); process.exit(1); }' "$HOOK" "$ROOT" || fails=$((fails + 1))
[ "$fails" -eq 0 ] && echo "heredoc parsing cases passed"
