#!/usr/bin/env python3
"""
Validates agent quality gate output against the JSON schema + business rules.
Returns exit code 0 on pass, 1 on fail — usable as a CI gate or git hook.

Usage:
    python scripts/validate_quality_gate.py path/to/plan.json
    cat plan.json | python scripts/validate_quality_gate.py
"""

import json
import sys
from pathlib import Path

try:
    from jsonschema import Draft7Validator
except ImportError:
    print(
        "ERROR: jsonschema not installed. Run: pip install jsonschema",
        file=sys.stderr,
    )
    sys.exit(2)


SCHEMA_PATH = Path(__file__).parent.parent / "schemas" / "quality-gate-output.schema.json"


# ── Business rules (beyond what JSON Schema can enforce) ─────

BUSINESS_RULES = [
    {
        "name": "blocked_verdict_requires_reason",
        "check": lambda d: d["verdict"] != "blocked" or bool(d.get("block_reason", "").strip()),
        "message": "Verdict is 'blocked' but block_reason is empty.",
    },
    {
        "name": "no_empty_security_risks",
        "check": lambda d: all(len(r.strip()) > 5 for r in d["security_review"]["risks"]),
        "message": "Security risks contain empty or trivially short entries (>5 chars required).",
    },
    {
        "name": "canonical_names_present",
        "check": lambda d: bool(d["refined_plan"].get("canonical_names")),
        "message": "Refined plan is missing canonical_names mapping.",
    },
    {
        "name": "all_acceptance_testable",
        "check": lambda d: all(ac.get("testable") is True for ac in d["acceptance_criteria"]),
        "message": "All acceptance criteria must have testable: true.",
    },
    {
        "name": "minimum_acceptance_criteria",
        "check": lambda d: len(d["acceptance_criteria"]) >= 3,
        "message": "Need at least 3 acceptance criteria for a production plan.",
    },
    {
        "name": "source_reference_real_id",
        "check": lambda d: (
            len(d["source_reference"]["id"].strip()) > 0
            and d["source_reference"]["id"].strip().upper() != "TBD"
        ),
        "message": "source_reference.id is empty or 'TBD'. Must reference a real issue/task.",
    },
    {
        "name": "definition_of_done_not_generic",
        "check": lambda d: not any(
            item.lower().strip() == "all tests pass" for item in d["definition_of_done"]
        ),
        "message": "definition_of_done contains generic entries like 'all tests pass'. Be specific.",
    },
    {
        "name": "non_goals_are_specific",
        "check": lambda d: all(len(ng.strip()) > 5 for ng in d["refined_plan"]["non_goals"]),
        "message": "non_goals contain empty or trivially short entries.",
    },
    {
        "name": "failure_modes_have_recovery",
        "check": lambda d: all(
            len(fm["recovery"].strip()) > 5 for fm in d["failure_modes"]
        ),
        "message": "All failure modes must have a specific recovery strategy.",
    },
]


def validate_output(data: dict) -> list[str]:
    """Validate against JSON schema + business rules. Returns list of errors."""
    errors: list[str] = []

    # 1. Load and validate against JSON Schema
    try:
        schema = json.loads(SCHEMA_PATH.read_text())
    except FileNotFoundError:
        errors.append(f"SCHEMA: Schema file not found at {SCHEMA_PATH}")
        return errors
    except json.JSONDecodeError as e:
        errors.append(f"SCHEMA: Invalid schema file — {e}")
        return errors

    validator = Draft7Validator(schema)
    for error in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        path = ".".join(str(p) for p in error.absolute_path) or "(root)"
        errors.append(f"SCHEMA: {path} — {error.message}")

    # 2. Business rules (only if schema is valid enough to inspect)
    if not errors:
        for rule in BUSINESS_RULES:
            try:
                if not rule["check"](data):
                    errors.append(f"RULE [{rule['name']}]: {rule['message']}")
            except (KeyError, TypeError, IndexError) as e:
                errors.append(f"RULE [{rule['name']}]: Check failed — {e}")

    return errors


def main() -> None:
    # Read from file arg or stdin
    if len(sys.argv) > 1:
        filepath = Path(sys.argv[1])
        if not filepath.exists():
            print(f"ERROR: File not found: {filepath}", file=sys.stderr)
            sys.exit(1)
        raw = filepath.read_text()
        label = str(filepath)
    else:
        raw = sys.stdin.read()
        label = "stdin"

    # Parse JSON
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"FAIL [{label}]: Invalid JSON — {e}", file=sys.stderr)
        sys.exit(1)

    # Validate
    errors = validate_output(data)

    if errors:
        print(f"FAIL [{label}] — {len(errors)} violation(s):\n", file=sys.stderr)
        for err in errors:
            print(f"  * {err}", file=sys.stderr)
        sys.exit(1)
    else:
        verdict = data.get("verdict", "unknown")
        print(f"PASS [{label}] — verdict: {verdict}")
        if verdict == "needs_refinement":
            gaps = len(data.get("gaps_found", []))
            print(f"  Needs refinement — {gaps} gap(s) identified.")
        sys.exit(0)


if __name__ == "__main__":
    main()
