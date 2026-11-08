"""ATIF view and usage of AgenC rollouts (system Python, no Harbor needed).

Run: python3 -m unittest discover -s runtime/eval/harbor
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agenc_atif import convert_rows, emit, rollout_usage

AGENT = {
    "name": "agenc",
    "version": "0.19.24",
    "commit": "a" * 40,
    "model_name": "deepseek/deepseek-flash",
    "reasoning_effort": "max",
    "budget": "max",
}


def event(kind: str, payload: dict) -> dict:
    return {"type": "event_msg", "payload": {"msg": {"type": kind, "payload": payload}}}


def item(payload: dict) -> dict:
    return {"type": "response_item", "payload": payload}


ROLLOUT = [
    {"type": "session_meta", "payload": {"id": "conv-1"}},
    item({"role": "developer", "content": "You are AgenC."}),
    item({"role": "user", "content": [{"type": "text", "text": "Fix the repo."}]}),
    item({
        "role": "assistant",
        "content": "Looking.",
        "toolCalls": [{"id": "call-1", "name": "exec_command", "arguments": '{"cmd": "git status"}'}],
    }),
    event("token_count", {"promptTokens": 1000, "completionTokens": 50, "cachedInputTokens": 900}),
    item({"role": "tool", "toolCallId": "call-1", "content": "clean"}),
    item({"role": "tool", "toolCallId": "call-unknown", "content": "orphan"}),
    item({"role": "assistant", "content": "Done."}),
    event("token_count", {"promptTokens": 1200, "completionTokens": 20, "cachedInputTokens": 1100}),
    event("session_usage", {"costUsd": 0.0012}),
    event("session_usage", {"costUsd": 0.0031}),
]


class ConvertRows(unittest.TestCase):
    def test_steps_tool_calls_and_observations(self) -> None:
        doc = convert_rows(ROLLOUT, AGENT, "00001-rollout")
        self.assertEqual(doc["schema_version"], "ATIF-v1.8")
        self.assertEqual(doc["agent"]["name"], "agenc")
        self.assertEqual(doc["agent"]["extra"]["commit"], "a" * 40)
        sources = [step["source"] for step in doc["steps"]]
        self.assertEqual(sources, ["system", "user", "agent", "agent", "agent"])
        call_step = doc["steps"][2]
        self.assertEqual(call_step["tool_calls"][0]["arguments"], {"cmd": "git status"})
        self.assertEqual(call_step["observation"]["results"][0]["content"], "clean")
        self.assertEqual(doc["steps"][3]["extra"]["native_type"], "unmatched_tool_result")
        self.assertEqual(doc["steps"][1]["message"], "Fix the repo.")
        self.assertEqual(call_step["reasoning_effort"], "max")

    def test_bad_arguments_are_kept_raw(self) -> None:
        rows = [item({"role": "assistant", "content": "", "toolCalls": [
            {"id": "c", "name": "write", "arguments": "not json"},
            {"id": "d", "name": "write", "arguments": "[1, 2]"},
        ]})]
        tools = convert_rows(rows, AGENT, "s")["steps"][0]["tool_calls"]
        self.assertEqual(tools[0]["arguments"], {"raw": "not json"})
        self.assertEqual(tools[1]["arguments"], {"raw": [1, 2]})

    def test_no_response_items_means_no_view(self) -> None:
        self.assertIsNone(convert_rows([event("token_count", {})], AGENT, "s"))


class EmitAndUsage(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        rollouts = self.dir / "native-rollouts"
        rollouts.mkdir()
        (rollouts / "00001-main.jsonl").write_text("\n".join(json.dumps(r) for r in ROLLOUT) + "\nnot json\n")
        child = [
            item({"role": "user", "content": "sub task"}),
            item({"role": "assistant", "content": "sub done"}),
            event("token_count", {"promptTokens": 300, "completionTokens": 10}),
            event("session_usage", {"costUsd": 0.0005}),
        ]
        (rollouts / "00002-child.jsonl").write_text("\n".join(json.dumps(r) for r in child) + "\n")

    def test_emit_writes_views_and_the_largest_as_trajectory(self) -> None:
        report = emit(self.dir, AGENT)
        self.assertTrue(report["available"])
        self.assertEqual(report["atif_views"], 2)
        self.assertTrue((self.dir / "native-rollouts" / "00001-main.atif.json").exists())
        self.assertTrue((self.dir / "native-rollouts" / "00002-child.atif.json").exists())
        trajectory = json.loads((self.dir / "trajectory.json").read_text())
        self.assertEqual(trajectory["session_id"], "00001-main")

    def test_usage_sums_calls_and_session_costs(self) -> None:
        usage = rollout_usage(sorted((self.dir / "native-rollouts").glob("*.jsonl")))
        self.assertEqual(usage["calls"], 3)
        self.assertEqual(usage["prompt"], 2500)
        self.assertEqual(usage["completion"], 80)
        self.assertEqual(usage["cached"], 2000)
        self.assertTrue(usage["cost_known"])
        self.assertAlmostEqual(usage["cost_usd"], 0.0036)

    def test_emit_without_rollouts(self) -> None:
        empty = Path(tempfile.mkdtemp())
        (empty / "native-rollouts").mkdir()
        self.assertFalse(emit(empty, AGENT)["available"])
        self.assertFalse(rollout_usage([])["cost_known"])


if __name__ == "__main__":
    unittest.main()
