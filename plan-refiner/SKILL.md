---
name: plan-refiner
description: "Deterministic plan quality gate. Blocks ExitPlanMode until the plan is refined through a senior engineering checklist. Supports Claude Code, Anvil, Codex, and Gemini."
user-invocable: false
---

# Plan Refiner — Quality Gate Hook

Automatically intercepts plan submission and blocks it until the plan passes a production engineering quality checklist. Uses a one-shot refinement marker to prevent infinite loops.

## How it works

1. Agent writes a plan in plan mode
2. Agent calls ExitPlanMode (or Anvil equivalent)
3. Hook reads the plan file, checks for `refined_once: true` frontmatter
4. If not refined: blocks submission, injects the refiner checklist
5. Agent refines the plan, stamps it, resubmits
6. Hook sees stamp, allows submission

## Installation

```bash
node install.js              # Interactive wizard
node install.js --all        # All detected agents
node install.js --uninstall  # Remove all
```
