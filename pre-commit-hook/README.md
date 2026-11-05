# pre-commit-hook

Multi-agent pre-commit code quality hook with installation wizard for Claude Code, Codex, Gemini CLI, and Anvil.

## What it does

Runs 5 quality checks on staged files before every commit:

1. **Simplicity** — Detects over-engineering (deep inheritance, complex comprehensions)
2. **Security** — OWASP patterns (SQL injection, command injection, hardcoded secrets, XSS)
3. **Naming** — Python snake_case/PascalCase, JavaScript camelCase
4. **Tests** — Runs related pytest tests for changed files
5. **Documentation** — Docstring coverage, TODO/FIXME flags, line length

## Installation

Run the installer from the project being installed into (or pass
`--project=/path/to/repo`). It refuses to run from inside this package
directory, because the per-agent instruction files belong in the consuming
project.

### Interactive wizard

```bash
node ~/_CODING/hooks/pre-commit-hook/install.js
```

### Specific agents

```bash
node ~/_CODING/hooks/pre-commit-hook/install.js --agent=claude,git
node ~/_CODING/hooks/pre-commit-hook/install.js --agent=codex,gemini --project=/path/to/repo
```

### All detected agents

```bash
node ~/_CODING/hooks/pre-commit-hook/install.js --all
```

### Via skills-cli

```bash
npx skills add metazen11/hooks@pre-commit-hook
```

### Uninstall

```bash
node ~/_CODING/hooks/pre-commit-hook/install.js --uninstall
node ~/_CODING/hooks/pre-commit-hook/install.js --uninstall --agent=claude
```

## How it works per agent

| Agent | Strategy |
|-------|----------|
| **Git** | Symlinks bash script to `.git/hooks/pre-commit` |
| **Claude Code** | PreToolUse hook intercepts `git commit` in Bash tool, runs checks, blocks on failure |
| **Codex** | Appends instruction to project `AGENTS.md` |
| **Gemini CLI** | Appends instruction to project `GEMINI.md` |
| **Anvil** | Appends instruction to `.anvil/instructions.md` |

### Claude Code integration

The wrapper (`pre-commit-wrapper.js`) implements the PreToolUse hook protocol:
- Intercepts Bash tool calls containing `git commit`
- Allows `--no-verify` to pass through (user explicitly bypassing)
- Runs the bash pre-commit script in the working directory
- **Fail-open**: if the script is missing or times out, the commit proceeds

### Codex / Gemini / Anvil integration

These agents don't have native lifecycle hooks. Instead, an instruction block is injected into their project-level instruction files, directing the agent to run the quality check before committing.

Instruction blocks are marker-delimited for clean uninstall:
```
<!-- pre-commit-hook-start -->
...
<!-- pre-commit-hook-end -->
```

## Testing

```bash
node test.js
```

## Files

```
SKILL.md                    skills-cli metadata
package.json                npm metadata
install.js                  Multi-agent installer wizard
pre-commit-wrapper.js       Claude Code hook bridge
test.js                     Unit tests
instructions/
  agents.md.tpl             Codex instruction template
  gemini.md.tpl             Gemini instruction template
  anvil.md.tpl              Anvil instruction template
```
