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

### Writing prose that mentions a path outside the worktree

Text is not a command, but the guard only knows that in two cases:

- **Use a file-writing tool** (Write/Edit) for notes, issue bodies and commit
  messages, then pass the file (`gh issue create --body-file f`). Nothing in a
  file is inspected.
- **Or use a plain quoted heredoc, first on its line:** `cat > notes.md <<'EOF'`
  … `EOF`, also `cat <<'EOF' > notes.md` and `tee notes.md <<'EOF'`. The body is
  treated as data only when `cat`/`echo`/`printf`/`tee` is the first and only
  command on the line; nothing before `<<` is quoted, escaped or grouped; the
  delimiter is a quoted plain word; only `> file` / `>> file` (not a descriptor
  such as `>&2`) or a plain comment follows it; the terminator is the delimiter
  exactly; and every earlier line of the command uses only `cd`, `true`, `:`,
  `mkdir`, `echo`, `printf`, `pwd`, `cat`, `tee`, `touch`, `ls`, `git`, `gh` and
  plain variable assignments.

Everything else is deliberately **not** recognised, because a shell may run the
body: a **chained** heredoc (`cd repo && cat > f <<'EOF'`), a pipe or second
command after it, a quoted file name before `<<`, a heredoc inside `$(...)`, or
one that follows a loop, a function definition, `eval`, `source`, `export` and
the like. Such a body is inspected like any other command text. Put the heredoc
on its own line, or write the file with a tool.

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
