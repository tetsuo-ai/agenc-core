import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).parent
ROOT = ROOT.parent.parent / "src/llm/providers/claude-subscription"
sys.path.insert(0, str(ROOT / "vendor"))
from directsdk import prepare_history, request_body, CARRIER


class BridgeTests(unittest.TestCase):
    def test_auth_conflict_does_not_print_secret(self):
        result = subprocess.run([sys.executable, str(ROOT / "bridge.py"), "--status"],
                                capture_output=True, text=True,
                                env={**os.environ, "ANTHROPIC_API_KEY": "sentinel-private-value"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("ANTHROPIC_API_KEY", result.stdout)
        self.assertNotIn("sentinel-private-value", result.stdout + result.stderr)

    def test_unmodified_dependency_supports_tool_schema_and_effort(self):
        body, tools, names = request_body({"model": "sonnet", "extra_body": {"reasoning": {"effort": "none"}},
            "tools": [{"type": "function", "function": {"name": "fixture", "parameters": {"type": "object"}}}]})
        self.assertEqual(json.loads(body)["thinking"], {"type": "disabled"})
        self.assertEqual(names, {"fixture"})
        self.assertEqual(tools[0]["inputSchema"]["properties"], {})

    def test_tool_history_is_replayed_as_native_tool_result(self):
        _, frames = prepare_history([
            {"role": "user", "content": "call"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "function": {"name": "fixture", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "nonce"}])
        self.assertEqual(frames[-1]["message"]["content"][0]["type"], "tool_result")
        self.assertEqual(frames[-1]["message"]["content"][0]["tool_use_id"], "t1")

    def test_serial_tool_policy_is_sent_to_the_native_api(self):
        body, _, _ = request_body({"model": "sonnet", "parallel_tool_calls": False,
            "tools": [{"type": "function", "function": {"name": "fixture", "parameters": {"type": "object"}}}]})
        self.assertEqual(json.loads(body)["tool_choice"], {"type": "auto", "disable_parallel_tool_use": True})

    def test_edited_history_never_restores_stale_signed_thinking(self):
        carrier = {"type": CARRIER, "version": 1, "projection": {"content": "old", "tool_calls": []},
                   "messages": [{"role": "assistant", "content": [{"type": "thinking", "thinking": "stale", "signature": "signed"}]}]}
        _, frames = prepare_history([{"role": "assistant", "content": "edited", "reasoning_details": [carrier]}, {"role": "user", "content": "next"}])
        self.assertEqual(frames[0]["message"]["content"], [{"type": "text", "text": "edited"}])


if __name__ == "__main__":
    unittest.main()
