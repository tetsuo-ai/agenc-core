"""Tests for the Harbor budget -> ``--deadline`` derivation (#2503).

Run with the system Python: ``python3 -m unittest discover -s eval/harbor``.
"""

from __future__ import annotations

import json
import os
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

    def test_registry_task_is_read_from_harbor_package_cache(self) -> None:
        # `-d terminal-bench/terminal-bench-2-1` trials name only org/name and a
        # digest; Harbor unpacks the task under ~/.cache/harbor/tasks/packages.
        home = self.fixture.root / "home"
        digest = "27b074a2f10fff7606e096f3abd8dced418ad8fda0f53d88acbe477f2d9ceaf6"
        task_dir = home / ".cache/harbor/tasks/packages/terminal-bench/log-summary-date-ranges" / digest
        task_dir.mkdir(parents=True)
        (task_dir / "task.toml").write_text("[agent]\ntimeout_sec = 900.0\n")
        config = {"task": {"name": "terminal-bench/log-summary-date-ranges",
                           "ref": "sha256:" + digest,
                           "source": "terminal-bench/terminal-bench-2-1"}}
        (self.fixture.trial / "config.json").write_text(json.dumps(config))
        saved = os.environ.get("HOME")
        os.environ["HOME"] = str(home)
        try:
            self.assertEqual(resolve_agent_budget_sec(self.fixture.trial), 900.0)
        finally:
            if saved is None:
                del os.environ["HOME"]
            else:
                os.environ["HOME"] = saved

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


class FakeResult:
    return_code = 0
    stdout = ""
    stderr = ""


class FakeEnvironment:
    """Records what the adapter runs outside exec_as_agent (daemon stop, rollout copy)."""

    def __init__(self) -> None:
        self.commands: list[str] = []

    async def exec(self, command, **_kwargs):
        self.commands.append(command)
        return FakeResult()


class AdapterCommandTest(unittest.TestCase):
    """The adapter's budget and its agenc command line (needs Harbor)."""

    def setUp(self) -> None:
        try:
            import agenc_agent  # noqa: F401
        except ModuleNotFoundError as error:
            self.skipTest(f"harbor is not installed for this Python: {error}")

    def test_budget_comes_from_the_trial_unless_overridden(self) -> None:
        from agenc_agent import Agenc

        with tempfile.TemporaryDirectory() as tmp:
            fixture = TrialFixture(Path(tmp))
            trial = fixture.write({})
            logs_dir = trial / "agent"
            logs_dir.mkdir()
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6")
            self.assertEqual(agent._budget_sec(), 28800.0)
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6", deadline_sec=600)
            self.assertEqual(agent._budget_sec(), 600)
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6", deadline_sec=0)
            self.assertIsNone(agent._budget_sec())

    def _run(self, **options) -> tuple[str, FakeEnvironment, dict]:
        import asyncio
        from unittest import mock

        from agenc_agent import Agenc
        from harbor.models.agent.context import AgentContext

        with tempfile.TemporaryDirectory() as tmp:
            fixture = TrialFixture(Path(tmp))
            trial = fixture.write({"agent": {"override_timeout_sec": 3600}})
            logs_dir = trial / "agent"
            logs_dir.mkdir()
            agent = Agenc(logs_dir=logs_dir, model_name="grok/grok-4.6", **options)
            agent.agenc_home = "/root/.agenc"
            agent.wrapper = "/root/.local/bin/agenc"
            commands: list[str] = []

            async def capture(_environment, command, **_kwargs):
                commands.append(command)
                return FakeResult()

            async def no_upload(*_args, **_kwargs):
                return None

            environment = FakeEnvironment()
            with mock.patch.dict(os.environ, {"XAI_API_KEY": "test-key"}), mock.patch.object(
                agent, "exec_as_agent", capture
            ), mock.patch.object(agent, "_upload_text", no_upload):
                asyncio.run(agent.run("fix it", environment=environment, context=AgentContext()))
            guard = json.loads((logs_dir / "deadline-guard.json").read_text())
            return next(c for c in commands if " -p " in c), environment, guard

    def test_run_uses_the_published_launch_and_stops_the_daemon(self) -> None:
        command, environment, guard = self._run()
        self.assertIn(
            "/root/.local/bin/agenc -p --budget max --dangerously-bypass-approvals-and-sandbox "
            "--output-format stream-json <",
            command,
        )
        self.assertNotIn("--deadline", command)
        self.assertNotIn("--add-dir", command)
        self.assertTrue(any(c.endswith("agenc daemon stop") for c in environment.commands))
        self.assertEqual(guard["budget_sec"], 3600.0)
        self.assertFalse(guard["timed_out"])
        self.assertEqual(guard["stop_exit_code"], 0)

    def test_cli_deadline_puts_the_flag_on_the_agenc_command(self) -> None:
        command, _environment, _guard = self._run(cli_deadline=True, add_dirs="/")
        self.assertIn("--add-dir / --deadline +3480 <", command)


if __name__ == "__main__":
    unittest.main()
