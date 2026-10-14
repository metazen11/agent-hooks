# reconcile-gate

Strict-block PreToolUse hook that enforces the global branching contract. The global model is single-trunk (feature branch → squash PR → `main`); the hook enforces it only where a repo opts in with a marker on `main`, and otherwise keeps the two-trunk rule (PRs only `dev` → `main`).

## What it does

Every Bash tool call is inspected. If the command starts with `gh pr create`, the hook reads `--base` and `--head` (also `-B`/`-H` and `--base=…`/`--head=…` forms) and refuses the call unless `--base` is `main` or `master` (the production trunk) AND:

- **two-trunk (default, fail closed)**: `--head` must be `dev` or `develop`.
- **single-trunk (positive opt-in)**: `.reconcile-gate.json` declares `{"model":"single-trunk"}` (the legacy `{"allowed":[{"base":"main","head":"*"}]}` is equivalent) and is committed on the SHA-verified `origin/main`/`origin/master` (see below). Then any `--head` may target `main`/`master`.

Absence of a `dev`/`develop` branch does **not** imply single-trunk: offline, shallow clones (`actions/checkout`) and forged local refs all look like "no dev", so detection by absence would fail open. A missing, malformed, unverifiable (ls-remote failure/timeout), working-tree-only or feature-branch-only config keeps the two-trunk rule.

Always denied (even with `--force-anyway`): `gh pr merge --admin`, and `git push <remote> main|HEAD:main|:refs/heads/main` (same for `master`).

**Residual risk:** MCP tools (e.g. anvil `create_pr` / `git_push`) are not Bash calls and bypass this hook entirely. Close that with GitHub branch protection (required reviews and checks, `enforce_admins`), which is server-side.

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

- Single-trunk (opt-in marker): every change is a feature-branch PR to `main`, merged only after CI, independent code review and auditor PASS.
- Two-trunk (fail-closed default): routine agent work lands on `dev` via `/reconcile`, no PR; the only sanctioned PR is `dev → main`.
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

Runs 65 cases covering allow/deny paths, the per-project override, the single-trunk opt-in (shallow clone, ls-remote failure, forged ref, working-tree/feature-branch-only and malformed config all deny), and the always-deny rules.

## Decision matrix

| Command | Decision |
|---|---|
| `gh pr create --base main --head dev …` | allow |
| `gh pr create --base master --head develop …` | allow |
| `gh pr create --base=main --head=dev …` | allow |
| `gh pr create -B main -H dev …` | allow |
| `gh pr create --base main --head feat/x --force-anyway …` | allow (bypass) |
| `gh pr create --base main --head feat/x …` | allow only with the single-trunk marker on verified `origin/main`; otherwise **deny** |
| `gh pr merge … --admin`, `git push origin main` | **deny** (always) |
| `gh pr create --base feat/x --head dev …` | **deny** |
| `gh pr create --base main …` (no head) | **deny** |
| `gh pr create` (no flags) | **deny** |
| `gh pr list`, `gh pr view`, etc. | allow |
| `mygh pr create …`, `echo …`, etc. | allow |
| Anything not a `Bash` tool call | allow |
