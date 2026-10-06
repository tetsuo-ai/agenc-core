"""The Harbor agent-phase budget, as AgenC's ``--deadline`` (#2503).

Harbor kills an installed agent when its ``run()`` exceeds the trial's agent
timeout (``harbor/trial/trial.py``: ``_run_agent_phase`` wraps ``run()`` in
``asyncio.wait_for``), but never tells the agent what that timeout is. Two
Terminal-Bench trials lost everything to it: one had a passing solution hours
before the cutoff and was killed mid-optimization with a broken file on disk.

This module recomputes the timeout the same way Harbor 0.23 does
(``_compute_agent_timeout_sec``)::

    min(agent.override_timeout_sec or task.toml [agent] timeout_sec,
        agent.max_timeout_sec or inf)
      * (agent_timeout_multiplier if set else timeout_multiplier, default 1)

from the trial's ``config.json`` (written by Harbor before the agent runs,
next to the agent's ``logs_dir``) and the task's ``task.toml``, and turns it
into a ``--deadline +<seconds>`` flag with a margin for the rollout copy that
runs after the turn. It has no Harbor import so it is testable with the
system Python.
"""

from __future__ import annotations

import json
import math
import tomllib
from pathlib import Path

# Room after the deadline for AgenC's own backstop (20 s + 10 s), the rollout
# copy in the adapter's ``finally``, and process start-up.
DEFAULT_DEADLINE_MARGIN_SEC = 120.0
# A deadline shorter than this leaves no useful work time; floor it instead.
MIN_DEADLINE_SEC = 60


def _positive(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def _task_timeout_sec(task_path: object, trial_dir: Path) -> float | None:
    if not isinstance(task_path, str) or not task_path:
        return None
    task_dir = Path(task_path)
    if not task_dir.is_absolute():
        task_dir = trial_dir / task_dir
    try:
        task = tomllib.loads((task_dir / "task.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    agent = task.get("agent")
    return _positive(agent.get("timeout_sec")) if isinstance(agent, dict) else None


def resolve_agent_budget_sec(trial_dir: Path) -> float | None:
    """The agent-phase timeout Harbor will enforce for this trial, or None."""
    try:
        config = json.loads((trial_dir / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(config, dict):
        return None
    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    task = config.get("task") if isinstance(config.get("task"), dict) else {}
    base = _positive(agent.get("override_timeout_sec")) or _task_timeout_sec(
        task.get("path"), trial_dir
    )
    if base is None:
        return None
    cap = _positive(agent.get("max_timeout_sec")) or math.inf
    multiplier = config.get("agent_timeout_multiplier")
    if multiplier is None:
        multiplier = config.get("timeout_multiplier", 1.0)
    scale = _positive(multiplier)
    if scale is None:
        return None
    return min(base, cap) * scale


def deadline_flag(
    budget_sec: float | None,
    margin_sec: float = DEFAULT_DEADLINE_MARGIN_SEC,
) -> str:
    """``--deadline +<seconds>`` for a budget, or "" when there is none."""
    if budget_sec is None or not math.isfinite(budget_sec) or budget_sec <= 0:
        return ""
    seconds = max(MIN_DEADLINE_SEC, int(budget_sec - max(0.0, margin_sec)))
    return f"--deadline +{seconds}"
