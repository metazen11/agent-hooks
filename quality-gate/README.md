# quality-gate

Three-layer engineering quality gate for agent-produced plans: JSON Schema contract, Python/Node.js validators, git pre-commit hook, and GitHub Action CI.

## The Three Layers

### Layer 1: System Prompt

Instruction fragments injected into CLAUDE.md / AGENTS.md / GEMINI.md that tell agents to produce structured JSON output to `plans/` and self-validate before committing.

### Layer 2: JSON Schema

`schemas/quality-gate-output.schema.json` — the enforceable contract. Required fields:

- `verdict` (approved | needs_refinement | blocked)
- `source_reference` (system, id)
- `summary`, `gaps_found`
- `refined_plan` (objective, scope, non_goals, canonical_names, steps)
- `acceptance_criteria` (each must have `testable: true`)
- `testing_plan` (unit, integration, e2e, negative, regression)
- `security_review` (risks, controls)
- `compliance_review`, `edge_cases`, `failure_modes`
- `observability` (logs, metrics, alerts, error_messages)
- `deployment` (steps, rollback)
- `definition_of_done`, `documentation`, `improvements`

### Layer 3: Validation

Two validators (same logic, use whichever runtime is available):

```bash
# Python (recommended, requires: pip install jsonschema)
python scripts/validate_quality_gate.py plans/gh-142-feature.json

# Node.js (zero deps fallback)
node scripts/validate_quality_gate_node.js plans/gh-142-feature.json
```

**Business rules** enforced beyond schema:
- Blocked verdict requires `block_reason`
- Security risks must be non-trivial (>5 chars)
- `canonical_names` mapping required
- All acceptance criteria must be testable
- Minimum 3 acceptance criteria
- `source_reference.id` cannot be empty or "TBD"
- `definition_of_done` cannot be generic ("all tests pass")
- All failure modes must have recovery strategies

## Installation

```bash
# Install into a target project (required: --project flag)
cd quality-gate
node install.js --project=/path/to/your/repo --all

# Specific targets only
node install.js --project=/path/to/repo --target=git,claude

# Uninstall
node install.js --project=/path/to/repo --uninstall
```

### What gets installed

| Target | Files copied/modified |
|--------|----------------------|
| **git** | `schemas/`, `scripts/`, `plans/`, `.git/hooks/pre-commit` (chained) |
| **github** | `.github/workflows/quality-gate.yml` |
| **claude** | Appends fragment to `CLAUDE.md` |
| **codex** | Appends fragment to `AGENTS.md` |
| **gemini** | Appends fragment to `GEMINI.md` |

## Workflow

```
Agent reads issue
  → Agent produces plans/gh-142-feature.json
  → Agent self-validates with scripts/validate_quality_gate.py
  → Agent fixes and re-validates until passing
  → git commit → pre-commit hook validates → blocks if invalid
  → PR created → GitHub Action validates → blocks if invalid
```

## Plan file naming

```
plans/{source}-{id}-{slug}.json
```

Examples:
- `plans/gh-142-neris-ingestion.json`
- `plans/asana-PROJ-301-auth-refactor.json`
- `plans/todo-7-add-caching.json`

## Testing

```bash
node test.js
```

## Files

```
schemas/
  quality-gate-output.schema.json     JSON Schema contract
scripts/
  validate_quality_gate.py            Python validator
  validate_quality_gate_node.js       Node.js fallback validator
hooks/
  pre-commit-quality-gate.sh          Git hook script
instructions/
  claude.md.tpl                       CLAUDE.md fragment
  agents.md.tpl                       AGENTS.md fragment (Codex)
  gemini.md.tpl                       GEMINI.md fragment
workflows/
  quality-gate.yml                    GitHub Action template
install.js                            Multi-target installer
test.js                               Test suite
```
