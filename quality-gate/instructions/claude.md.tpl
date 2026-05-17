<!-- quality-gate-start -->
## MANDATORY: Engineering Quality Gate

Before implementing ANY plan, issue, or task:

1. Read the issue/plan completely.
2. Produce valid JSON matching `schemas/quality-gate-output.schema.json`.
3. Write output to `plans/{source}-{id}-{slug}.json` (e.g. `plans/gh-142-auth-refactor.json`).
4. Self-validate: `python scripts/validate_quality_gate.py plans/{file}.json`
5. If validation fails, fix the JSON and re-validate until passing.
6. Do NOT begin implementation until the gate passes.
7. If verdict is "blocked", stop and report why.

### Required JSON fields

verdict, source_reference (system, id), summary, gaps_found,
refined_plan (objective, scope, non_goals, canonical_names, steps),
acceptance_criteria (criterion, testable: true), testing_plan (unit, integration, e2e, negative, regression),
security_review (risks, controls), compliance_review, edge_cases, failure_modes,
observability (logs, metrics, alerts, error_messages), deployment (steps, rollback),
definition_of_done, documentation (updates_needed), improvements.

### Rules

- Every acceptance criterion MUST be a testable boolean statement.
- Every failure mode MUST have a recovery strategy.
- canonical_names MUST map logical names to actual file/service/table names.
- Security risks and controls are MANDATORY — missing security = blocked.
- definition_of_done must be specific — no generic "all tests pass".
<!-- quality-gate-end -->
