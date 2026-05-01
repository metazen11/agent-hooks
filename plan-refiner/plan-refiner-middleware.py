"""
plan-refiner-middleware.py — Anvil middleware for plan refinement quality gate.

Intercepts plan submission tool calls and blocks them until the plan
has a `refined_once: true` frontmatter stamp or a .refined/ marker file.

Usage:
    # Register via create_agent()
    from plan_refiner_middleware import PlanRefinerMiddleware
    cfg = create_agent(workspace=".", middleware=[PlanRefinerMiddleware()])

    # Or add to defaults.py:
    from plan_refiner_middleware import PlanRefinerMiddleware
    # ... append PlanRefinerMiddleware() to default_stack()
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from anvil.middleware.base import Middleware, RunState
except ImportError:
    # Standalone fallback — allow import without Anvil installed
    class RunState:  # type: ignore[no-redef]
        workspace: str = "."
        extra: dict = {}

    class Middleware:  # type: ignore[no-redef]
        name: str = ""
        order: int = 500
        enabled: bool = True

        def on_tool_call(self, state: Any, tool_name: str, tool_args: dict) -> Any:
            return None


# ── Constants ────────────────────────────────────────────────

REFINER_PROMPT_PATH = Path(__file__).parent / "refiner-prompt.md"

PLAN_SUBMISSION_TOOLS = {
    "ExitPlanMode",           # Claude Code
    "exit_plan_mode",         # Snake-case variant
    "approve_plan",           # Anvil
    "submit_plan",            # Generic
}

PLAN_DIR_PATTERNS = [
    ".claude/plans",
    "plans",
    ".anvil",
]


# ── Helpers ──────────────────────────────────────────────────

def parse_frontmatter(content: str) -> dict[str, Any]:
    """Parse YAML-like frontmatter from markdown content."""
    match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return {}

    fm: dict[str, Any] = {}
    for line in match.group(1).split("\n"):
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip().strip("\"'")
        if val == "true":
            fm[key] = True
        elif val == "false":
            fm[key] = False
        else:
            fm[key] = val
    return fm


def has_refinement_stamp(plan_path: Path) -> bool:
    """Check if a plan file has been refined (frontmatter or marker file)."""
    try:
        content = plan_path.read_text()
    except OSError:
        return False

    # Check frontmatter
    fm = parse_frontmatter(content)
    if fm.get("refined_once") is True:
        return True

    # Check marker file
    marker_dir = plan_path.parent / ".refined"
    marker_file = marker_dir / f"{plan_path.stem}.refined"
    return marker_file.exists()


def find_active_plan(workspace: str) -> Optional[Path]:
    """Find the most recently modified plan file."""
    ws = Path(workspace)

    for pattern in PLAN_DIR_PATTERNS:
        plan_dir = ws / pattern
        if not plan_dir.is_dir():
            continue

        md_files = sorted(
            [f for f in plan_dir.glob("*.md") if not f.name.startswith(".")],
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
        if md_files:
            return md_files[0]

    # Check Anvil active_plan.json
    active_plan_json = ws / ".anvil" / "active_plan.json"
    if active_plan_json.exists():
        try:
            data = json.loads(active_plan_json.read_text())
            plan_path = Path(data.get("path", ""))
            if plan_path.exists():
                return plan_path
        except (json.JSONDecodeError, OSError):
            pass

    return None


def load_refiner_prompt() -> Optional[str]:
    """Load the refiner checklist prompt."""
    try:
        return REFINER_PROMPT_PATH.read_text().strip()
    except OSError:
        return None


# ── Middleware ────────────────────────────────────────────────

class PlanRefinerMiddleware(Middleware):
    """
    Blocks plan submission until the plan has a refinement stamp.

    When a plan submission tool is called and the active plan lacks
    `refined_once: true` frontmatter, returns an error string with
    the refiner checklist, which short-circuits tool execution.
    """

    name = "PlanRefinerMiddleware"
    order = 250  # After memory (100), before display (400)

    def _is_plan_submission(self, tool_name: str, tool_args: dict) -> bool:
        """Check if this tool call is a plan submission."""
        return tool_name in PLAN_SUBMISSION_TOOLS

    def on_tool_call(
        self,
        state: RunState,
        tool_name: str,
        tool_args: dict,
    ) -> Optional[str]:
        """Intercept plan submission and block if not refined."""
        if not self._is_plan_submission(tool_name, tool_args):
            return None

        workspace = getattr(state, "workspace", ".")
        plan_path = find_active_plan(workspace)

        if not plan_path:
            return None  # No plan file — allow

        content = plan_path.read_text().strip()
        if not content:
            return None  # Empty plan — allow

        if has_refinement_stamp(plan_path):
            return None  # Already refined — allow

        # Load refiner prompt
        prompt = load_refiner_prompt()
        if not prompt:
            return None  # Prompt missing — fail-open

        now = datetime.now(timezone.utc).isoformat()

        return (
            "BLOCKED: Plan must be refined before submission.\n"
            "\n"
            f"{prompt}\n"
            "\n"
            "═══════════════════════════════════════════════════════\n"
            "\n"
            f"Plan file: {plan_path}\n"
            "\n"
            "Current plan content:\n"
            "───────────────────────────────────────────────────────\n"
            f"{content}\n"
            "───────────────────────────────────────────────────────\n"
            "\n"
            "Instructions:\n"
            "1. Review the plan above against the quality gate checklist\n"
            "2. Refine the plan\n"
            "3. Add this frontmatter at the top of the plan file:\n"
            "   ---\n"
            "   refined_once: true\n"
            f"   refined_at: {now}\n"
            "   refined_by: anvil\n"
            "   ---\n"
            "4. Submit the plan again\n"
        )
