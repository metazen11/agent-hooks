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
allow() { payload "$1" | node "$HOOK" | grep -q '"allow"'; }
deny() { payload "$1" | node "$HOOK" | grep -q '"deny"'; }
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
deny $'cat <<END-DOC\nprose\nEND-DOC\ngit push origin main'
deny $'cat <<\x27END DOC\x27\nprose\nEND DOC\ngit push origin main'
echo "heredoc parsing cases passed"
