# Session Handoff

**Last updated:** 2026-09-20

## Current Task: `iron-rules` package (design agreed, not yet built)

Goal: enforce iron coding rules across Claude Code, Codex, and Anvil via one hook,
with a single machine-readable source of truth and a contract-acknowledgment gate.

### Key findings from last session
- Codex `~/.codex/hooks.json` uses the identical hook protocol as Claude Code
  (same events, stdin/stdout JSON). One Node script serves both.
- Anvil uses a Python middleware stack; plan-refiner already shells out from a thin
  middleware to the Node script. Repeat that pattern generically.
- agent-memory lessons already inject pre-tool and per-turn (self-improvement channel).
- Rules currently drift across 3 places: `~/.claude/skills/autonomous/skill.md`,
  `anvil/coding_principles.md`, and the synced CLAUDE.md pack
  (source: `/Users/mz/_CODING/autonomous_agents_mds/scripts/sync_prompt_pack.py`).

### Design
1. `iron-rules.json` in the autonomous_agents_mds prompt pack (synced like CLAUDE.md).
   Rule fields: id, mode (block|warn|remind), event, match (tool+glob+regex), message.
   Mechanical rules (naming, secrets, file placement) -> block/warn at PreToolUse.
   Judgment rules (DRY, simplicity) -> remind only, routed to code-reviewer agent.
   Render CLAUDE.md / AGENTS.md / coding_principles.md sections from this file.
2. `iron-rules.js` hook: reads stdin, loads rules (+ project `.iron-rules.json`
   overrides), returns deny or systemMessage. Lift naming checks out of `pre-commit`
   into a shared module used at both edit time and commit time.
3. Cadence reminder: UserPromptSubmit rule with per-session turn counter; every N turns
   inject <400-char checkpoint (rules digest, delegate, recall memory, update todo/HANDOFF).
   Stop rule: warn if files changed but todo.json / HANDOFF.md untouched.
4. Contract gate (proof of reading): SessionStart injects "run `iron-rules contract read`".
   That prints the contract + HMAC token (content hash + per-machine secret).
   PreToolUse on Edit/Write/Bash denies until `iron-rules contract ack <token>` recorded
   for (session_id, content hash). Reads/Grep/Glob never blocked. Escape-hatch env var.
5. Self-improvement: agent-memory lesson -> skill-promoter weekly -> PR adding rule to
   iron-rules.json. Human approves PR.

### Build order
1. iron-rules.json schema + render step into the three doc targets
2. iron-rules.js with naming + secrets rules in warn mode (flip to block after a week)
3. Contract gate
4. Turn-counter reminder + Stop docs check
5. Lesson-to-rule promotion routine

Package layout: mirror `plan-refiner/` (install.js multi-agent wizard, instructions/*.tpl,
README.md, SKILL.md, test.js).

## Project State

- Branch: `dev` (integration trunk) — merged `origin/main` PR #1 on 2026-09-20.
- `dev` now holds every hook package: the contract-enforcement set from main
  (`contracts`, `plan-refiner`, `pre-commit-hook`, `quality-gate`) alongside
  dev's own (`iron-rules`, `self-update`, `self-improve`, `hf-launch-gate`).
  Before this merge neither trunk was a superset of the other.

## 2026-07-15 — self-improve hook: fixed idle-spam
Added: hooks/self-improve/ (PostToolUse odometer + Stop nudge for tool-extraction & sprint-close).
BUG caught in the field (DailyDispatch session): Stop nudge re-fired on every idle turn (6x spam),
because it read whole-tree `git status` and never debounced. FIX:
  - Debounce: nudge at most ONCE per session (persist `nudged` flag; stop deleting state on Stop).
  - Activity gate: only nudge if this session ran >=3 MUTATING tools (Edit/Write/NotebookEdit/MultiEdit).
    A conversational/idle turn (0 mutations) stays silent even with pre-existing uncommitted changes.
  - Rule B raised to require >=3 edits so a one-line fix never trips it.
Verified: idle→silent, substantive→fires once, 2nd Stop same session→silent. Global (all repos); safe
now that it's debounced+activity-gated. Wired in ~/.claude/settings.json (PostToolUse + Stop).
