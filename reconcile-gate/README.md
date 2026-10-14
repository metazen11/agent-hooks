# reconcile-gate

Strict-block PreToolUse hook that enforces the global branching contract. Default is **single-trunk** (feature branch → squash PR → `main`); a repo that keeps a `dev`/`develop` branch opts into **two-trunk** (PRs only `dev` → `main`).

## What it does

Every Bash tool call is inspected. If the command starts with `gh pr create`, the hook reads `--base` and `--head` (also `-B`/`-H` and `--base=…`/`--head=…` forms) and refuses the call unless `--base` is `main` or `master` (the production trunk) AND:

- **single-trunk (default)**: the repo has neither `refs/remotes/origin/dev` nor `origin/develop` (checked with `git -C <cwd> show-ref --verify --quiet`), so `--head` may be any branch.
- **two-trunk (opt-in)**: one of those refs exists, so `--head` must be `dev` or `develop`.
- **fail closed**: if git cannot answer (not a repo, git error, timeout) or the command passes `--repo`/`-R`, the two-trunk rule applies.

Remote-tracking refs can be stale; run `git fetch --prune` after creating or deleting the integration trunk.

Human approval is opt-in per repo through GitHub branch protection (required approving reviews on `main`, optionally CODEOWNERS), not through this hook. Agents never approve or merge in a human-gated repo.

Bypass: append `--force-anyway` anywhere in the command. The flag is visible in transcripts and audits.

All other Bash calls and all non-Bash tool calls pass through unchanged.

## Per-project override

A repo whose own contract defines an additional PR flow (e.g. feature branch → `dev`) can add allowed pairs in `.reconcile-gate.json` at its root:

```json
{ "allowed": [{ "base": "dev", "head": "*" }] }
```

- Pairs are **added** to the defaults; `head: "*"` = any head. `base` may not be `"*"`. Pairs are explicit, so in a two-trunk repo allowing feature → `dev` does not allow feature → `main`.
- Trusted only when **committed on the production trunk** (remote-tracking `origin/main` or `origin/master`; local branches are agent-writable and ignored; the tracking ref must also equal the real remote via `git ls-remote`, so offline or forged refs fall back to the stricter defaults) — the working tree is never read, so widening needs a human-reviewed merge.
- Ignored outside a git repo and when the command passes `--repo`/`-R`.
- Fails closed: invalid JSON or schema denies every `gh pr create` in that repo.
- `--force-anyway` remains the per-call escape.

## Why

See the global `CLAUDE.md` → **Branching & Integration Process (CONTRACT)** section. Short version:

- Single-trunk: every change is a feature-branch PR to `main`, merged only after CI, independent code review and auditor PASS.
- Two-trunk (opt-in): routine agent work lands on `dev` via `/reconcile`, no PR; the only sanctioned PR is `dev → main`.
- Either way, opening the wrong kind of PR becomes an explicit, audited decision.

## Install

```bash
cd reconcile-gate
node install.js          # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

After install, restart Claude Code to activate.

## Self-test

```bash
./reconcile-gate/test-reconcile-gate.sh
```

Runs 51 cases covering allow/deny paths, the per-project override, and trunk detection (single-trunk allows feature → main; `dev`/`develop` present denies it; git failure and `--repo` fail closed).

## Decision matrix

| Command | Decision |
|---|---|
| `gh pr create --base main --head dev …` | allow |
| `gh pr create --base master --head develop …` | allow |
| `gh pr create --base=main --head=dev …` | allow |
| `gh pr create -B main -H dev …` | allow |
| `gh pr create --base main --head feat/x --force-anyway …` | allow (bypass) |
| `gh pr create --base main --head feat/x …` | allow if no `origin/dev`/`develop`; **deny** if one exists or git fails |
| `gh pr create --base feat/x --head dev …` | **deny** |
| `gh pr create --base main …` (no head) | **deny** |
| `gh pr create` (no flags) | **deny** |
| `gh pr list`, `gh pr view`, etc. | allow |
| `mygh pr create …`, `echo …`, etc. | allow |
| Anything not a `Bash` tool call | allow |
