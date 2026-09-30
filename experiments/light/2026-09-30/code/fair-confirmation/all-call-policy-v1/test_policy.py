import copy
import hashlib
import json
import unittest

from policy import check_request, MAX_REQUEST_BYTES, MAX_POLICY_BYTES, MAX_DEPTH, MAX_NODES


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()


# Authored declarations, independent of request bodies and implementation tables.
LUNA = {"model": "gpt-6-luna", "stream": True, "store": False,
        "max_output_tokens": 8192, "reasoning": {"effort": "low", "summary": "auto"},
        "include": ["reasoning.encrypted_content"]}
FLASH = {"model": "deepseek-flash", "stream": True, "max_tokens": 8192,
         "reasoning_effort": "high", "thinking": {"type": "enabled"},
         "stream_options": {"include_usage": True}}


def fixture(luna=True, client="light", optional=None):
    # No production helper generates an expected policy from a request.
    controls = copy.deepcopy(LUNA if luna else FLASH)
    controls.update(optional or {})
    policy = {"schema_version": 1, "profile": "fixed-luna-v1" if luna else "fixed-flash-v1",
              "route": "openai-direct" if luna else "deepseek-proxy", "client": client, "controls": controls}
    body = copy.deepcopy(controls)
    body["input" if luna else "messages"] = [{"role": "user", "content": "Synthetic task"}]
    if luna and client == "light":
        body["instructions"] = "Synthetic instructions"
    return policy, body


def check(policy, body, ordinal=1, raw=None, policy_raw=None, **overrides):
    policy_raw = encoded(policy) if policy_raw is None else policy_raw
    args = {"request_bytes": encoded(body) if raw is None else raw, "policy_bytes": policy_raw,
            "expected_policy_sha256": hashlib.sha256(policy_raw).hexdigest(),
            "route": policy["route"], "client": policy["client"], "call_ordinal": ordinal}
    args.update(overrides)
    return check_request(**args)


class PolicyTests(unittest.TestCase):
    def assert_refused(self, result, reason=None):
        self.assertIs(result["policy_verified"], False)
        self.assertIsInstance(result["reason"], str)
        if reason:
            self.assertEqual(result["reason"], reason)
        self.assertEqual(set(result), {"policy_verified", "reason", "request_sha256", "policy_sha256"})

    def test_four_route_client_combinations_every_call(self):
        for luna in (True, False):
            for client in ("light", "pi"):
                p, b = fixture(luna, client)
                original = encoded(b)
                for ordinal in (1, 2, 45, 1000):
                    result = check(p, b, ordinal)
                    self.assertIs(result["policy_verified"], True)
                    self.assertIsNone(result["reason"])
                    self.assertEqual(result["request_sha256"], hashlib.sha256(original).hexdigest())
                self.assertEqual(encoded(b), original)

    def test_changing_history_tools_and_instructions_not_hashed_as_fixed_envelope(self):
        for luna in (True, False):
            p, b = fixture(luna)
            first = check(p, b)
            b["input" if luna else "messages"].append({"role": "assistant", "content": "Synthetic answer", "tool_calls": []})
            b["tools"] = [{"type": "function", "function": {"name": "Synthetic", "parameters": {"type": "object"}}}]
            if luna:
                b["instructions"] = "Updated synthetic instructions"
            later = check(p, b, 2)
            self.assertTrue(later["policy_verified"])
            self.assertEqual(first["policy_sha256"], later["policy_sha256"])
            self.assertNotEqual(first["request_sha256"], later["request_sha256"])

    def test_all_later_cap_mutations_refused(self):
        for luna in (True, False):
            for value in (None, True, False, 8191, 8193, 8192.0, "8192", 0):
                p, b = fixture(luna)
                b["max_output_tokens" if luna else "max_tokens"] = value
                self.assert_refused(check(p, b, 2), "request_policy_mismatch")
            p, b = fixture(luna)
            del b["max_output_tokens" if luna else "max_tokens"]
            self.assert_refused(check(p, b, 2), "request_policy_mismatch")

    def test_every_required_field_missing_or_null_refused_later(self):
        for luna in (True, False):
            p, original = fixture(luna)
            for key in p["controls"]:
                for remove in (False, True):
                    b = copy.deepcopy(original)
                    if remove:
                        del b[key]
                    else:
                        b[key] = None
                    self.assert_refused(check(p, b, 3))

    def test_effort_summary_include_thinking_stream_model_later(self):
        mutations = [
            (True, "reasoning", {"effort": "medium", "summary": "auto"}),
            (True, "reasoning", {"effort": "low", "summary": "concise"}),
            (True, "reasoning", {"effort": "low", "summary": "auto", "budget": 1}),
            (True, "include", []), (True, "include", ["reasoning.encrypted_content", "other"]),
            (True, "include", ["reasoning.encrypted_content"] * 2),
            (False, "reasoning_effort", "low"), (False, "thinking", {"type": "disabled"}),
            (False, "thinking", {"type": "enabled", "budget_tokens": 8192}),
            (False, "stream_options", {"include_usage": False}),
        ] + [(route, field, value) for route in (True, False)
             for field, value in (("stream", False), ("stream", 1), ("model", "other-model"))]
        for luna, field, value in mutations:
            p, b = fixture(luna)
            b[field] = value
            self.assert_refused(check(p, b, 2))

    def test_unknown_controls_no_extension_wildcard(self):
        for luna in (True, False):
            for key in ("temperature", "top_p", "metadata", "prompt", "context", "previous_response_id",
                        "conversation", "service_tier", "extra_body", "response_format", "seed", "n", "stop"):
                p, b = fixture(luna)
                b[key] = None
                self.assert_refused(check(p, b, 9), "unreviewed_request_field")

    def test_optional_controls_exact_presence_and_value(self):
        p, b = fixture(optional={"prompt_cache_key": "trusted-cell-key", "tool_choice": "auto", "parallel_tool_calls": True})
        self.assertTrue(check(p, b, 2)["policy_verified"])
        for key in ("prompt_cache_key", "tool_choice", "parallel_tool_calls"):
            for value in (None, False, "changed"):
                changed = copy.deepcopy(b)
                changed[key] = value
                self.assert_refused(check(p, changed, 2))
            changed = copy.deepcopy(b)
            del changed[key]
            self.assert_refused(check(p, changed, 2))
        absent_policy, absent_body = fixture()
        absent_body["prompt_cache_key"] = "trusted-cell-key"
        self.assert_refused(check(absent_policy, absent_body, 2), "unreviewed_request_field")

    def test_policy_cannot_authorize_unsupported_values_or_controls(self):
        for key, value in (("max_output_tokens", 999999), ("reasoning", {"effort": "high", "summary": "auto"}),
                           ("store", True), ("stream", 1), ("temperature", None), ("extra_body", {})):
            p, b = fixture()
            p["controls"][key] = value
            b[key] = value
            self.assert_refused(check(p, b))
        p, b = fixture(client="pi", optional={"parallel_tool_calls": True})
        self.assert_refused(check(p, b), "unsupported_policy_controls")
        p, b = fixture(False, optional={"tool_choice": "required"})
        self.assert_refused(check(p, b), "unsupported_policy_values")

    def test_policy_pin_route_client_and_ordinal(self):
        p, b = fixture()
        for kwargs in ({"expected_policy_sha256": "0" * 64}, {"route": "deepseek-proxy"},
                       {"client": "pi"}, {"client": []}, {"route": None}):
            self.assert_refused(check(p, b, **kwargs))
        for value in (None, True, 0, -1, 1.0, "2", 1001):
            self.assert_refused(check(p, b, value), "call_ordinal")

    def test_strict_json_entire_tree_and_policy(self):
        p, b = fixture()
        bad = [b'{"model":"a","model":"b"}', b'{"m\\u006fdel":1,"model":2}',
               b'{"extra":NaN}', b'{"extra":Infinity}', b'{"extra":1e999}',
               b'{"input":[{"content":"\\ud800"}]}', b'{"tools":[{"\\udfff":1}]}',
               b'{"extra":"\xff"}', b'\xef\xbb\xbf{}', b'{} trailing', b'[1]', b'{']
        for raw in bad:
            self.assert_refused(check(p, b, raw=raw))
            self.assert_refused(check(p, b, policy_raw=raw))
        b["input"][0]["content"] = "Valid scalar \U0001f642"
        self.assertTrue(check(p, b)["policy_verified"])

    def test_bounds_and_invalid_containers(self):
        p, b = fixture()
        self.assert_refused(check(p, b, raw=b" " * (MAX_REQUEST_BYTES + 1)), "byte_limit")
        self.assert_refused(check(p, b, policy_raw=b" " * (MAX_POLICY_BYTES + 1)), "byte_limit")
        self.assert_refused(check(p, b, raw=b'{"x":' + b'[' * (MAX_DEPTH + 1) + b'0' + b']' * (MAX_DEPTH + 1) + b'}'), "structure_limit")
        self.assert_refused(check(p, b, raw=encoded({"x": [None] * MAX_NODES})), "structure_limit")
        for field, value in (("input", None), ("input", []), ("tools", None), ("instructions", None)):
            changed = copy.deepcopy(b)
            changed[field] = value
            self.assert_refused(check(p, changed))
        self.assert_refused(check(p, b, request_bytes="not bytes"), "bytes_required")

    def test_verdict_does_not_export_data_or_unknown_field_names(self):
        p, b = fixture()
        secret = "SYNTHETIC_PRIVATE_SENTINEL"
        b["input"][0]["content"] = secret
        b["tools"] = [{"arguments": secret}]
        self.assertNotIn(secret, json.dumps(check(p, b, 2)))
        b[secret] = secret
        self.assert_refused(check(p, b, 2), "unreviewed_request_field")
        self.assertNotIn(secret, json.dumps(check(p, b, 2)))

    def test_no_first_call_bypass_or_mutable_state(self):
        p, b = fixture()
        for ordinal in (1, 2, 3):
            bad = copy.deepcopy(b)
            bad["reasoning"]["effort"] = "medium"
            self.assert_refused(check(p, bad, ordinal))
            self.assertTrue(check(p, b, ordinal)["policy_verified"])


if __name__ == "__main__":
    unittest.main()
