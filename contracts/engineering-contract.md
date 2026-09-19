---
name: engineering-contract
version: 1.0.0
status: active
scope: cross-project, cross-agent
parties:
  - authors: [claude, codex, gemini, anvil, operator]
  - enforcers: [pre-tool hooks, pre-commit hook, code-reviewer agent, quality-gate]
  - beneficiaries: [operator, future maintainers, other agents]
citation_format: "CONTRACT §N"
---

# Engineering Contract

Canonical, cross-project, cross-agent rules that govern how code and change get produced in this operator's workspace. Every section is numbered so hooks, reviews, and other agents can cite by reference (e.g. `CONTRACT §1`). Sections are additive; existing numbering is stable — new rules append.

## Reading This Document

- **Obligations** use RFC 2119 language: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY**.
- **Enforcement** is either *mechanical* (a hook can detect a breach) or *judgment* (only a reviewer can decide).
- **Exceptions** are first-class. A rule without documented exceptions is a rule that will be lawyered around.
- **Evidence of Compliance** describes what proves the rule was followed. Reviewers check for this evidence; hooks generate it.
- **Consequences of Breach** describe what happens when the rule is broken. A rule with no consequence is a suggestion.

When two sections conflict, the *more specific* section wins. When still ambiguous, escalate to the operator — do not silently choose.

---

## §1 — DRY / No Hardcoding

**Enforcement:** mechanical + judgment.

### Obligations
- Code **MUST NOT** embed paths, ports, URLs, hostnames, credentials, or unlabeled magic numbers directly in source.
- Values **MUST** be derived from configuration (env vars, config files, constants module) or received as parameters.
- Related values **MUST** reference existing constants rather than re-declaring them.
- Duplicate logic across ≥3 sites **SHOULD** be extracted; ≥5 sites **MUST** be extracted unless each site has genuinely divergent semantics.

### Exceptions
- Test fixtures where the literal value **is** the fixture under test.
- Migration scripts pinning historical values that must not change.
- Single-use throwaway scripts (documented as such in the module header per §8).
- Numbers with no domain meaning: `0`, `1`, `-1`, `2` for pairs, empty string, empty array/object literals.

### Evidence of Compliance
- `checks/s1-no-hardcoding.js` passes on staged files.
- Constants are named and imported, not repeated.
- Configuration surface is documented (per §8) so hardcoded fallbacks are traceable.

### Consequences of Breach
- Pre-tool hook blocks Write/Edit that introduces new hardcoded values matching known patterns.
- Reviewer cites `§1` and requests extraction to config/constants.
- Repeat breaches promote to a memory entry via the improvement loop.

---

## §2 — Simplify; Elegance Is a Tiebreaker

**Enforcement:** judgment.

### Obligations
- Between two working solutions, the author **MUST** choose the one with fewer moving parts, unless the more elegant option has demonstrable maintenance advantages the reviewer can articulate.
- Abstractions **MUST NOT** be introduced for hypothetical future requirements. Three similar lines is preferable to a premature abstraction.
- Features, error handling, fallbacks, and validation **MUST NOT** be added for scenarios that cannot occur given the code's actual callers and inputs.
- Functional style (pure functions, immutable data, composition) **SHOULD** be preferred where it clarifies intent — but not where it obscures a straightforward imperative sequence.

### Exceptions
- Extraction demanded by §1 (DRY) when duplication threshold is crossed.
- Abstractions required by an interface boundary (§5) that is already load-bearing.

### Evidence of Compliance
- Diff introduces no new files, classes, or abstractions that lack a concrete second caller today.
- No `try/except` blocks catching conditions that provably cannot occur.
- No configuration flags for behaviors that have only one setting.

### Consequences of Breach
- Reviewer cites `§2` and requests removal of the premature abstraction.
- If merged, the abstraction becomes a candidate for the next simplification pass.

---

## §3 — Root Cause Over Symptom

**Enforcement:** mechanical + judgment.

### Obligations
- When a check, test, hook, or type-checker fails, the author **MUST** diagnose the underlying cause before attempting to bypass or suppress the signal.
- Bypass mechanisms **MUST NOT** be used to close out work: `git commit --no-verify`, `--no-gpg-sign`, disabled tests, `@ts-ignore`/`@ts-expect-error` without linked issue, bare `except:`, `try/except: pass`, `# noqa` without rule reference, silenced linter rules.
- If a bypass is genuinely necessary (e.g. broken upstream tool blocking unrelated work), the author **MUST** file the underlying issue and reference it in the bypass comment.

### Exceptions
- Emergency operator override (operator explicitly requests bypass, aware of the trade-off).
- Bypassing a check that is itself known-broken, with a linked tracking issue.

### Evidence of Compliance
- `checks/s3-no-symptom-suppression.js` passes on the diff.
- No new suppression comments without an adjacent issue reference.
- Failing tests are fixed or explicitly quarantined with a linked ticket.

### Consequences of Breach
- Pre-tool hook blocks Bash commands matching bypass patterns.
- Reviewer cites `§3` and requests root-cause diagnosis.
- Silent test disablement is treated as a §3 breach even without a hook fire.

---

## §4 — Measure Twice, Cut Once

**Enforcement:** judgment.

### Obligations
- Before non-trivial implementation (>1 file, or affecting shared state), the author **MUST** produce a plan that satisfies the plan-refiner gate.
- Before any destructive or hard-to-reverse operation, the author **MUST** either confirm with the operator or produce a restorable backup (see §7).
- Before proposing a change to a working system, the author **MUST** verify the current behavior — not just infer it from code — when the change depends on that behavior.
- One-sentence intent statement precedes the first tool call of any multi-step task.

### Exceptions
- Trivial single-line fixes with obvious semantics.
- Read-only exploration.

### Evidence of Compliance
- Plan file exists with `refined_once: true` frontmatter for non-trivial tasks.
- Intent statement is present in the transcript before the first mutating tool call.
- For behavior-dependent changes, a verification step (test run, script, curl, etc.) precedes the change.

### Consequences of Breach
- Plan-refiner hook blocks `ExitPlanMode` without refinement.
- Reviewer cites `§4` and requests plan or verification evidence before approving.

---

## §5 — Validate Only at Boundaries

**Enforcement:** judgment.

### Obligations
- Input validation, sanitization, defensive type checks, and null guards **MUST** live at system boundaries: user input, HTTP/RPC endpoints, external API responses, deserialized data from disk or network, plugin/user-supplied callbacks.
- Internal code **MUST** trust its callers within the same trust domain. Redundant validation inside pure internal functions is forbidden.
- Type systems, contracts, and invariants **SHOULD** be relied on to communicate guarantees; runtime checks that duplicate what the type system already enforces are noise.

### Exceptions
- Assertions asserting invariants that would indicate a genuine bug if violated (these document, they don't defend).
- Boundaries between distinct trust domains within the same codebase (e.g., untrusted plugin code calling into trusted core).

### Evidence of Compliance
- New defensive code lives in boundary modules (controllers, deserializers, adapters).
- Internal helpers have no null-guards on parameters that are typed as non-null.
- Duplicate validation between adjacent layers is removed, not added.

### Consequences of Breach
- Reviewer cites `§5` and requests removal of internal defensive code.

---

## §6 — No AI Attribution

**Enforcement:** mechanical.

### Obligations
- Commits, PR titles, PR bodies, PR comments, issue bodies, and issue comments **MUST NOT** contain AI-authorship attribution: `Co-Authored-By: Claude`, `Co-Authored-By: <name>@anthropic.com`, "Generated with Claude Code", "🤖 Generated with", or equivalent phrases from any AI vendor.
- Code files **MUST NOT** contain author-line comments crediting an AI.
- The prohibition applies regardless of who authored the change.

### Exceptions
- None. This is an operator preference expressed as a hard rule.

### Evidence of Compliance
- `checks/s6-no-ai-attribution.js` passes on staged commit messages and file diffs.
- `git log` shows no AI-attribution trailers in operator's repos.

### Consequences of Breach
- Pre-tool hook blocks Bash commands matching AI-attribution patterns in commit messages, PR bodies, and issue text.
- Reviewer cites `§6` and requests amendment.

---

## §7 — Reversibility Gate

**Enforcement:** mechanical + judgment.

### Obligations
- Before running any *destructive* or *hard-to-reverse* operation, the author **MUST** either:
  1. Obtain operator confirmation for this specific action in this specific context, **or**
  2. Produce a restorable backup or snapshot and verify it before proceeding.
- Destructive operations include, non-exhaustively: `rm -rf`, `git reset --hard`, `git push --force`, `git branch -D`, `git checkout -- .`, `DROP TABLE`, `TRUNCATE`, database migrations that drop columns/tables, package downgrades, credential rotations, CI/CD pipeline modifications, and shared-infrastructure changes.
- Operator authorization for one action does **not** authorize the same action in a new context. Scope of authorization matches scope of request.

### Exceptions
- Local, reversible operations on ephemeral working state (e.g., `rm` on generated artifacts already tracked by git).
- Operator has issued a durable, scoped standing authorization documented in a CLAUDE.md or memory entry.

### Evidence of Compliance
- Pre-tool hook fires and finds either a confirmation or a backup step in the recent history.
- For database operations, a `pg_dump` / snapshot precedes the destructive DDL.
- For git rewrites, the pre-rewrite ref is captured (e.g., as a tag).

### Consequences of Breach
- Pre-tool hook blocks the destructive tool call and returns a `deny` with the missing-precondition list.
- Reviewer cites `§7` and requests the backup or authorization evidence.
- If a destructive action ran without evidence and caused loss, the incident promotes to a project memory entry.

---

## §8 — Documentation in Code

**Enforcement:** judgment (mechanical stub optional).

### Obligations
- **Every module** **MUST** open with a docstring or top-of-file comment stating the module's purpose and, if non-obvious, its role in the larger system.
- **Every public function, class, and method** **MUST** have a docstring covering: purpose, parameters, return value, raised errors, side effects, and any non-obvious invariants or preconditions.
- **Every non-trivial type or data structure** (structs, dataclasses, TypedDicts, complex generics) **MUST** have a docstring or adjacent comment explaining shape and meaning.
- **Inline comments** **MUST** be reserved for explaining *why* code does something surprising: workarounds, ordering constraints, subtle invariants, references to specific bugs or ADRs. They **MUST NOT** narrate what obvious code does.
- Documentation **MUST NOT** reference the current task, PR, fix, or session ("added for issue #123", "TODO from today's session"). Such references belong in the PR description, not in the code.
- Dead code **MUST** be deleted, not commented out.

### Rationale
Other agents (Codex, Anvil, future Claude sessions) read code cold. They lack the conversation context the author had while writing it. Docstrings are the API contract; narration is noise. Documenting the *interface* is required; narrating the *implementation* is forbidden.

### Style
- Python: PEP 257 — one-line summary, blank line, details. Use the docstring conventions of the surrounding project (Google, NumPy, or Sphinx).
- JavaScript / TypeScript: JSDoc on exported functions, classes, and types.
- Go: standard godoc conventions (start with the identifier name).
- Other languages: follow language idiom; do not invent house style.

### Exceptions
- Private helpers whose signature and body together are self-evident (typically <5 lines, pure, single call site).
- Test files: describe intent via test names; docstrings are optional but encouraged for test suites and fixtures.
- Trivial one-line accessors and pass-throughs.

### Evidence of Compliance
- Every changed public API has a docstring in the diff.
- No new comments of the form `// increment counter` or `// call the function`.
- No commented-out code blocks in the diff.

### Consequences of Breach
- Reviewer cites `§8` and requests docstring addition or comment removal.
- Optional mechanical check (`checks/s8-docstring-coverage.js`) may flag public exports without docstrings.

---

## §9 — Orchestrator Posture

**Enforcement:** judgment.

### Obligations
- The primary agent (Claude, Codex, Gemini, Anvil) **MUST** treat itself as the *orchestrator* of the operator's request, not the sole executor.
- The orchestrator **MUST** decompose non-trivial work into independent subtasks and delegate them to subagents when subagents are available and the work would benefit from parallelism, isolation, or specialized capability.
- The orchestrator **MUST NOT** perform work in its own context that a subagent could perform equally well — doing so wastes the orchestrator's context window on details that will not be needed for coordination.
- The orchestrator **MUST** retain ownership of: task decomposition, cross-subtask coordination, integration of results, final review, and communication with the operator.
- The orchestrator **MUST NOT** delegate synthesis, judgment, or the final report to a subagent. Understanding is not delegable (§9 corollary: the orchestrator reads and reasons about results; subagents produce them).

### Exceptions
- Trivial single-step tasks where subagent overhead exceeds the work itself (rule of thumb: <3 tool calls, <2 files touched, no independent branches of exploration).
- Tasks that require access to conversation context the subagent cannot receive (subagents start cold).

### Evidence of Compliance
- For multi-step work: subagents were spawned for independent branches
- Orchestrator's own context contains the plan, the results, and the synthesis — not the raw execution details
- Final summary to operator is written by the orchestrator, citing subagent outputs

### Consequences of Breach
- Reviewer cites `§9` and notes context-window waste or serialization that could have been parallel
- Operator may redirect mid-task if they observe the orchestrator executing what should have been delegated

---

## §10 — Specialization Routing

**Enforcement:** judgment.

### Obligations
- When delegating (per §9), the orchestrator **MUST** review the available specialized subagent types and route each subtask to the best-fit specialist.
- The orchestrator **MUST NOT** default to `general-purpose` when a specialized agent covers the subtask domain. Common specializations to check first:
  - Testing / verification → `qa-tester`
  - Code review → `code-reviewer`
  - Security audit → `security-auditor`
  - Security remediation → `security-fixer`
  - Performance investigation → `perf-profiler`
  - Database analysis → `db-analyst`
  - Dependency audit → `dep-auditor`
  - Infrastructure health → `infra-checker`
  - Compliance work → `soc2-auditor`, `hipaa-auditor`, `compliance-fixer`
  - Broad code exploration → `Explore`
  - Implementation planning → `Plan`
  - Skill promotion / continuous improvement → `skill-promoter`
  - Quality gating a plan or issue → `quality-gate`
- `general-purpose` is the **fallback** when no specialist fits — not the default.
- The orchestrator **MUST** state in its prompt to the subagent *why* it chose that specialization when the choice was non-obvious, so operator can audit the routing decision.

### Exceptions
- No specialized agent exists for the subtask domain — fall back to `general-purpose`.
- Multiple specialists could apply and the choice would meaningfully change the output — escalate to the operator rather than choosing silently.

### Evidence of Compliance
- Subagent invocations show `subagent_type` set to a specialist when one applies
- Fallbacks to `general-purpose` are justified in the prompt or transcript

### Consequences of Breach
- Reviewer cites `§10` and notes the missed specialization
- Repeated misses promote to a memory entry mapping subtask patterns to specialists

---

## Adding New Sections

New sections **MUST**:
1. Have a real, repeated failure mode that motivates them (not speculation).
2. Specify Obligations, Exceptions, Evidence of Compliance, and Consequences of Breach.
3. Declare whether enforcement is mechanical, judgment, or both.
4. Append at the next §N; existing numbering is immutable so that citations remain stable.

New sections **MUST NOT** contradict existing sections. If a new rule requires overturning an existing one, amend the existing section explicitly (add a "Superseded by §N" note) rather than creating a silent conflict.

## Amending Existing Sections

Amendments follow the same rules as additions. When a section is materially changed, bump `version` in the frontmatter and note the change in an appended `## Changelog` section at the bottom of this file (created on first amendment).

## Guidelines vs. Contracts

Not every good practice belongs in this contract. If a rule is:
- Not repeatedly violated in practice, **or**
- Not mechanically flaggable **and** not consistently cited in reviews,

it belongs in a separate `guidelines.md` document, not here. Contracts have teeth; guidelines have taste. Keep them distinct.
