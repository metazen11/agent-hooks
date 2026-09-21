# reconcile-gate

Strict-block PreToolUse hook that enforces the global branching contract: PRs are only permitted from an integration trunk to a production trunk.

## What it does

Every Bash tool call is inspected. If the command starts with `gh pr create`, the hook reads `--base` and `--head` (also `-B`/`-H` and `--base=…`/`--head=…` forms) and refuses the call unless:

- `--base` is `main` or `master` (the production trunk), AND
- `--head` is `dev` or `develop` (the integration trunk).

Bypass: append `--force-anyway` anywhere in the command. The flag is visible in transcripts and audits.

All other Bash calls and all non-Bash tool calls pass through unchanged.

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

Runs 17 cases covering allow paths (canonical, alias, `=` form, bypass, non-Bash, lookalikes, short flags) and deny paths (feature head, feature base, missing flags, wrong direction).

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
