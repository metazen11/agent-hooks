# dispatch-gate hook

Strict-block hook for orchestrator `Task` dispatch dedup (issue #710).

## What it does

Before the orchestrator dispatches a sub-agent against a GitHub issue
referenced in the dispatch prompt, this hook checks for an existing
branch matching `fix/<N>-*`, `feat/<N>-*`, or `work/<N>-*` AND for an
active worktree on such a branch. If any match, it refuses the dispatch
so the operator can either reuse the existing agent or finish/delete
the existing work first.

## Install

The hook file at `~/.claude/hooks/dispatch-gate.js` is a symlink to
`~/_coding/hooks/dispatch-gate/dispatch-gate.js`. To wire it into the
PreToolUse hook chain, add a `Task` matcher to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      ...,
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/dispatch-gate.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

This is the same shape as the other gate hooks (`reconcile-gate`,
`worktree-write-guard`). The operator must run `update-config` or hand-
edit settings.json — by policy, agents cannot modify settings.json
without explicit operator approval.

## Bypass

Set `DISPATCH_GATE_DISABLE=true` in front of the dispatch call. Only
after asking the operator. Logged to stderr for the audit trail.

## Tests

Run `node ~/.claude/hooks/dispatch-gate.js` with a sample input to
verify behavior:

```bash
echo '{"tool_name":"Task","tool_input":{"prompt":"fix #999"}}' | \
  node ~/.claude/hooks/dispatch-gate.js
# → allow (no branch fix/999-* exists)

# Simulate a conflict by creating a branch first:
git branch fix/999-test
echo '{"tool_name":"Task","tool_input":{"prompt":"fix #999"},"cwd":"'$PWD'"}' | \
  node ~/.claude/hooks/dispatch-gate.js
# → deny (branch fix/999-test exists)
git branch -D fix/999-test
```

## Related

- Issue #710 — the symptom this prevents (two agents on #701 raced on
  the same files and live compose project)
- `reports/2026-05-24-runaway-subagent-postmortem.md` — the design
  precedent for strict-block hooks
- `~/.claude/hooks/worktree-write-guard.js` — the other strict-block
  hook in the same family
