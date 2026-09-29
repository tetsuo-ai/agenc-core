"""Offline harness tests. Mock API responses are never benchmark evidence."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("live_eval", HERE / "live-eval.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class GraderTests(unittest.TestCase):
    def test_known_answers_and_scheduler(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.self_test(types.SimpleNamespace(suite=HERE / "live-eval-tasks.json")), 0)

    def test_structure_and_boolean_equality(self):
        cases = [('{"x":1}', {"x": 1}, True), ('```json\n{"x":1}\n```', {"x": 1}, True),
                 ('prefix {"x":1}', {"x": 1}, True), ('{"x":true}', {"x": 1}, False),
                 ('{"x":1,"y":2}', {"x": 1}, False), ('{"x":[2,1]}', {"x": [1, 2]}, False),
                 ('{"x":NaN}', {"x": 1}, False), ('{"x":1}{"x":1}', {"x": 1}, False)]
        for text, expected, passed in cases:
            with self.subTest(text=text):
                self.assertEqual(runner.grade(text, expected)["passed"], passed)

    def test_usage_missing_cache_and_reasoning(self):
        self.assertIsNone(runner.usage_cost("deepseek-v4-pro", {}))
        self.assertIsNone(runner.usage_cost("deepseek-v4-pro", {
            "prompt_tokens": 10, "completion_tokens": 10, "prompt_cache_hit_tokens": 11}))
        self.assertIsNone(runner.usage_cost("deepseek-v4-pro", {
            "prompt_tokens": 10, "completion_tokens": 10, "prompt_cache_hit_tokens": 5, "prompt_cache_miss_tokens": 9}))
        self.assertEqual(runner.usage_cost("deepseek-v4-pro", {
            "prompt_tokens": 1000, "completion_tokens": 1000, "reasoning_tokens": 900}), 0.00528)
        self.assertEqual(runner.normalize_usage({"prompt_tokens": True, "completion_tokens": -1}), {})


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="live-eval-unit-", dir=HERE)
        self.folder = pathlib.Path(self.temp.name) / "mock-run"
        self.args = types.SimpleNamespace(suite=HERE / "live-eval-tasks.json", output=self.folder,
            max_output_tokens=8192, max_calls=24, budget_usd="3", job_start_balance="50.44",
            timeout_seconds=180, effort="high", exclusive_account=True)
        self.tasks = runner.load_suite(self.args.suite)[0]["tasks"]
        self.calls = []
        owner = self

        class MockClient:
            def __init__(self, key, timeout):
                owner.assertEqual(key, "unit-test-placeholder")

            def balance(self):
                return {"is_available": True, "total_balance": "50.44"}

            def request(self, path, payload):
                owner.assertEqual(path, "/chat/completions")
                owner.assertEqual(payload["max_tokens"], 8192)
                owner.assertEqual(set(payload), {"model", "messages", "max_tokens", "stream", "thinking", "reasoning_effort"})
                prompt = payload["messages"][-1]["content"]
                task = next(task for task in owner.tasks if task["prompt"] == prompt)
                owner.calls.append((task["id"], payload["model"]))
                return {"choices": [{"message": {"content": json.dumps(task["expected"])}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 100, "completion_tokens": 20}}

        self.client = MockClient

    def tearDown(self):
        # Only this test's own temporary directory is removed.
        self.temp.cleanup()

    def execute(self, client=None):
        with patch.object(runner.platform, "system", return_value="Linux"), \
             patch.object(runner.os, "environ", {"DEEPSEEK_API_KEY": "unit-test-placeholder"}), \
             patch.object(runner, "DeepSeek", client or self.client), \
             contextlib.redirect_stdout(io.StringIO()):
            return runner.run(self.args)

    def manifest(self):
        return json.loads((self.folder / "manifest.json").read_text())

    def test_identical_tasks_split_and_alternating_models(self):
        self.assertEqual(self.execute(), 0)
        self.assertEqual(len(self.calls), 24)
        for index, task in enumerate(self.tasks):
            self.assertEqual([task_id for task_id, _ in self.calls[index * 2:index * 2 + 2]], [task["id"], task["id"]])
            expected = list(runner.MODELS if index % 2 == 0 else reversed(runner.MODELS))
            self.assertEqual([model for _, model in self.calls[index * 2:index * 2 + 2]], expected)
        self.assertEqual(self.manifest()["callsRecorded"], 24)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.replay_export(types.SimpleNamespace(run=self.folder)), 0)
        fixture = json.loads((self.folder / "recorded-measurements.json").read_text())
        self.assertEqual(len(fixture["tasks"]), 6)
        self.assertTrue(all(task["id"].startswith("hold-") for task in fixture["tasks"]))

    def test_budget_denial_prevents_paid_request(self):
        self.args.budget_usd = "0.01"
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.manifest()["stopReason"], "spend_guard")

    def test_total_job_cap_prevents_paid_request(self):
        self.args.job_start_balance = "70.44"
        self.assertEqual(self.execute(), 2)
        self.assertEqual(self.calls, [])

    def test_timeout_keeps_full_reservation_and_unknown_cost(self):
        class TimeoutClient(self.client):
            def request(self, path, payload):
                raise runner.SafeFailure("timeout")
        self.args.max_calls = 1
        self.assertEqual(self.execute(TimeoutClient), 2)
        manifest = self.manifest()
        self.assertGreater(manifest["conservativeReservedCostUsd"], 0)
        record = json.loads((self.folder / "records.jsonl").read_text())
        self.assertEqual(record["error"], "timeout")
        self.assertIsNone(record["usageCostUsdAtPeakRates"])
        self.assertFalse(record["grade"]["passed"])

    def test_interruption_keeps_inflight_reservation(self):
        class InterruptClient(self.client):
            def request(self, path, payload):
                raise KeyboardInterrupt()
        self.assertEqual(self.execute(InterruptClient), 2)
        self.assertGreater(self.manifest()["conservativeReservedCostUsd"], 0)
        self.assertEqual(self.manifest()["callsRecorded"], 0)
        self.assertEqual(self.manifest()["stopReason"], "interrupted_inflight_reservation_retained")

    def test_existing_folder_refuses_duplicate_paid_run(self):
        self.folder.mkdir()
        with self.assertRaisesRegex(runner.SafeFailure, "output_already_exists"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_mac_guard_precedes_key_lookup(self):
        class ForbiddenEnvironment:
            def get(self, *args):
                raise AssertionError("Mac must not read credentials")
        with patch.object(runner.platform, "system", return_value="Darwin"), \
             patch.object(runner.os, "environ", ForbiddenEnvironment()):
            with self.assertRaisesRegex(runner.SafeFailure, "network_run_requires_linux"):
                runner.run(self.args)

    def test_regrading_refuses_tampered_expected_answer(self):
        self.execute()
        suite_path = self.folder / "suite.json"
        suite = json.loads(suite_path.read_text())
        suite["tasks"][0]["expected"] = {"ids": []}
        suite_path.write_text(json.dumps(suite))
        with self.assertRaisesRegex(runner.SafeFailure, "snapshot_mismatch"):
            runner.replay_export(types.SimpleNamespace(run=self.folder))


if __name__ == "__main__":
    unittest.main()
