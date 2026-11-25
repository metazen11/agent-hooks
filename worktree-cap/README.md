# Global worktree cap

The canonical hook is `worktree-cap.js`; `install.js` registers it in the user's
Codex and Claude settings while retaining unrelated settings and hook entries.
Install with `node install.js install`, or remove only this hook's registrations
with `node install.js uninstall`.

Install and uninstall share a host-level exclusive lock at
`~/.local/state/worktree-cap/installer.lock` (or under `XDG_STATE_HOME`). If an
installer exits unexpectedly and leaves the lock, inspect `owner.json` when
present; if it is missing or invalid, inspect the directory contents. Confirm
no installer is active before removing the lock directory. If writing the
owner file fails, this process removes its newly created lock only if it is
still empty. The lock directory is `0700` and its owner file is `0600`.

On installed hook paths, the hook counts every `git worktree list --porcelain`
entry for the repository being targeted, including the primary checkout. The
limit is five total worktrees. Before allowing another checkout, it verifies
origin and the committed branching policy even when the primary checkout is the
only one present; it also checks every non-primary checkout for uncommitted
changes and commits not present on the verified policy trunk. Dirty or
unlanded checkouts block creation and identify the path. Preserve dirty work
and resolve it first; inspect uncertain status or policy read-only. After the
affected checkouts are clean and policy is verified, single-trunk repositories
land through a feature-branch squash PR to `main`/`master`; legacy two-trunk
repositories use `/reconcile` to the unique verified `dev`/`develop`. Clear CI,
review, audit, or conflict blockers before retrying. The guard never merges,
pushes a trunk, creates `dev`/`develop`, or removes a checkout. It denies when
the repository, count, branching policy, or current remote readback cannot be
determined. Claude's native
`WorktreeCreate` handler creates the worktree itself under
`~/.claude/worktrees/<repository>/<name>` because that handler replaces
Claude's default Git worktree creation.

For recognized hook paths, a repo-common-dir lock serializes the count and
authorization check. Claude native creation holds it through `git worktree add`;
Codex agent isolation and direct shell calls hold it until `PostToolUse`. The
lock directory is mode `0700`; its `owner.json` file is mode `0600`. Locks
remain held until native creation finishes or a matching `PostToolUse` arrives.
The hook never reclaims a lock based only on age, because a long-running guarded
command could still be active. If a host crashes before the completion event,
inspect `owner.json` and confirm no guarded command is active before removing
the stale lock directory. This narrows races
among hook-controlled calls; it cannot coordinate with Git clients or processes
that bypass these hooks.

Prompt text that matches a clear owner-intent pattern can mint one short-lived
token. The host payloads do not provide a trustworthy human-origin signal, so
this is not owner authentication. The hook stores only hashed session/repository
identifiers, timestamp, expiry, used state, and (for Codex) the turn identifier;
it never stores prompt text. Codex tokens are bound to the Git common directory,
session, and turn. Claude does not document an owner-origin or turn ID on
`WorktreeCreate`; its token is bound to the Git common directory and session.
Delegated Codex calls carrying `agent_id` are denied. These hooks are guardrails,
not an identity or complete process-level authorization boundary.

## Coverage and limits

- Claude native `--worktree`, `EnterWorktree`, and isolation worktree requests
  reach `WorktreeCreate`; shell `git worktree add` is handled by `PreToolUse`.
- Codex local `Agent` and `Bash` tool calls are matched by `PreToolUse`, and
  `UserPromptSubmit` supplies a short-lived token bound to the canonical Git
  common directory and Codex session/turn where available. `PostToolUse`
  releases the repo lock after an agent or shell tool finishes.
- Arbitrary subprocesses, external Git clients, direct Git library calls,
  specialized tool routes that opt out of hooks, and application-level worktree
  operations without hook callbacks are outside this guarantee.
- Shell command inspection is best effort. Simple newline-separated commands
  are tokenized; shell aliases, command substitution, complex multiline syntax,
  indirection, and generated commands may not be recognized.
- Direct `git`, `command git`, and absolute Git executable paths are parsed;
  explicit `--git-dir` paths select the counted repository. `GIT_DIR`,
  `GIT_WORK_TREE`, or `GIT_COMMON_DIR` assignments on a direct add are refused
  because their effective target cannot be safely inferred from the hook input.
- Reconciliation checks trust `origin` only when the selected remote-tracking
  trunk ref matches its current `ls-remote` SHA. Single-trunk mode requires the
  committed `.reconcile-gate.json` marker; otherwise exactly one verified
  `origin/dev` or `origin/develop` must exist. Offline or stale refs fail closed.
- Claude's native worktree hook replaces its default creation behavior. The
  implementation deliberately supports the default Git-backed repository
  path only; other VCS backends are not supported.

Settings are wired by the installer, not by hand. Re-run it after moving the
canonical hooks checkout so the global symlinks point to the current source.
The installer requires regular `settings.json` and `hooks.json` files and
refuses symlinked config paths before changing either config or hook links;
atomic replacement would otherwise replace the symlink instead of updating its
target. If a host manages these files through symlinks, resolve that ownership
at the host configuration layer before installing this guard.
The installer lock serializes its own install/uninstall runs, not unrelated
configuration managers; do not run it while another process is replacing or
editing either settings file.

### Host hook trust review

After installation, inspect the host's registered hook entry and confirm its
command resolves to the canonical `worktree-cap.js` path before accepting a
host trust prompt. Review the command and event names in Codex `hooks.json` or
Claude `settings.json`, then approve/trust the hook through that host's native
review flow when prompted. The installer does not edit host trust stores or
silently approve hooks; a successful install is not proof that the host has
trusted or invoked the hook. Verify an actual hook callback in each host before
relying on enforcement there.
