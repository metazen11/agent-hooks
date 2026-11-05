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

`branch` is the branch whose `origin/<branch>` the checkout is compared with.
It must also be the branch checked out for `--apply` to fast-forward; on any
other branch the repo is still reported when it is behind, and never touched.

## Behaviour

**Notify-only by default. It does not modify your repos.**

At session start (at most once per `SELF_UPDATE_EVERY_HOURS`, default 24) it
runs `git fetch` — read-only — and, if a repo is behind, injects a prompt
naming the repos and the exact `git merge --ff-only` command. You decide.

"Behind" means the checkout lacks commits that are on `origin/<branch>`. That
is asked whatever branch is checked out and however dirty the tree is, because
the hooks run from this checkout and `git-session` moves it onto
`work/session-<date>` at every session start. Where a fast-forward is not
possible as things stand, the prompt gives the count and the reason and no
command:

```
- agent-hooks: 2 new commits on origin/main; on 'work/session-20261105', not 'main'
```

Nothing merges without an explicit `--apply`. The fetch is the only thing
notify mode does to a repo: HEAD, branch, index and working tree stay as they are.

## Manual use

```bash
node self-update.js --check        # report state; no fetch, no merge
node self-update.js --apply --now  # fast-forward now, ignoring the throttle
```

## Refusal contract

Even with `--apply` it is **fast-forward only**, and refuses — leaving the repo
untouched and saying why — in every state below. "Not updated" and "not
reported" are different things: the first three are still reported in notify
mode, the last three are not.

| Condition | `--apply`: not updated, because | Notify mode when behind |
|---|---|---|
| working tree is dirty | never clobber uncommitted work | reported, no command |
| HEAD is not on the configured branch | you are mid-task elsewhere | reported against `origin/<branch>`, no command |
| branch has diverged (local commits) | needs a real reconcile, not a ff | reported, no command |
| on the configured branch with no upstream | nothing to compare against | not reported |
| rebase/merge/bisect in progress | another git operation owns the repo | not reported, not fetched |
| fetch fails (offline, or `origin/<branch>` does not exist) | state of the remote unknown | not reported |

It never merges non-ff, rebases, resets, stashes, or force-anythings. Network
failure is non-fatal. Worst case: it does nothing and says so.

Verified against a fixture repo in all five states — see the refusal tests in
the commit that added this hook.

## Guarantees

- **Always exits 0.** An updater must never break a session.
- **Silent when there is nothing to report.**
