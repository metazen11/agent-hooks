# Hooks

Git hooks and agent hooks for development workflows.

## Installation

```bash
./hooks/install.sh
```

## Available Hooks

### pre-commit

Runs before each commit to ensure code quality. See [`pre-commit-hook/`](pre-commit-hook/) for the multi-agent installer.

1. **Simplicity Check** - Detects over-engineering patterns
2. **Security Check** - OWASP-style vulnerability scan (SQL injection, XSS, hardcoded secrets)
3. **Naming Conventions** - Python snake_case/PascalCase, JavaScript camelCase
4. **Test Verification** - Runs related tests for changed files
5. **Documentation** - Docstring coverage, TODO/FIXME flags, line length

### pre-commit-hook (multi-agent installer)

Interactive wizard that installs the pre-commit hook across multiple AI coding agents:

```bash
cd pre-commit-hook
node install.js              # Interactive wizard
node install.js --all        # All detected agents
node install.js --uninstall  # Remove all
```

Supports: **Git** (native hook), **Claude Code** (PreToolUse), **Codex** (AGENTS.md instruction), **Gemini CLI** (GEMINI.md instruction), **Anvil** (.anvil instruction).

Also distributable via: `npx skills add metazen11/hooks@pre-commit-hook`

See [`pre-commit-hook/README.md`](pre-commit-hook/README.md) for full documentation.

## Bypassing Hooks

In emergencies, bypass with:

```bash
git commit --no-verify
```

**Not recommended** - fix the issues instead.

## Agent Hooks

### contracts

Cross-agent engineering contract enforcer. Installs a canonical, numbered rulebook (`engineering-contract.md`) and its mechanical checks so Claude Code, Anvil, Codex, and Gemini all obey the same rules. The PreToolUse hook blocks Write/Edit/Bash violations of §1 (hardcoding), §3 (symptom suppression), §6 (AI attribution), and §7 (destructive operations). Judgment sections (§2, §4, §5, §8) are enforced in code review. Every rule is citable as `CONTRACT §N`.

```bash
cd contracts
node install.js              # Interactive wizard
node install.js --all        # All detected agents
node install.js --uninstall  # Remove all
```

Supports: **Claude Code** (PreToolUse hook, deterministic), **Anvil** (CONTRACTS.md instruction), **Codex** (AGENTS.md instruction), **Gemini** (GEMINI.md instruction).

See [`contracts/README.md`](contracts/README.md) for full documentation.

### quality-gate

Three-layer engineering quality gate: JSON Schema contract, validators (Python + Node.js), git pre-commit hook, and GitHub Action CI. Validates agent-produced plans before commit and merge.

```bash
cd quality-gate
node install.js --project=/path/to/repo --all     # Install into target project
node install.js --project=/path/to/repo --uninstall
```

Targets: **git** (schema + validator + hook), **github** (CI workflow), **claude** (CLAUDE.md), **codex** (AGENTS.md), **gemini** (GEMINI.md).

See [`quality-gate/README.md`](quality-gate/README.md) for full documentation.

### plan-refiner

Deterministic plan quality gate. Blocks ExitPlanMode (Claude Code) and plan submission (Anvil) until the plan is refined through a senior engineering checklist. Uses a one-shot `refined_once: true` frontmatter stamp to prevent infinite loops.

```bash
cd plan-refiner
node install.js              # Interactive wizard
node install.js --all        # All detected agents
node install.js --uninstall  # Remove all
```

Supports: **Claude Code** (PreToolUse hook, deterministic), **Anvil** (middleware, deterministic), **Codex** (AGENTS.md instruction), **Gemini** (GEMINI.md instruction).

See [`plan-refiner/README.md`](plan-refiner/README.md) for full documentation.

### env-guard

Prevents agents from surfacing `.env` secrets in conversations. Blocks Read/Edit on secret files, returns masked variable names.

```bash
cd env-guard
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

See [`env-guard/README.md`](env-guard/README.md) for full documentation.

### git-session

Automated git workflow for Claude Code sessions. Handles branch management, checkpoints, and session cleanup.

- **SessionStart**: Pull latest, create working branch if on protected branch
- **PreToolUse**: Checkpoint commit before destructive operations (Edit, Write, rm, etc.)
- **SessionEnd**: Commit all changes, push to remote

```bash
cd git-session
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Configure via environment variables: `GIT_HOOK_PROTECTED_BRANCHES`, `GIT_HOOK_AUTO_PUSH`, `GIT_HOOK_AUTO_PULL`, `GIT_HOOK_CHECKPOINT`, `GIT_HOOK_VERBOSE`.

**Checkpoint skip conditions** — to prevent racing the agent's own git operations, the pre-edit checkpoint is suppressed when any of these are true:

| Condition | Source |
|---|---|
| Next Bash tool call starts with `git commit\|push\|pull\|fetch\|rebase\|cherry-pick\|reset\|revert\|checkout\|stash\|merge\|tag\|am\|format-patch\|rev-parse\|switch` | `tool_input.command` inspection — automatic |
| Within 60s of the most recent git workflow Bash call | In-process skip window |
| `.git/.claude-busy` lock file exists with mtime < 5 minutes | Explicit opt-in for orchestrators |
| In-progress rebase / merge / cherry-pick / bisect / revert | `.git/` marker files |
| Detached HEAD or branch switch / reset / rebase within last 10 s | git reflog |
| 30 s cooldown since last checkpoint | In-process timer |

Stale lock files (mtime > 5 min) are ignored — a forgotten `.git/.claude-busy` does not silently disable checkpoints for the rest of the session.

Run `git-session/test-pre-edit-skips.sh` to verify these skip paths end-to-end.

### reconcile-gate

Strict-block PreToolUse hook that enforces the global branching contract: `gh pr create` is refused unless `--base` is the production trunk (`main`/`master`) and `--head` is the integration trunk (`dev`/`develop`). Bypass with `--force-anyway`. Routine agent work lands on the integration trunk via the `reconciler` specialist / `/reconcile` skill, not via per-change PRs.

```bash
cd reconcile-gate
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

See [`reconcile-gate/README.md`](reconcile-gate/README.md) for the full decision matrix. Run `reconcile-gate/test-reconcile-gate.sh` for the 17-case self-test.

### context-primer

Keeps the project + autonomous-agents instruction files in context so the agent starts (and stays) primed on the governing contracts. Time-based, not per-edit:

- **SessionStart**: injects the required instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `coding_requirements.md`, `CONTRIBUTING.md`, `docs/coding-standards.md`, `.autonomous.json` discovered at the repo root/cwd, plus the global `~/.claude/CLAUDE.md`).
- **UserPromptSubmit**: re-injects them every 50 user turns (drift guard); no-op otherwise.
- **PreToolUse** (`Edit|Write|NotebookEdit|Bash`): one-time safety net that fires only if a work session never got the SessionStart injection — silent once primed. Read-only tools are never gated.

```bash
cd context-primer
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Fails open (never wedges a session). Cadence knob: `REPRIME_EVERY` at the top of `context-primer.js`. See [`context-primer/README.md`](context-primer/README.md) for full documentation.

### output-redact

PostToolUse(Bash) hook that redacts secrets from Bash tool output before the agent sees the raw value. A mechanical filter at the harness layer — because behavioral "never echo secrets" lessons have failed repeatedly (the per-case rationalization step is the leak).

```bash
cd output-redact
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

See [`output-redact/README.md`](output-redact/README.md). Complements `env-guard` (which blocks reads of secret files up front).

### worktree-write-guard

PreToolUse(`Edit|Write|NotebookEdit|Bash`) hook that blocks a worktree-dispatched sub-agent from writing to the main worktree (or running destructive Bash outside its own worktree). Prevents the runaway-subagent incident (`reports/2026-05-24-runaway-subagent-postmortem.md`).

```bash
cd worktree-write-guard
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

See [`worktree-write-guard/README.md`](worktree-write-guard/README.md).

### dispatch-gate

PreToolUse(`Task`) hook that refuses an orchestrator sub-agent dispatch when a branch (`fix/<N>-*`, `feat/<N>-*`, `work/<N>-*`) or worktree for the target GitHub issue already exists — preventing two agents from racing the same files (issue #710).

**Available but not wired by default** — wiring a strict-block gate is an operator decision.

```bash
cd dispatch-gate
node install.js            # symlink only (available, INACTIVE)
node install.js --wire     # also add the PreToolUse(Task) settings entry
node install.js --uninstall
```

See [`dispatch-gate/README.md`](dispatch-gate/README.md).

### memory-context (legacy)

Injects recent claude-mem observations into session context on startup. Queries the local SQLite database for the 3 most recent memories matching the current project.

```bash
cd memory-context
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Requires claude-mem plugin with SQLite database at `~/.claude-mem/claude-mem.db`.

> **Note**: Superseded by `agent-memory` (below) which uses Postgres + pgvector for better search and includes its own context injection.

---

### agent-memory

**Moved to standalone repo:** [metazen11/agent-memory](https://github.com/metazen11/agent-memory)

Persistent cross-session memory for AI coding agents. Built as a replacement for [claude-mem](https://github.com/thedotmack/claude-mem) which suffers from PostToolUse hook hangs (120s timeout, fires on every tool call), zombie worker-service processes (50-80+ per session), and ChromaDB segfaults on Apple Silicon. See the [full comparison](https://github.com/metazen11/agent-memory#why-replace-claude-mem) for details.

One command installs everything: Docker, Python venv, model downloads, hooks, MCP server, and skills.

```bash
git clone https://github.com/metazen11/agent-memory.git
cd agent-memory
node install.js
```

See the [agent-memory README](https://github.com/metazen11/agent-memory) for full documentation.

---

## Utilities

### fix-claude-mem.sh (legacy)

Fixes the claude-mem plugin's PostToolUse hook that causes multi-second hangs after every tool call. Removes the problematic hook, kills zombie processes, and optionally cleans up the ChromaDB vector database.

```bash
./fix-claude-mem.sh              # full fix
./fix-claude-mem.sh --status     # check current state
./fix-claude-mem.sh --dry-run    # preview changes
```

Re-run after claude-mem plugin updates. See [`MEMORY.md`](MEMORY.md) for full background.
