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

---

# Contracts package — operational notes

*(salvaged from `origin/docs/handoff-post-contracts`, merged 2026-09-20)*

## Status

`contracts/` package built, tested, merged to `main` (PR #1, commit `15eab5c`), and installed on Mac 1.

- Contract: `contracts/engineering-contract.md`, 11 numbered sections cited as `CONTRACT §N`
- Enforcement: 4 mechanical checks (§1, §3, §6, §7) via Claude Code PreToolUse dispatcher; instruction-based for Codex, Gemini, Anvil
- Tests: 51/51 passing (`node contracts/test.js`)
- Auto-update alert: `contracts/update-check.js` runs at SessionStart, banners when `origin/main:contracts` differs from local

## Installing on other machines

**First time** — clone (if needed) and install:

```bash
# Only if repo isn't cloned yet:
git clone https://github.com/metazen11/agent-hooks.git ~/_CODING/hooks

# Install for all detected agents on this machine:
cd ~/_CODING/hooks/contracts && node install.js --all
```

Detects and wires up whichever of Claude Code / Codex / Gemini / Anvil are present.

**Ongoing updates** — one command:

```bash
~/_CODING/hooks/contracts/pull-and-update.sh
```

Or manually: `cd ~/_CODING/hooks && git pull --ff-only origin dev && cd contracts && node install.js --all`

> **Trunk note (2026-09-20):** install from `dev`, not `main`. `dev` is the integration
> trunk and is the only branch that holds every hook package; `main` lacks iron-rules,
> self-update, self-improve and hf-launch-gate until the next dev -> main PR.

**Automatic reminder** — once installed, Claude Code sessions on that machine print an update banner at SessionStart if remote has advanced. Rate-limited to once every 4 hours.

## Machine status

| Machine | Contracts installed | Notes |
|---|---|---|
| Mac 1 (this) | 2026-09-20 | live enforcement verified — §6 blocked test payload, §7 blocked branch delete until explicit auth |
| Mac 2 | pending | run install commands on Monday 2026-09-22 (or whenever) |
| Linux boxes (Anvil) | pending | instruction-only enforcement until Anvil Python middleware is added |

## Known issues / follow-ups

1. ~~**`git-session` worktree bug**~~ — FIXED 2026-09-20 (`4b95c35`).
   `path.join(cwd, gitDir, marker)` at git-session.js:868 failed open inside
   linked worktrees (absolute git-dir), so the MERGE_HEAD check never fired and
   the hook checkpointed mid-merge with conflict markers. Now `path.resolve`.
   Regression test: case 5 in `git-session/test-pre-edit-skips.sh`, verified RED
   against the unfixed hook.

2. **First §6 breach on record** — commit `15eab5c` on `main` contains AI-attribution trailers in its squash-merge commit message. Uncorrectable due to hard-deny on `git push --force-with-lease origin main` in `~/.claude/settings.json` (which is correct §7 enforcement). Grandfathered as the seed lesson; all future commits enforced by the now-live §6 check.

3. **Anvil mechanical enforcement** — currently instruction-only. Adding a Python middleware analogous to `plan-refiner/plan-refiner-middleware.py` would give Anvil deterministic §1/§3/§6/§7 enforcement.

## Force-push deny rules

Each machine's `~/.claude/settings.json` should include hard-deny rules for force-push to `main` / `master`. Verify on a new machine:

```bash
grep force-with-lease ~/.claude/settings.json
```

Should show entries like `"Bash(git push --force-with-lease origin main)"`. If missing, copy from Mac 1.

> **VERIFIED 2026-09-20 — NOT PRESENT on Mac 1.** `grep -c force-with-lease
> ~/.claude/settings.json` returns 0 on this machine, so the deny rules this section
> describes are not actually installed here. Follow-up #2 below assumes they are.
> Treat this section as the intended state, not the current one, until the rules are added.

## Backup / rollback

- `origin/pre-contracts-merge-2026-09-19` tag preserves `main` state before the contracts PR merged
- `origin/session-20260221-final` tag preserves the deleted session branch tip
