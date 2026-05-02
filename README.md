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
