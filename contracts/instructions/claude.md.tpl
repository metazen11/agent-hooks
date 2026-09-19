<!-- contracts-start -->
## Engineering Contract

This project is governed by the engineering contract at `~/_CODING/hooks/contracts/engineering-contract.md`. Read it before non-trivial work if you have not already this session.

The contract is authoritative and cross-agent. It contains numbered sections (§1..§N). Cite by section number when explaining decisions, flagging violations, or accepting trade-offs.

### Current sections

- **§1** — DRY / No Hardcoding
- **§2** — Simplify; Elegance Is a Tiebreaker
- **§3** — Root Cause Over Symptom
- **§4** — Measure Twice, Cut Once
- **§5** — Validate Only at Boundaries
- **§6** — No AI Attribution
- **§7** — Reversibility Gate
- **§8** — Documentation in Code
- **§9** — Orchestrator Posture (delegate to subagents; don't execute what can be parallelized)
- **§10** — Specialization Routing (pick the best-fit specialist agent; general-purpose is a fallback)

### How to comply

1. Before non-trivial implementation, verify your approach against relevant sections.
2. When a hook denies a tool call citing `CONTRACT §N`, read that section rather than retrying the same action.
3. When declining a request or proposing an alternative, cite the section that motivates the decision.
4. When an edge case is not covered, escalate to the operator; do not silently choose an interpretation.

Mechanical enforcement runs via `~/.claude/hooks/contracts-hook.js` (installed by `hooks/contracts/install.js`). Judgment sections are enforced in code review.
<!-- contracts-end -->
