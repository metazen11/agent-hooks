# contracts

Cross-agent engineering contract enforcer for Claude Code, Anvil, Codex, and Gemini. Installs the canonical `engineering-contract.md` and its mechanical checks so every agent working in this operator's workspace obeys the same numbered rules.

## What it does

The contract at [`engineering-contract.md`](engineering-contract.md) is the authoritative rulebook. This package makes the rules operational:

1. **Deterministic enforcement** (Claude Code) — a PreToolUse hook loads every `checks/s*-*.js` module and denies tool calls that violate a mechanical section (§1, §3, §6, §7).
2. **Instruction-based enforcement** (Anvil, Codex, Gemini) — an instruction block is written into each agent's project file (`CONTRACTS.md`, `AGENTS.md`, `GEMINI.md`) telling the agent to read and cite the contract.
3. **Stable citations** — every section is numbered so hooks, reviewers, and other agents can reference them as `CONTRACT §N`.

## The eight sections

| § | Section | Enforcement |
|---|---------|-------------|
| §1 | DRY / No Hardcoding | mechanical + judgment — no embedded paths, ports, URLs, secrets, or magic numbers |
| §2 | Simplify; Elegance Is a Tiebreaker | judgment — fewer moving parts wins; no premature abstraction |
| §3 | Root Cause Over Symptom | mechanical + judgment — no `--no-verify`, `@ts-ignore` orphans, bare `except: pass` |
| §4 | Measure Twice, Cut Once | judgment — plan-refiner gate, verify current behavior before changing it |
| §5 | Validate Only at Boundaries | judgment — validation at trust boundaries; no redundant internal null-guards |
| §6 | No AI Attribution | mechanical — no `Co-Authored-By: Claude`, no "Generated with", no vendor trailers |
| §7 | Reversibility Gate | mechanical + judgment — `rm -rf`, `git reset --hard`, `DROP TABLE` require backup or confirmation |
| §8 | Documentation in Code | judgment — module/public-API docstrings required; no code narration; no dead code |

Full text with obligations, exceptions, evidence, and consequences lives in [`engineering-contract.md`](engineering-contract.md).

## Installation

### Interactive wizard

```bash
cd contracts
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

### Target a specific project

```bash
node install.js --project=~/path/to/repo --all
```

Without `--project`, installation is global: the Claude Code hook is symlinked into `~/.claude/hooks/` and instructions are written to per-agent user files.

### Uninstall

```bash
node install.js --uninstall
```

Removes the hook symlink, deletes the `contracts-hook` entry from `~/.claude/settings.json`, and strips the marker-delimited instruction blocks from each agent's project files.

## Per-agent enforcement

| Agent | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Claude Code** | PreToolUse hook | deterministic — blocks Write/Edit/Bash on §1/§3/§6/§7 violations |
| **Anvil** | Instruction (CONTRACTS.md) | agent-enforced |
| **Codex** | AGENTS.md instruction block | agent-enforced |
| **Gemini** | GEMINI.md instruction block | agent-enforced |

### Claude Code (deterministic)

The PreToolUse hook `contracts-hook.js` intercepts every tool call, loads every `checks/s*-*.js` module, and runs each check's `check(toolName, toolInput)` function. The first check that returns `{ allow: false, reason }` short-circuits the dispatch and Claude receives a `deny` with the section-cited reason.

Fail-open: if the hook itself throws or a check module fails to load, the tool call is allowed and the failure is logged to stderr. A broken enforcer must not block the operator's work.

### Anvil / Codex / Gemini (instruction-based)

These agents lack native hook mechanisms comparable to Claude Code's PreToolUse. Instead, an instruction block is injected into their project-level file — `CONTRACTS.md` for Anvil, `AGENTS.md` for Codex, `GEMINI.md` for Gemini — telling the agent to read and cite `engineering-contract.md`. Enforcement depends on the agent honoring the instruction.

## Citing the contract in reviews and PRs

Every enforcement decision and review comment **MUST** cite by section number so the source of the rule is unambiguous:

```
CONTRACT §1 — this edit hardcodes `~/data/cache`; move to config.
CONTRACT §7 — this DROP TABLE needs a pg_dump first, please confirm.
CONTRACT §6 — please remove the Co-Authored-By trailer before merging.
```

Reviewers, hooks, and other agents all use the same format. Section numbers are stable: existing numbering never changes, new rules append at the next `§N`.

## Adding a new section

Amendments follow the contract's own "Adding New Sections" clause (see the bottom of [`engineering-contract.md`](engineering-contract.md)). A new section **MUST**:

1. Address a real, repeated failure mode (not speculation).
2. Specify Obligations, Exceptions, Evidence of Compliance, Consequences of Breach.
3. Declare whether enforcement is mechanical, judgment, or both.
4. Append at the next `§N`; existing numbering is immutable.

To add a mechanical check for the new section:

1. Add `checks/s<N>-<slug>.js` exporting a `check(toolName, toolInput)` function that returns `{ allow: true }` or `{ allow: false, reason }`. The reason string **SHOULD** start with `CONTRACT §<N> — <Section Name>` and end with a link to the contract anchor.
2. The dispatcher (`contracts-hook.js`) picks up any file matching `/^s\d+.*\.js$/` in `checks/` automatically — no registration needed.
3. Add tests in `test.js` covering the allow path, deny path, and exemptions.

## Auto-update alerts

Two scripts (currently being built in parallel) keep the contract in sync across every project that has it installed:

- **`update-check.js`** — compares the installed contract version against the source repo and warns if the local copy is stale.
- **`pull-and-update.sh`** — pulls the latest contract from the source repo and re-runs `install.js` for every agent that already had it installed.

Run these opportunistically; both are non-destructive and idempotent.

## Testing

```bash
node test.js
```

Covers each check module's allow path, deny path, and exemption logic, plus the dispatcher's fail-open behavior on malformed input.

## Files

```
SKILL.md                          skills-cli metadata
package.json                      npm metadata
README.md                         this file
engineering-contract.md           canonical rulebook (§1..§N)
contracts-hook.js                 Claude Code PreToolUse dispatcher
install.js                        Multi-agent installer wizard
test.js                           Unit tests
checks/
  s1-no-hardcoding.js             §1 mechanical check
  s3-no-symptom-suppression.js    §3 mechanical check
  s6-no-ai-attribution.js         §6 mechanical check
  s7-reversibility-gate.js        §7 mechanical check
instructions/
  claude.md.tpl                   Claude Code instruction template
  anvil.md.tpl                    Anvil instruction template
  agents.md.tpl                   Codex instruction template
  gemini.md.tpl                   Gemini instruction template
```
