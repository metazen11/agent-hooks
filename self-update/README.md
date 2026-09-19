# self-update

Tells you when your hook/plugin repos have new commits upstream — and leaves
them alone until you say otherwise.

Hooks live in a git repo but run from `~/.claude/hooks` symlinks. Without
something watching, a machine silently drifts months behind.

## Install

```bash
node install.js                # symlink + wire SessionStart
node install.js --hours 168    # ... check at most weekly
node install.js --uninstall    # remove cleanly
```

Restart Claude Code afterwards. Node only, no dependencies.

## Configure which repos

[`repos.json`](repos.json), beside this file:

```json
{
  "repos": [
    { "slug": "agent-hooks",  "path": "~/_CODING/hooks",      "branch": "dev" },
    { "slug": "agent-memory", "path": "~/_CODING/agentMemory", "branch": "dev" }
  ]
}
```

`branch` is the branch that must be checked out for an update to be considered.
On any other branch the repo is skipped untouched — you are mid-task there.

## Behaviour

**Notify-only by default. It does not modify your repos.**

At session start (at most once per `SELF_UPDATE_EVERY_HOURS`, default 24) it
runs `git fetch` — read-only — and, if a repo is behind, injects a prompt
naming the repos and the exact `git merge --ff-only` command. You decide.

Nothing merges without an explicit `--apply`.

## Manual use

```bash
node self-update.js --check        # report state; no fetch, no merge
node self-update.js --apply --now  # fast-forward now, ignoring the throttle
```

## Refusal contract

Even with `--apply` it is **fast-forward only**, and refuses — leaving the repo
untouched and saying why — when:

| Condition | Why |
|---|---|
| working tree is dirty | never clobber uncommitted work |
| HEAD is not on the configured branch | you are mid-task elsewhere |
| no upstream tracking branch | nothing to compare against |
| branch has diverged (local commits) | needs a real reconcile, not a ff |
| rebase/merge/bisect in progress | another git operation owns the repo |

It never merges non-ff, rebases, resets, stashes, or force-anythings. Network
failure is non-fatal. Worst case: it does nothing and says so.

Verified against a fixture repo in all five states — see the refusal tests in
the commit that added this hook.

## Guarantees

- **Always exits 0.** An updater must never break a session.
- **Silent when there is nothing to report.**
