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
check allow $'true && cat > note.md <<\x27EOF\x27\nrm '$ROOT'/repo/main/out.txt\nEOF'
check deny $'cat x; bash <<\x27EOF\x27\nrm '$ROOT'/repo/main/out.txt\nEOF'
check deny $'true && cat <<\x27EOF\x27\nprose\nEOF\nrm '$ROOT'/repo/main/out.txt'
check allow "cd repo && S=x && cat > \$S/a.md 2>&1 $doc"
# Recognition is an allowlist: quoting, escaping, grouping or a comment before `<<`
# means the owner cannot be read off the line, so the body stays visible.
for owner in 'bash -s $(true; echo ) cat' 'bash -s `true; echo ` cat' 'bash -s a\; cat' 'bash -s >| cat' 'true # && cat' \
    'cat \>; bash' 'bash -s "$(echo "a ; cat " )"' "bash -s 'a\\' '; cat '" '>cat bash -s' 'bash -s >>| cat'; do
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
check allow $'gh issue create --title t --body "Repro:\ncd repo && cat > f <<\x27EOF\x27\nis refused when chained\n"'
check allow $'git commit -m "subject\n\nit\x27s the body"\ntrue && cat > a.md '"$doc"
check allow $'(echo "say \\"hi\\"" it\\\x27s\n) # don\x27t\ntrue && cat > a.md <<\x27EOF\x27 > "${OUT}" # it\x27s a note\nrm '$ROOT$'/repo/main/out.txt\nEOF'
# Heredoc bodies are raw text for every owner: they neither open quotes nor nest heredocs.
check allow $'cat > a.md <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md '"$doc"
check allow $'git commit -F - <<\x27EOF\x27\ndon\x27t\nEOF\ntrue && cat > b.md '"$doc"
check deny $'bash <<\x27EOF\x27\ncat <<\x27X\x27\nEOF\nrm '$ROOT$'/repo/main/out.txt\nX'
# A `<<` that is not recognised may start a body that is not shell text, so
# recognition stops for the rest of the command.
check deny $'cat > "f" <<\x27EOF\x27\nsay "hi\nEOF\ngit commit -m "x\ny; cat <<\x27EOF2\x27\n`rm '$ROOT$'/repo/main/out.txt`\n"'
[ "$fails" -eq 0 ] && echo "$cases command-parsing cases passed"
