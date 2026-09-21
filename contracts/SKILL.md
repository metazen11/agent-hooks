---
name: contracts
description: "Cross-agent engineering contract enforcer. Installs a numbered, citable rulebook (engineering-contract.md) with mechanical checks that block Write/Edit/Bash violations of §1 (hardcoding), §3 (symptom suppression), §6 (AI attribution), and §7 (destructive operations). Supports Claude Code, Anvil, Codex, and Gemini."
user-invocable: false
---

# Contracts — Engineering Contract Enforcer

Installs the canonical `engineering-contract.md` and its mechanical checks so every agent working in this operator's workspace obeys the same numbered rules. Sections are stable and citable as `CONTRACT §N` in hooks, reviews, and agent-to-agent messages.

## How it works

1. Contract text lives in `engineering-contract.md` with numbered sections §1..§N.
2. Each mechanical section has a `checks/s<N>-<slug>.js` module exporting `check(toolName, toolInput)`.
3. On Claude Code, the PreToolUse hook `contracts-hook.js` runs every check against every tool call and denies on the first violation, citing the section.
4. On Anvil, Codex, and Gemini, an instruction block in the agent's project file directs the agent to read and cite the contract.

## Installation

```bash
node install.js              # Interactive wizard
node install.js --all        # All detected agents
node install.js --uninstall  # Remove all
```
