"""Tests for the Harbor budget -> ``--deadline`` derivation (#2503).

Run with the system Python: ``python3 -m unittest discover -s eval/harbor``.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agenc_deadline import (  # noqa: E402
    DEFAULT_DEADLINE_MARGIN_SEC,
    MIN_DEADLINE_SEC,
    deadline_flag,
    resolve_agent_budget_sec,
)


class TrialFixture:
    """A Harbor trial directory: ``config.json`` plus the task's ``task.toml``."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.trial = root / "trial"
        self.task = root / "task"
        self.trial.mkdir()
        self.task.mkdir()

    def write(self, config: dict, task_timeout: float | None = 28800.0) -> Path:
        agent_section = "" if task_timeout is None else f"timeout_sec = {task_timeout}\n"
        (self.task / "task.toml").write_text(f"[agent]\n{agent_section}\n[environment]\n")
        config = {"task": {"path": str(self.task), "source": "terminal-bench"}, **config}
        (self.trial / "config.json").write_text(json.dumps(config))
        return self.trial


class ResolveAgentBudgetTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.fixture = TrialFixture(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_task_timeout_with_defaults(self) -> None:
        # The photonic-waveguide-routing trial: 8 h task timeout, nothing overridden.
        trial = self.fixture.write({"agent_setup_timeout_multiplier": 3.0})
        self.assertEqual(resolve_agent_budget_sec(trial), 28800.0)

    def test_override_replaces_the_task_timeout(self) -> None:
        trial = self.fixture.write({"agent": {"override_timeout_sec": 3600}})
        self.assertEqual(resolve_agent_budget_sec(trial), 3600.0)

    def test_max_caps_the_timeout(self) -> None:
        trial = self.fixture.write({"agent": {"max_timeout_sec": 7200}})
        self.assertEqual(resolve_agent_budget_sec(trial), 7200.0)

    def test_agent_multiplier_wins_over_the_general_one(self) -> None:
        trial = self.fixture.write(
            {"timeout_multiplier": 3.0, "agent_timeout_multiplier": 0.5}
        )
        self.assertEqual(resolve_agent_budget_sec(trial), 14400.0)
        trial = self.fixture.write({"timeout_multiplier": 2.0})
        self.assertEqual(resolve_agent_budget_sec(trial), 57600.0)

    def test_no_timeout_or_unreadable_inputs_mean_no_budget(self) -> None:
        self.assertIsNone(resolve_agent_budget_sec(self.fixture.write({}, task_timeout=None)))
        (self.fixture.task / "task.toml").write_text("not = [valid")
        self.assertIsNone(resolve_agent_budget_sec(self.fixture.trial))
        self.assertIsNone(resolve_agent_budget_sec(self.fixture.root / "missing"))
        (self.fixture.trial / "config.json").write_text("{")
        self.assertIsNone(resolve_agent_budget_sec(self.fixture.trial))


class DeadlineFlagTest(unittest.TestCase):
    def test_subtracts_the_margin(self) -> None:
        self.assertEqual(deadline_flag(28800.0), f"--deadline +{28800 - int(DEFAULT_DEADLINE_MARGIN_SEC)}")
        self.assertEqual(deadline_flag(3600.0, margin_sec=300), "--deadline +3300")

    def test_floors_a_short_budget_and_skips_a_missing_one(self) -> None:
        self.assertEqual(deadline_flag(90.0), f"--deadline +{MIN_DEADLINE_SEC}")
        self.assertEqual(deadline_flag(None), "")
        self.assertEqual(deadline_flag(0), "")
        self.assertEqual(deadline_flag(float("inf")), "")


class AdapterCommandTest(unittest.TestCase):
    """The adapter puts the flag on the ``agenc -p`` command line (needs Harbor)."""

    def test_run_command_carries_the_deadline(self) -> None:
        try:
            import agenc_agent  # noqa: F401
        except ModuleNotFoundError as error:
            self.skipTest(f"harbor is not installed for this Python: {error}")
        from agenc_agent import Agenc

        with tempfile.TemporaryDirectory() as tmp:
            fixture = TrialFixture(Path(tmp))
            trial = fixture.write({})
            logs_dir = trial / "agent"
            logs_dir.mkdir()
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6")
            self.assertEqual(agent._deadline_flag(), "--deadline +28680")
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6", deadline_sec=600)
            self.assertEqual(agent._deadline_flag(), "--deadline +480")
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6", deadline_sec=0)
            self.assertEqual(agent._deadline_flag(), "")

    def test_run_puts_the_deadline_on_the_agenc_command(self) -> None:
        try:
            import agenc_agent  # noqa: F401
        except ModuleNotFoundError as error:
            self.skipTest(f"harbor is not installed for this Python: {error}")
        import asyncio
        import os
        from unittest import mock

        from agenc_agent import Agenc
        from harbor.models.agent.context import AgentContext

        with tempfile.TemporaryDirectory() as tmp:
            fixture = TrialFixture(Path(tmp))
            trial = fixture.write({"agent": {"override_timeout_sec": 3600}})
            logs_dir = trial / "agent"
            logs_dir.mkdir()
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6")
            commands: list[str] = []

            async def capture(_environment, command, **_kwargs):
                commands.append(command)

            with mock.patch.dict(os.environ, {"XAI_API_KEY": "test-key"}), mock.patch.object(
                agent, "exec_as_agent", capture
            ):
                asyncio.run(agent.run("fix it", environment=None, context=AgentContext()))

            run_command = next(command for command in commands if " -p " in command)
            self.assertIn("--deadline +3480 -p", run_command)


if __name__ == "__main__":
    unittest.main()
