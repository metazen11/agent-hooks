# reconcile-gate

Strict-block PreToolUse hook that enforces the global branching contract: PRs are only permitted from an integration trunk to a production trunk.

## What it does

Every Bash tool call is inspected. If the command starts with `gh pr create`, the hook reads `--base` and `--head` (also `-B`/`-H` and `--base=…`/`--head=…` forms) and refuses the call unless:

- `--base` is `main` or `master` (the production trunk), AND
- `--head` is `dev` or `develop` (the integration trunk).

Bypass: append `--force-anyway` anywhere in the command. The flag is visible in transcripts and audits.

All other Bash calls and all non-Bash tool calls pass through unchanged.

## Per-project override

A repo whose own contract defines a different PR flow (e.g. feature branch → `dev`) can add allowed pairs in `.reconcile-gate.json` at its root:

```json
{ "allowed": [{ "base": "dev", "head": "*" }] }
```

- Pairs are **added** to the defaults; `head: "*"` = any head. `base` may not be `"*"`. Pairs are explicit, so allowing feature → `dev` does not allow feature → `main`.
- Trusted only when **committed on the production trunk** (remote-tracking `origin/main` or `origin/master`; local branches are agent-writable and ignored; the tracking ref must also equal the real remote via `git ls-remote`, so offline or forged refs fall back to the stricter defaults) — the working tree is never read, so widening needs a human-reviewed merge.
- Ignored outside a git repo and when the command passes `--repo`/`-R`.
- Fails closed: invalid JSON or schema denies every `gh pr create` in that repo.
- `--force-anyway` remains the per-call escape.

## Why

See the global `CLAUDE.md` → **Branching & Integration Process (CONTRACT)** section. Short version:

- Routine agent work lands on the integration trunk via the `reconciler` specialist / `/reconcile` skill. No PR.
- The only sanctioned PR is the periodic `integration-trunk → production-trunk` human-review gate.
- This hook converts "the agent forgets and opens a per-change PR" from a recurring failure mode into an explicit, audited decision.

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

Runs 36 cases (including the per-project override) covering allow paths (canonical, alias, `=` form, bypass, non-Bash, lookalikes, short flags) and deny paths (feature head, feature base, missing flags, wrong direction).

## Decision matrix

| Command | Decision |
|---|---|
| `gh pr create --base main --head dev …` | allow |
| `gh pr create --base master --head develop …` | allow |
| `gh pr create --base=main --head=dev …` | allow |
| `gh pr create -B main -H dev …` | allow |
| `gh pr create --base main --head feat/x --force-anyway …` | allow (bypass) |
| `gh pr create --base main --head feat/x …` | **deny** |
| `gh pr create --base feat/x --head dev …` | **deny** |
| `gh pr create --base main …` (no head) | **deny** |
| `gh pr create` (no flags) | **deny** |
| `gh pr list`, `gh pr view`, etc. | allow |
| `mygh pr create …`, `echo …`, etc. | allow |
| Anything not a `Bash` tool call | allow |
