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
# Issue #58 (tightening only). A quoted body is dropped only when the heredoc's
# command is the first and only command on its line, the text before `<<` is
# plain, the delimiter is a plain quoted word and only redirections follow it.
# A body that used to be dropped but fails any of this is shown instead.
rm_main="rm $ROOT/repo/main/out.txt"
doc=$'<<\x27EOF\x27\n'"$rm_main"$'\nEOF'
# AC4: plain first-on-line quoted heredocs stay data, whatever the body mentions.
for line in "cat > note.md <<'EOF'" "cat <<'EOF' > note.md" "tee note.md <<'EOF'" "cat > \$S/a.md <<'EOF'" \
    "cat <<'EOF' > \$S/a.md # a note" 'cat <<"EOF"' "cat << 'EOF'" "echo <<'EOF'" "printf x <<'EOF'" \
    "cat<<'EOF'" "cat <<'EOF'>a.md" "cat <<'EOF' >> a.md"; do
  check allow "$line"$'\n'"$rm_main"$'\nEOF'
done
check allow $'cat <<-\x27EOF\x27\n\t'"$rm_main"$'\n\tEOF'
# AC3: a heredoc whose command follows a separator is not recognised (body visible).
for sep in '&&' '||' ';' '|' '&'; do check deny "true $sep cat > note.md $doc"; done
check deny "cd repo && S=x && cat > \$S/a.md $doc"
check deny $'true && cat <<\x27EOF\x27\nprose\nEOF\n'"$rm_main"
check deny $'true && cat <<-\x27EOF\x27\n\tprose\n\tEOF\n'"$rm_main"
# AC2, class 1: the heredoc feeds a shell that follows an inert-looking first
# command on the same line. More generally the text before `<<` must be plain.
for owner in 'cat x; bash' 'cat x && bash' 'echo hi & sh' 'cat \>; bash' 'echo { ; bash -s } cat' 'cat #'; do
  check deny "$owner $doc"
done
check deny "echo \$(bash $doc"$'\n)'
check deny $'cat \\<<\x27EOF\x27\n'"$rm_main"$'\nEOF'
# Not recognised on origin/main either, and still not: the first word is not `cat`.
check deny "cat>a.md $doc"
check deny "X=1 cat $doc"
# AC2, class 2: the body goes to a consumer the shell-pipe check does not know, to
# a process substitution, or to a file run on the same line; or the pipe ends the
# line and the consumer follows the terminator.
for tail in '| nice bash' '| command bash' '| nohup bash' '| sudo bash' '|& bash' '> >(bash)' \
    '| xargs -0 bash -c' '| source /dev/stdin' '| . /dev/stdin' '| (bash)' '| exec bash' '| eval $(cat)' \
    "| python3 -c 'import os,sys;os.system(sys.stdin.read())'" '| while read l; do eval "$l"; done' \
    '| tee /dev/null | bash' '> /dev/stdout | bash' '> x.sh; bash x.sh' '> x.sh && sh x.sh' '# | bash' '# | nice bash' '>| bash'; do
  for pre in '' 'true && '; do check deny "${pre}cat <<'EOF' $tail"$'\n'"$rm_main"$'\nEOF'; done
done
check deny "tee x.sh <<'EOF' >/dev/null; . ./x.sh"$'\n'"$rm_main"$'\nEOF'
check deny "cat <<'EOF' |"$'\n'"$rm_main"$'\nEOF\nbash'
check deny "cat <<'EOF' | \\"$'\n'"$rm_main"$'\nEOF\nbash'
check deny "cat <<'EOF' | xargs rm -f"$'\n'"$ROOT/repo/main/out.txt"$'\nEOF'
check deny $'cat <<\x27EOF\x27 "\n`'"$rm_main"$'`\n"\nEOF'
# AC2, class 3: `cat` was rebound earlier in the command, ...
for earlier in 'cat() ( bash )' 'cat () { bash; }' 'function cat { bash; }' 'cat() bash' 'alias cat=bash' \
    "eval 'cat() ( bash )'" 'exec 3> >(bash)' 'source ./lib.sh' '. ./lib.sh' 'hash -p /bin/bash cat' "trap 'x' DEBUG" \
    'builtin alias cat=bash' 'command alias cat=bash' 'enable -n cat' 'PATH=/tmp/x:$PATH' 'export IFS=x' 'BASH_ENV=./rc true' \
    'hash cat=/bin/bash' 'export PATH=/tmp/x:$PATH' 'typeset -f cat' 'declare -f cat' 'shopt -s expand_aliases' 'setopt aliases' \
    'set -o posix' "X=1 eval 'cat() ( bash )'" 'LD_PRELOAD=./x.so true'; do
  check deny "$earlier"$'\n'"cat $doc"
done
for form in 'cat <<"EOF"' "cat <<-'EOF'" "cat << 'EOF'"; do check deny $'cat() ( bash )\n'"$form"$'\n'"$rm_main"$'\nEOF'; done
check deny $'source /dev/stdin <<\x27EOF\x27\ncat() ( bash )\nEOF\ncat '"$doc"
# ... or its output was attached to a shell earlier (descriptor, process
# substitution, fifo). A descriptor is never a plain redirect target.
for earlier in 'exec > >(bash)' ': > >(bash)' 'mkfifo p; bash < p &'; do check deny "$earlier"$'\n'"cat $doc"; done
check deny $'exec 3> >(bash)\ncat <<\x27EOF\x27 >&3\n'"$rm_main"$'\nEOF'
check deny $'mkfifo p; bash < p &\ncat <<\x27EOF\x27 >p\n'"$rm_main"$'\nEOF'
for line in "cat <<'EOF' >&3" "cat <<'EOF' > /dev/fd/3" "cat > /dev/fd/3 <<'EOF'" "tee /dev/fd/3 <<'EOF'" "cat <<'EOF' > a.md 2>&1"; do
  check deny "$line"$'\n'"$rm_main"$'\nEOF'
done
# ... or the heredoc is inside a command substitution, whose output the outer
# command may run. Prose there is still fine.
check deny $'eval "$(cat <<\x27EOF\x27\n'"$rm_main"$'\nEOF\n)"'
check deny $'bash -c "$(cat <<\x27EOF\x27\n'"$rm_main"$'\nEOF\n)"'
check allow $'git commit -m "$(cat <<\x27EOF\x27\nfix: thing\n\nThe same `gh pr create` was refused once.\nEOF\n)"'
# ... or the heredoc sits inside a compound command whose output is piped, ...
check deny $'if true; then\ncat '"$doc"$'\nfi | bash'
check deny $'while true; do\ncat '"$doc"$'\nbreak; done | bash'
check deny $'time while true; do\ncat '"$doc"$'\nbreak; done | bash'
check deny $'! if true; then\ncat '"$doc"$'\nfi | bash'
check deny $'( case x in\nx)\ncat '"$doc"$'\n;; esac ) | bash'
# ... or inside a quote, group or continuation left open by an earlier line.
check deny $'echo "start\ncat <<\x27EOF\x27"\n'"$rm_main"$'\nEOF'
check deny $'echo "start\nx; cat <<\x27EOF\x27"\n'"$rm_main"$'\nEOF'
check deny $'echo a \\\ncat '"$doc"
for op in '&&' '||' '|' '|&'; do check deny "true $op"$'\n'"cat $doc"; done
check deny $'(\ncat '"$doc"$'\n) | bash'
check deny $'{ : }\ncat '"$doc"$'\n} | bash'
check deny "true &&"$'\n\n'"cat $doc"
check deny $': )\n(\ncat '"$doc"$'\n) | bash'
check deny $'echo "$(echo "\ncat <<\x27EOF\x27\n`'"$rm_main"$'`\nEOF\n")"'
check deny $'echo "${x:-"\ncat <<\x27EOF\x27\n`'"$rm_main"$'`\nEOF\n"}"'
check deny $'echo $\x27a\\\x27\x27 "it\x27s\ncat <<\x27EOF\x27\n"\\"\n'"$rm_main"
check deny $'true # "\ncat <<\x27EOF\x27\n`'"$rm_main"$'`\nEOF\n"'
check deny $'# say "hi\necho "x\ncat <<\x27EOF\x27\n`'"$rm_main"$'`\nEOF\n"'
# Any other `<<` on an earlier line may start a body that is not shell text.
check deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'git commit -F - <<\x27EOF\x27\nmsg\nEOF\ncat > b.md '"$doc"
check deny $'grep -q x <<< "$v"\ncat > a.md '"$doc"
# AC2, class 4: the shell ends the body at the delimiter exactly (`<<-` strips
# leading tabs only) and ends the delimiter word only at a blank or a redirect.
check deny $'cat <<\x27EOF\x27\n  EOF\ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x27\nEOF \ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'cat <<-\x27EOF\x27\n \tEOF\ncat <<\x27X\x27\nEOF\n'"$rm_main"$'\nX'
check deny $'cat <<-\x27EOF\x27\n\tprose\n\tEOF\n'"$rm_main"
check deny $'cat <<\x27EO\x27F\nprose\nEOF\n'"$rm_main"$'\nEO'
check deny $'cat <<\x27EOF\x27#x\nEOF\ncat <<\x27X\x27\nEOF#x\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x272>&1\nEOF\ncat <<\x27X\x27\nEOF2\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x27\r\nEOF\ncat <<\x27X\x27\nEOF\r\n'"$rm_main"$'\nX'
check deny $'cat <<\x27EOF\x27\xc2\xa0x\nEOF\ncat <<\x27X\x27\nEOF\xc2\xa0x\n'"$rm_main"$'\nX'
# A body that is shown cannot hide what follows it: its quotes are not the shell's
# and a `cd` in it does not move the directory the guard follows.
check deny $'cat > "a.md" <<\x27EOF\x27\ndon\x27t\nEOF\n'"$rm_main"
check deny $'cat <<\x27EOF\x27 | nice cat\necho "\nEOF\n'"$rm_main"
check deny $'cat <<\x27EOF\x27 | nice cat\n'"cd $ROOT/repo/.claude/worktrees/agent-1/a/b/c"$'\nEOF\ncd ../../../main\nrm file'
# Earlier lines made only of harmless commands and plain assignments leave nothing
# open: the heredoc after them is still data. Any other command word does not.
check allow $'# step one\ncat > a.md '"$doc"
check allow $'cat <<-\x27EOF\x27\n\tx\n\tEOF\ncat > a.md '"$doc"
check allow $'echo \x27a\\\x27\ncat > a.md '"$doc"
check allow $'echo done\ncat > a.md '"$doc"
check allow $'cd repo && mkdir -p x; S=x git add . 2>&1 | cat\ncat > a.md '"$doc"
check deny $'make build\necho ok\ncat > a.md '"$doc"
check deny $'make build\ncat > a.md '"$doc"
check allow $'git commit -m "subject\n\nit\x27s the body"\ncat > a.md '"$doc"
check allow $'echo "5\\" pipe" it\\\x27s # a note\ncat > a.md '"$doc"
check allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ncat > b.md '"$doc"
check allow $'gh issue create --title t --body "Repro:\ncd repo && cat > f <<\x27EOF\x27\nis refused when chained\n"'
# Whether a body is data is a property of the call, not of the process: the same
# command stripped twice in one process gives the same result, and only a call
# marked as a command-substitution body shows it. (The hook runs main() on load
# and exports nothing, so the unit is read from the source file.)
cases=$((cases + 1))
node -e 'const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync(process.argv[1], "utf8");
const unit = src.slice(src.indexOf("// A quoted note passed to"), src.indexOf("\n}\n", src.indexOf("function shellState(")) + 3);
const strip = vm.runInNewContext(unit + "; stripNonExecutableHereDocs");
const q = String.fromCharCode(39), command = "cat > a.md <<" + q + "EOF" + q + "\nBODY\nEOF";
const first = strip(command), second = strip(command), nested = strip(command, true);
if (first !== second || first.includes("BODY") || !nested.includes("BODY")) { console.log("FAIL strip twice in one process: " + JSON.stringify([first, second, nested])); process.exit(1); }' "$HOOK" || fails=$((fails + 1))
# AC5: one 200 KB line of word-initial `#` is decided (deny) well inside the 5 s hook budget.
cases=$((cases + 1))
node -e 'const { spawnSync } = require("child_process");
const command = "echo x " + " #".repeat(100000) + "\nrm " + process.argv[2] + "/repo/main/out.txt";
const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.argv[2] + "/repo/.claude/worktrees/agent-1" });
const started = Date.now();
const out = spawnSync("node", [process.argv[1]], { input, encoding: "utf8" }).stdout;
const ms = Date.now() - started;
if (!out.includes("\"deny\"") || ms > 2500) { console.log("FAIL 200 KB line: " + ms + " ms, " + out.slice(0, 80)); process.exit(1); }' "$HOOK" "$ROOT" || fails=$((fails + 1))
[ "$fails" -eq 0 ] && echo "$cases command-parsing cases passed"
