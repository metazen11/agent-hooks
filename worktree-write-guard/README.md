# worktree-write-guard hook

PreToolUse hook that blocks a sub-agent dispatched into a git worktree from
writing to the **main** worktree (or running destructive Bash against paths
outside its own worktree).

## Incident this prevents

`reports/2026-05-24-runaway-subagent-postmortem.md`: a sub-agent dispatched into
`.claude/worktrees/agent-XXX/` used absolute paths (copied from issue bodies,
CLAUDE.md, or tool output) like `/Users/mz/_CODING/<project>/Makefile` and edited
the MAIN worktree's files instead of its assigned worktree. `git-session.js`
caught the resulting commit and redirected it, but only *after* the wrong file
was already modified. This hook stops the write before it happens.

## What it does

On `Edit|Write|NotebookEdit`, if the session is running inside a worktree,
refuses writes whose target resolves outside that worktree. For `Bash`, refuses
destructive commands operating on paths outside the worktree.

## Install

```bash
cd worktree-write-guard
node install.js            # symlink + PreToolUse(Edit|Write|NotebookEdit|Bash) entry
node install.js --uninstall
```

Idempotent — re-running reports "already in settings.json" rather than
duplicating the entry.

## Related

- `dispatch-gate` — refuses the dispatch up front when an issue already has a
  branch/worktree (prevents two agents racing the same files).
- `git-session` — redirects protected-branch commits and drops handoff markers;
  the last line of defense this guard front-runs.
