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

### How to comply (Anvil)

Mechanical enforcement is available via `.anvil/middleware/contracts_middleware.py` (installed by `hooks/contracts/install.js`). The middleware intercepts destructive tool calls and commit messages the same way the Claude PreToolUse hook does.

For judgment sections:

1. Before non-trivial implementation, verify your approach against relevant sections.
2. When the middleware blocks a tool call citing `CONTRACT §N`, read that section rather than retrying.
3. When declining or proposing alternatives, cite the section that motivates the decision.
<!-- contracts-end -->
