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
allow $'(echo "5\\" pipe" it\\\x27s\n) # group closed\ntrue && cat > a.md <<\x27EOF\x27 > $OUT 2>&1 # a note\n'"$gated"$'\nEOF'
# An inert heredoc body is raw text: an apostrophe in it does not open a quote.
allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
# Only inert heredocs are recognised. What any other command did with its body is
# unknown (`source /dev/stdin` can redefine `cat`), so nothing after it is
# recognised: a later inert heredoc that mentions a gated command is denied.
deny $'source /dev/stdin <<\x27EOF\x27\ncat() ( bash )\nEOF\ntrue && cat <<\x27EOF\x27\ngit push origin main\nEOF'
deny $'git commit -F - <<\x27EOF\x27\nmsg\nEOF\ntrue && cat > b.md <<\x27EOF\x27\n'"$gated"$'\nEOF'
deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
# A `<<` that is not recognised may start a body that is not shell text, so
# recognition stops for the rest of the command.
deny $'cat > "f" <<\x27EOF\x27\nsay "hi\nEOF\ngit commit -m "x\ny; cat <<\x27EOF2\x27\n`git push origin main`\n"'
# After the delimiter an inert heredoc line may carry only redirections to plain
# words and a plain comment. A pipe, another command or a process substitution can
# hand the body to something that runs it, in first position or chained.
for tail in '| nice bash' '| command bash' '| nohup bash' '| sudo bash' '|& bash' '> >(bash)' \
    '| xargs -0 bash -c' '| source /dev/stdin' '| . /dev/stdin' '| (bash)' '| exec bash' '| eval $(cat)' \
    "| python3 -c 'import os,sys;os.system(sys.stdin.read())'" '| while read l; do eval "$l"; done' \
    '| tee /dev/null | bash' '> /dev/stdout | bash' '> x.sh; bash x.sh' '> x.sh && sh x.sh'; do
    for pre in '' 'true && ' 'cd . && S=x && '; do deny "${pre}cat <<'EOF' $tail"$'\ngit push origin main\nEOF'; done
done
for pre in '' 'true && '; do
    deny "${pre}tee x.sh <<'EOF' >/dev/null; . ./x.sh"$'\ngit push origin main\nEOF'
    deny "${pre}cat <<'EOF' |"$'\ngit push origin main\nEOF\nbash'
    deny "${pre}cat <<'EOF' | \\"$'\ngit push origin main\nEOF\nbash'
done
allow "true && cat <<'EOF' > \$S/a.md 2>&1 # a note"$'\n'"$gated"$'\nEOF'
# A command name rebound earlier in the command (function, alias) makes `cat` mean
# anything, so nothing is recognised after one.
for def in 'cat() ( bash )' 'cat () { bash; }' 'function cat { bash; }' 'cat() bash' 'alias cat=bash'; do
    for pre in '' 'true && '; do deny "$def"$'\n'"${pre}cat <<'EOF'"$'\ngit push origin main\nEOF'; done
done
for form in 'cat <<"EOF"' "cat <<-'EOF'" "cat << 'EOF'"; do deny $'cat() ( bash )\ntrue && '"$form"$'\ngit push origin main\nEOF'; done
# The terminator is the delimiter exactly (`<<-` strips leading tabs only) and the
# delimiter word ends only where the shell ends it. A terminator the shell does not
# accept must not end the body early: a later fake marker would hide real commands.
deny $'cat <<\x27EOF\x27\n  EOF\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'true && cat <<\x27EOF\x27\n  EOF\ntrue && cat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\nEOF \ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'true && cat <<-\x27EOF\x27\n \tEOF\ncat <<\x27X\x27\nEOF\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\r\nEOF\ncat <<\x27X\x27\nEOF\r\ngit push origin main\nX'
deny $'cat <<\x27EOF\x27\xc2\xa0x\nEOF\ncat <<\x27X\x27\nEOF\xc2\xa0x\ngit push origin main\nX'
deny $'true && cat <<-\x27EOF\x27\n\tprose\n\tEOF\ngit push origin main'
allow $'true && cat <<-\x27EOF\x27\n\t'"$gated"$'\n\tEOF'
# Commands inside if/while/for/case blocks can be piped out as a whole.
deny $'if true; then\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nfi | bash'
deny $'while true; do\ncat <<\x27EOF\x27\ngit push origin main\nEOF\nbreak; done | bash'
deny $'for x in 1; do true; cat <<\x27EOF\x27\ngit push origin main\nEOF\ndone | bash'
deny $'( case x in\nx)\ncat <<\x27EOF\x27\ngit push origin main\nEOF\n;; esac ) | bash'
# A leading assignment is not stripped: PATH=... changes what `cat` resolves to.
deny $'true && X=1 cat <<\x27EOF\x27\ngit push origin main\nEOF'
# One 200 KB line of word-initial `#` is decided (deny) well inside the 5 s hook budget.
node -e 'const { spawnSync } = require("child_process");
const command = "echo x " + " #".repeat(100000) + "\ngit push origin main";
const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.argv[2] });
const started = Date.now();
const out = spawnSync("node", [process.argv[1]], { input, encoding: "utf8" }).stdout;
const ms = Date.now() - started;
if (!out.includes("\"deny\"") || ms > 2500) { console.log("FAIL 200 KB line: " + ms + " ms, " + out.slice(0, 80)); process.exit(1); }' "$HOOK" "$ROOT" || fails=$((fails + 1))
[ "$fails" -eq 0 ] && echo "heredoc parsing cases passed"
