<!-- contracts-start -->
## Engineering Contract

This project follows the engineering contract at `~/_CODING/hooks/contracts/engineering-contract.md`. Read it before non-trivial work.

The contract is authoritative and cross-agent (Claude, Codex, Gemini, Anvil). It contains numbered sections (§1..§N). Cite by section number when explaining decisions or flagging violations.

### Current sections

- **§1** — DRY / No Hardcoding
- **§2** — Simplify; Elegance Is a Tiebreaker
- **§3** — Root Cause Over Symptom
- **§4** — Measure Twice, Cut Once
- **§5** — Validate Only at Boundaries
- **§6** — No AI Attribution
- **§7** — Reversibility Gate
- **§8** — Documentation in Code
- **§9** — Orchestrator Posture
- **§10** — Specialization Routing

### How to comply (Codex)

Codex has no native mechanical hook system, so compliance is self-enforced:

1. Before non-trivial implementation, verify your approach against relevant sections.
2. Before proposing a bypass (`--no-verify`, disabling a test, silencing a linter), diagnose the root cause — that is a §3 obligation.
3. Before destructive operations, confirm with the operator or produce a backup — that is §7.
4. Never add AI-authorship attribution to commits, PRs, issues, or comments — §6, no exceptions.
5. When declining or proposing alternatives, cite the section that motivates the decision.
<!-- contracts-end -->
