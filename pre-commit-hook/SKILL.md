---
name: pre-commit
description: "Code quality pre-commit hook with multi-agent installation wizard. Checks simplicity, security, naming conventions, tests, and documentation for Python/JS. Installs to Git, Claude Code, Codex, Gemini CLI, and Anvil."
user-invocable: false
---

# Pre-Commit Code Quality Hook

A multi-agent pre-commit hook that ensures code quality before commits.

## Checks

1. **Simplicity** — Detects over-engineering (deep inheritance, complex comprehensions)
2. **Security** — OWASP patterns (SQL injection, command injection, hardcoded secrets, XSS)
3. **Naming** — Python snake_case/PascalCase, JavaScript camelCase
4. **Tests** — Runs related tests for changed files
5. **Documentation** — Docstring coverage, TODO/FIXME flags, line length

## Installation

```bash
# Interactive wizard
node install.js

# Specific agents
node install.js --agent=claude,git

# All detected agents
node install.js --all

# Uninstall
node install.js --uninstall
```

## Distribution

```bash
npx skills add metazen11/hooks@pre-commit-hook
```
