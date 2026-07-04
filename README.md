# Hooks

Git hooks and agent hooks for development workflows.

## Installation

```bash
./hooks/install.sh
```

## Available Hooks

### pre-commit

Runs before each commit to ensure code quality:

1. **Simplicity Check** - Detects over-engineering patterns
   - Deep inheritance chains
   - Overly complex comprehensions

2. **Security Check** - OWASP-style vulnerability scan
   - SQL injection patterns
   - Command injection risks
   - Hardcoded secrets
   - XSS vulnerabilities (JS)

3. **Naming Conventions**
   - Python: snake_case functions, PascalCase classes
   - JavaScript: camelCase functions
   - Descriptive variable names

4. **Test Verification**
   - Runs related tests for changed files
   - Blocks commit on test failure

5. **Documentation**
   - Checks docstring coverage
   - Flags TODO/FIXME comments
   - Warns on overly long lines

## Bypassing Hooks

In emergencies, bypass with:

```bash
git commit --no-verify
```

**Not recommended** - fix the issues instead.

## Agent Hooks

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
