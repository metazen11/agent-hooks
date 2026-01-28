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
