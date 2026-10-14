# Contributing

The branching contract for this repo. It lives here — versioned, in the
repo — so it reaches every machine and every agent that clones it, rather
than living in one developer's `~/.claude/`.

## Trunk

This repo is **single-trunk** (the global default). A repo that keeps a
`dev`/`develop` branch opts into two-trunk (`dev -> main` PRs only).

| Branch | Role | How it receives commits |
|---|---|---|
| `main` | production | **only** a squash-merged PR from a feature branch |

## Rules

1. **Never push directly to `main`.** Work happens on a feature branch
   (`work/issue-<n>-<slug>`) and reaches `main` through a squash PR.
2. **A PR merges only when** CI is green, an independent code review has run,
   and an auditor has returned PASS against the originating issue.
3. **Human approval is opt-in** via GitHub branch protection (required
   approving reviews on `main`, optionally CODEOWNERS). Agents never approve
   or merge in a human-gated repo.
4. **Verify the end state, not the action.** "I pushed it" is not "it landed".
   Check the branch, the PR, the check.

## Enforcement: layers, by strength

| Layer | Where it runs | Bypassable? |
|---|---|---|
| **Branch protection** on `main` | GitHub (server) | No, `enforce_admins` is on |
| **`.githooks/pre-push`** | your machine | Yes: `ALLOW_PROTECTED_PUSH=1` (audited) |
| **This document** | your eyes | Entirely |

Only branch protection travels automatically. The hook needs one command per
clone (below); this file needs someone to read it.

## Setup — once per MACHINE

```
~/_CODING/hooks/repo-contract/bootstrap.sh
```

That does two things, and is safe to re-run:

1. Installs a **git template** so every *future* clone on this machine
   activates its own `.githooks/` automatically — no per-repo step ever again.
2. **Retrofits existing clones** under `~/_CODING` (a template only applies at
   clone time, so repos you already have need this once).

Neither step overrides a `core.hooksPath` you set yourself.

Prefer to do it by hand, or working in one repo only?

```
git config core.hooksPath .githooks
```

Check either way:

```
~/_CODING/hooks/repo-contract/bootstrap.sh --check
git config --get core.hooksPath          # expect: .githooks
```

### Why this step exists at all

Git deliberately refuses to let a cloned repo activate its own hooks — that
would execute a stranger's code the moment you clone. The template inverts
that safely: *you* install it once, locally, and it then applies your choice
to your own clones. There is no way to remove the step entirely, which is
exactly why the two server-side layers above carry the real weight.

## Emergencies

`ALLOW_PROTECTED_PUSH=1 git push ...` skips the local hook and prints a
warning. It does **not** skip GitHub branch protection — that needs an
explicit, logged settings change. If you find yourself reaching for it
regularly, the contract is wrong; fix the contract, not the push.
