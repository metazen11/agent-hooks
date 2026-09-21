---
name: quality-gate
description: "Three-layer engineering quality gate: JSON Schema contract, Python/Node validators, git pre-commit hook, and GitHub Action CI. Validates agent-produced plans before commit and merge."
user-invocable: false
---

# Engineering Quality Gate

Enforceable contract for agent-produced engineering plans. Validates JSON output against a schema + business rules at three enforcement points: self-validation, git pre-commit, and CI.

## Installation

```bash
node install.js --project=/path/to/repo --all
```

## Architecture

1. **System Prompt** (CLAUDE.md / AGENTS.md) — tells agents to produce JSON
2. **JSON Schema** (schemas/quality-gate-output.schema.json) — the contract
3. **Validators** (Python + Node.js) — schema + business rules
4. **Git Hook** — blocks commits with invalid plans
5. **GitHub Action** — blocks PRs with invalid plans
