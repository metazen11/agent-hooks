<!-- quality-gate-start -->
## MANDATORY: Engineering Quality Gate

Before implementing ANY plan, issue, or task:

1. Read the issue/plan completely.
2. Produce valid JSON matching `schemas/quality-gate-output.schema.json`.
3. Write output to `plans/{source}-{id}-{slug}.json` (e.g. `plans/gh-142-auth-refactor.json`).
4. Self-validate: `python scripts/validate_quality_gate.py plans/{file}.json`
   (or `node scripts/validate_quality_gate_node.js plans/{file}.json` if Python is unavailable)
5. If validation fails, fix the JSON and re-validate until passing.
6. Do NOT begin implementation until the gate passes.
7. If verdict is "blocked", stop and report why.

Required fields: verdict, source_reference, summary, gaps_found, refined_plan,
acceptance_criteria, testing_plan, security_review, compliance_review,
edge_cases, failure_modes, observability, deployment, definition_of_done,
documentation, improvements.
<!-- quality-gate-end -->
