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

# Seconds between ``--deadline`` and the trial's agent timeout. The published
# 84.5% run (Harbor Hub job 2bf2c84d) passed AgenC the instant of its own stop,
# 2 s before the timeout, so that is the default. AgenC keeps its own reserve
# inside the deadline for the wrap-up.
DEFAULT_DEADLINE_MARGIN_SEC = 2.0
# A deadline shorter than this leaves no useful work time; floor it instead.
MIN_DEADLINE_SEC = 60


def _positive(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def _task_dir(task: dict, trial_dir: Path) -> Path | None:
    """Where the trial's task.toml lives.

    A local task names its ``path``. A registry task (``-d
    terminal-bench/terminal-bench-2-1``) names only ``org/name`` and a sha256
    ``ref``; Harbor unpacks it into its package cache, at the place
    ``PackageTaskId.get_local_path`` computes. Harbor's own resolver is used
    when it is importable, the same computation otherwise.
    """
    path = task.get("path")
    if isinstance(path, str) and path:
        task_dir = Path(path)
        return task_dir if task_dir.is_absolute() else trial_dir / task_dir
    try:
        from harbor.models.trial.config import TaskConfig

        return Path(TaskConfig.model_validate(task).get_local_path())
    except Exception:
        pass
    name, ref = task.get("name"), task.get("ref")
    if (
        isinstance(name, str)
        and name.count("/") == 1
        and isinstance(ref, str)
        and ref.startswith("sha256:")
    ):
        org, short = name.split("/")
        packages = Path("~/.cache/harbor/tasks/packages").expanduser()
        return packages / org / short / ref.removeprefix("sha256:")
    return None


def _task_timeout_sec(task: dict, trial_dir: Path) -> float | None:
    task_dir = _task_dir(task, trial_dir)
    if task_dir is None:
        return None
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
        task, trial_dir
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
