#!/usr/bin/env bash
set -euo pipefail
HOOK="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.js"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/repo/.claude/worktrees/agent-1" "$ROOT/repo/main"
fails=0; cases=0
check() {
  local expected="$1"; shift
  cases=$((cases + 1))
  local result
  local payload
  payload=$(node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_name:"Bash",tool_input:{command:process.argv[2]}}))' "$ROOT/repo/.claude/worktrees/agent-1" "$1")
  result=$(printf '%s\n' "$payload" | node "$HOOK")
  if [[ "$expected" == allow ]]; then
    [[ -z "$result" || "$result" == *'"allow"'* ]]
  else
    [[ "$result" == *'"deny"'* ]]
  fi || { printf 'FAIL expected %s: %q\n' "$expected" "$1"; fails=$((fails + 1)); }
}
check allow "cat $ROOT/repo/main/note.md"
check allow $'cat > note.md <<\x27EOF\x27\nThis note mentions '$ROOT'/repo/main and git push origin main.\nEOF'
check deny "echo data > $ROOT/repo/main/out.txt"
check deny "cd $ROOT/repo/main && rm file"
check deny "(cd $ROOT/repo/main && rm file)"
check deny "cat local.txt >$ROOT/repo/main/out.txt"
check deny "rm '$ROOT/repo/main/file'"
check deny "echo data > '$ROOT/repo/main/out.txt'"
check deny "cd . > $ROOT/repo/main/out.txt"
check deny "find $ROOT/repo/main -exec touch {} \\;"
check deny 'echo "$(rm '"$ROOT"'/repo/main/out.txt)"'
check allow 'echo "\$(rm '"$ROOT"'/repo/main/out.txt)"'
check deny $'echo "fake <<EOF"\nrm '$ROOT'/repo/main/out.txt'
check deny $'cat <<EOF\n$(rm '$ROOT'/repo/main/out.txt)\nEOF'
check deny $'cat <<END-DOC\nprose\nEND-DOC\nrm '$ROOT'/repo/main/out.txt'
check deny $'cat <<\x27EOF\x27 | /bin/bash\nrm '$ROOT'/repo/main/out.txt\nEOF'
check allow $'cat <<\x27EOF\x27\n$(rm '$ROOT'/repo/main/out.txt)\nEOF'
check deny "echo \"don't \$(rm $ROOT/repo/main/out.txt)\""
check deny "echo \"don't \$(rm \"$ROOT/repo/main/file\")\""
check deny "echo \"don't \$(rm $ROOT/repo/main/out.txt) \$(printf x)\""
check allow "printf '%s\\n' 'git push $ROOT/repo/main'"
check deny "printf '%s\\n' '$ROOT/repo/main/file' | xargs rm -f"
check allow "printf '%s\\n' '$ROOT/repo/.claude/worktrees/agent-1/file' | xargs rm -f"
check allow "find '$ROOT/repo/.claude/worktrees/agent-1' -name temp -print0 | xargs -0 rm -f"
# Issue #51: a heredoc feeds the LAST simple command before `<<`, not the first word of the line.
doc=$'<<\x27EOF\x27\nrm '$ROOT$'/repo/main/out.txt\nEOF'
check allow "true && cat > note.md $doc"
check deny "cat x; bash $doc"
check deny $'true && cat <<\x27EOF\x27\nprose\nEOF\nrm '$ROOT'/repo/main/out.txt'
check allow "cd repo && S=x && cat > \$S/a.md 2>&1 $doc"
# Recognition is an allowlist: quoting, escaping, grouping or a comment before `<<`
# means the owner cannot be read off the line, so the body stays visible.
for owner in 'bash -s $(true; echo ) cat' 'bash -s `true; echo ` cat' 'bash -s a\; cat' 'bash -s >| cat' 'true # && cat' \
    'cat \>; bash' 'bash -s "$(echo "a ; cat " )"' '>cat bash -s' 'bash -s >>| cat'; do
  check deny "$owner $doc"
done
check deny "echo \$(bash $doc"$'\n)'
check deny $'cat <<\x27EO\x27F\nprose\nEOF\nrm '$ROOT$'/repo/main/out.txt\nEO'
# Nothing is recognised while a quote, parenthesis or line continuation may be
# open from earlier lines, or on a line that leaves one open.
check deny $'echo "start\nx; cat <<\x27EOF\x27"\nrm '$ROOT$'/repo/main/out.txt\nEOF'
check deny $'echo "start\ncat <<\x27EOF\x27"\nrm '$ROOT$'/repo/main/out.txt\nEOF'
check deny $'cat <<\x27EOF\x27 "\n`rm '$ROOT$'/repo/main/out.txt`\n"\nEOF'
check deny $'bash -s a \\\ncat <<\x27EOF\x27\nrm '$ROOT$'/repo/main/out.txt\nEOF'
check deny $'(\ncat <<\x27EOF\x27\nrm '$ROOT$'/repo/main/out.txt\nEOF\n) | bash'
check deny $'{ : }\ncat <<\x27EOF\x27\nrm '$ROOT$'/repo/main/out.txt\nEOF\n} | bash'
check deny $'case x in x) :;; esac\n(\ncat <<\x27EOF\x27\nrm '$ROOT$'/repo/main/out.txt\nEOF\n) | bash'
check deny $'echo "$(echo "\ncat <<\x27EOF\x27\n`rm '$ROOT$'/repo/main/out.txt`\nEOF\n")"'
check deny $'echo "${x:-"\ncat <<\x27EOF\x27\n`rm '$ROOT$'/repo/main/out.txt`\nEOF\n"}"'
check deny $'echo "`echo "\ncat <<\x27EOF\x27\n$(rm '$ROOT$'/repo/main/out.txt)\nEOF\n"`"'
check deny $'echo $\x27a\\\x27\x27 "it\x27s\ncat <<\x27EOF\x27 # \x27\n`rm '$ROOT$'/repo/main/out.txt`\nEOF\n"'
check deny $'true # "\ncat <<\x27EOF\x27\n`rm '$ROOT$'/repo/main/out.txt`\nEOF\n"'
check deny $'# say "hi\necho "x\ncat <<\x27EOF\x27\n`rm '$ROOT$'/repo/main/out.txt`\nEOF\n"'
check allow $'grep -q x <<< "$v"\ntrue && cat > a.md '"$doc"
check allow $'gh issue create --title t --body "Repro:\ncd repo && cat > f <<\x27EOF\x27\nis refused when chained\n"'
check allow $'git commit -m "subject\n\nit\x27s the body"\ntrue && cat > a.md '"$doc"
check allow $'(echo "5\\" pipe" it\\\x27s\n) # group closed\ntrue && cat > a.md <<\x27EOF\x27 > $OUT 2>&1 # a note\nrm '$ROOT$'/repo/main/out.txt\nEOF'
# An inert heredoc body is raw text: an apostrophe in it does not open a quote.
check allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md '"$doc"
# Only inert heredocs are recognised. What any other command did with its body is
# unknown (`source /dev/stdin` can redefine `cat`), so nothing after it is
# recognised: a later inert heredoc that mentions a guarded path is denied.
check deny $'source /dev/stdin <<\x27EOF\x27\ncat() ( bash )\nEOF\ntrue && cat '"$doc"
check deny $'git commit -F - <<\x27EOF\x27\nmsg\nEOF\ntrue && cat > b.md '"$doc"
check deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\nrm '$ROOT$'/repo/main/out.txt\nX'
# A `<<` that is not recognised may start a body that is not shell text, so
# recognition stops for the rest of the command.
check deny $'cat > "f" <<\x27EOF\x27\nsay "hi\nEOF\ngit commit -m "x\ny; cat <<\x27EOF2\x27\n`rm '$ROOT$'/repo/main/out.txt`\n"'
# After the delimiter an inert heredoc line may carry only redirections to plain
# words and a plain comment. A pipe, another command or a process substitution can
# hand the body to something that runs it, in first position or chained.
rm_main="rm $ROOT/repo/main/out.txt"
for tail in '| nice bash' '| command bash' '| nohup bash' '| sudo bash' '|& bash' '> >(bash)' \
    '| xargs -0 bash -c' '| source /dev/stdin' '| . /dev/stdin' '| (bash)' '| exec bash' '| eval $(cat)' \
    "| python3 -c 'import os,sys;os.system(sys.stdin.read())'" '| while read l; do eval "$l"; done' \
    '| tee /dev/null | bash' '> /dev/stdout | bash' '> x.sh; bash x.sh' '> x.sh && sh x.sh'; do
  for pre in '' 'true && ' 'cd . && S=x && '; do check deny "${pre}cat <<'EOF' $tail"$'\n'"$rm_main"$'\nEOF'; done
done
for pre in '' 'true && '; do
  check deny "${pre}tee x.sh <<'EOF' >/dev/null; . ./x.sh"$'\n'"$rm_main"$'\nEOF'
  check deny "${pre}cat <<'EOF' |"$'\n'"$rm_main"$'\nEOF\nbash'
  check deny "${pre}cat <<'EOF' | \\"$'\n'"$rm_main"$'\nEOF\nbash'
  check deny "${pre}cat <<'EOF' | xargs rm -f"$'\n'"$ROOT/repo/main/out.txt"$'\nEOF'
done
check deny "true && cat <<'EOF' # | bash"$'\n'"$rm_main"$'\nEOF'
check allow "true && cat <<'EOF' > \$S/a.md 2>&1 # a note"$'\n'"$rm_main"$'\nEOF'
# A command name rebound earlier in the command (function, alias) makes `cat` mean
# anything, so nothing is recognised after one.
for def in 'cat() ( bash )' 'cat () { bash; }' 'function cat { bash; }' 'cat() bash' 'alias cat=bash'; do
  for pre in '' 'true && '; do check deny "$def"$'\n'"${pre}cat $doc"; done
done
for form in 'cat <<"EOF"' "cat <<-'EOF'" "cat << 'EOF'"; do check deny $'cat() ( bash )\ntrue && '"$form"$'\n'"$rm_main"$'\nEOF'; done
# The terminator is the delimiter exactly (`<<-` strips leading tabs only) and the
# delimiter word ends only where the shell ends it. A terminator the shell does not
# accept must not end the body early: a later fake marker would hide real commands.
check deny $'cat <<\x27EOF\x27\n  EOF\ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'true && cat <<\x27EOF\x27\n  EOF\ntrue && cat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x27\nEOF \ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'true && cat <<-\x27EOF\x27\n \tEOF\ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x272>&1\nEOF\ncat <<\x27X\x27\nEOF2\n'"$rm_main"$'\nX'
check deny $': )\n(\ncat '"$doc"$'\n) | bash'
check deny $'cat <<\x27EOF\x27\r\nEOF\ncat <<\x27X\x27\nEOF\r\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x27\xc2\xa0x\nEOF\ncat <<\x27X\x27\nEOF\xc2\xa0x\n'"$rm_main"$'\nX'
check deny $'true && cat <<-\x27EOF\x27\n\tprose\n\tEOF\n'"$rm_main"
check allow $'true && cat <<-\x27EOF\x27\n\t'"$rm_main"$'\n\tEOF'
# Commands inside if/while/for/case blocks can be piped out as a whole.
check deny $'if true; then\ncat '"$doc"$'\nfi | bash'
check deny $'while true; do\ncat '"$doc"$'\nbreak; done | bash'
check deny $'for x in 1; do true; cat '"$doc"$'\ndone | bash'
check deny $'( case x in\nx)\ncat '"$doc"$'\n;; esac ) | bash'
check allow $'echo done\ntrue && cat > a.md '"$doc"
# A leading assignment is not stripped: PATH=... changes what `cat` resolves to.
check deny "true && X=1 cat $doc"
# One 200 KB line of word-initial `#` is decided (deny) well inside the 5 s hook budget.
cases=$((cases + 1))
node -e 'const { spawnSync } = require("child_process");
const command = "echo x " + " #".repeat(100000) + "\nrm " + process.argv[2] + "/repo/main/out.txt";
const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.argv[2] + "/repo/.claude/worktrees/agent-1" });
const started = Date.now();
const out = spawnSync("node", [process.argv[1]], { input, encoding: "utf8" }).stdout;
const ms = Date.now() - started;
if (!out.includes("\"deny\"") || ms > 2500) { console.log("FAIL 200 KB line: " + ms + " ms, " + out.slice(0, 80)); process.exit(1); }' "$HOOK" "$ROOT" || fails=$((fails + 1))
[ "$fails" -eq 0 ] && echo "$cases command-parsing cases passed"
