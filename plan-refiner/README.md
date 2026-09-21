# plan-refiner

Deterministic plan quality gate hook for Claude Code, Anvil, Codex, and Gemini. Blocks plan submission until the plan has been refined through a senior engineering checklist.

## How it works

1. Agent writes a plan file in plan mode
2. Agent tries to submit the plan (ExitPlanMode / approve_plan)
3. Hook reads the plan, checks for `refined_once: true` in YAML frontmatter
4. If not refined: **blocks submission**, injects the full refiner checklist + current plan content
5. Agent refines the plan, adds the stamp, resubmits
6. Hook sees stamp, **allows submission**

### Loop prevention

Two mechanisms prevent infinite refinement loops:

- **Frontmatter stamp**: `refined_once: true` in the plan's YAML frontmatter
- **Marker file**: `.refined/{plan-name}.refined` as a filesystem lock

If either exists, the hook exits immediately.

## Installation

### Interactive wizard

```bash
cd plan-refiner
node install.js
```

### Specific agents

```bash
node install.js --agent=claude,anvil
```

### All detected agents

```bash
node install.js --all
```

### Uninstall

```bash
node install.js --uninstall
```

## Per-agent strategy

| Agent | Mechanism | How it blocks |
|-------|-----------|---------------|
| **Claude Code** | PreToolUse hook on `ExitPlanMode` | `permissionDecision: 'deny'` with refiner prompt |
| **Anvil** | Middleware `on_tool_call` | Returns error string to short-circuit tool |
| **Codex** | AGENTS.md instruction | Agent-enforced (instruction, not deterministic) |
| **Gemini** | GEMINI.md instruction | Agent-enforced (instruction, not deterministic) |

### Claude Code (deterministic)

The hook intercepts `ExitPlanMode` via the PreToolUse lifecycle. When the plan lacks a refinement stamp, it returns `deny` with the full refiner checklist and the current plan content. Claude sees this as a tool denial and must refine before resubmitting.

### Anvil (deterministic)

The middleware intercepts plan submission tools via `on_tool_call`. Returns a blocking string that short-circuits the tool, forcing the agent to refine first.

### Codex / Gemini (instruction-based)

These agents lack native hook mechanisms. Instead, an instruction block is injected into their project-level files (AGENTS.md / GEMINI.md) directing them to self-refine before submitting.

## The refiner checklist

See [`refiner-prompt.md`](refiner-prompt.md) for the full checklist. It covers:

- Objective, scope, non-goals
- Canonical names
- Security and compliance
- Failure modes and edge cases
- Acceptance criteria
- Testing plan
- Definition of done

## Frontmatter stamp format

```yaml
---
refined_once: true
refined_at: 2026-05-01T12:00:00.000Z
refined_by: claude-code
---
```

## Testing

```bash
node test.js
```

## Files

```
SKILL.md                        skills-cli metadata
package.json                    npm metadata
install.js                      Multi-agent installer wizard
plan-refiner-hook.js            Claude Code PreToolUse hook
plan-refiner-middleware.py      Anvil middleware
refiner-prompt.md               Shared refiner checklist
test.js                         Unit tests (23 tests)
instructions/
  agents.md.tpl                 Codex instruction template
  gemini.md.tpl                 Gemini instruction template
```
