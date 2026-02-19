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
