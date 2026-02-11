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

### memory-context

Injects recent claude-mem observations into session context on startup. Queries the local SQLite database for the 3 most recent memories matching the current project.

```bash
cd memory-context
node install.js            # symlinks into ~/.claude/hooks/ + patches settings
node install.js --uninstall
```

Requires claude-mem plugin with SQLite database at `~/.claude-mem/claude-mem.db`.
