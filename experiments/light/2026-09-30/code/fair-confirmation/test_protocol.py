import copy
import hashlib
import json
from pathlib import Path
import unittest

from protocol import resolve_manifest, score_cell, visible_plan_score

HERE = Path(__file__).resolve().parent
PROPOSAL = json.loads((HERE / "proposed-manifest-v2.json").read_text())
PLAN = "- [ ] Implement the function and public exports.\n- [ ] Add documentation and run regression tests.\n"


def capture(events, **changes):
    result = {"schema_version": 1, "complete": True, "stream_order_preserved": True,
              "adapter_sha256": "a" * 64,
              "events": [dict(event, seq=index, message_id=event.get("message_id", "first"))
                         for index, event in enumerate(events, 1)]}
    result.update(changes)
    return result


def text(value):
    return {"kind": "assistant_text_delta", "text": value}


def grade(value):
    return visible_plan_score(value)["visible_plan_format_pass"]


class PlanEvidenceTests(unittest.TestCase):
    def test_stream_fragments_before_tool(self):
        data = capture([text(PLAN[:17]), text(PLAN[17:]), {"kind": "tool_call_start"}])
        self.assertTrue(grade(data))

    def test_hidden_reasoning_does_not_satisfy_plan(self):
        self.assertFalse(grade(capture([
            {"kind": "assistant_reasoning_delta", "text": PLAN}, {"kind": "tool_call_start"}])))

    def test_plan_after_tool_is_too_late(self):
        self.assertFalse(grade(capture([{"kind": "tool_call_start"}, text(PLAN)])))

    def test_incomplete_item_before_tool_not_repaired_by_later_text(self):
        self.assertFalse(grade(capture([text("- [ ] implement\n- [ ]"), {"kind": "tool_call_start"},
                                       text(" validate\n"), {"kind": "assistant_message_end"}])))

    def test_final_checklist_line_need_not_end_in_newline(self):
        self.assertTrue(grade(capture([text(PLAN.rstrip()), {"kind": "tool_call_start"}])))

    def test_ended_text_response_can_omit_final_newline(self):
        self.assertTrue(grade(capture([text(PLAN.rstrip()), {"kind": "assistant_message_end"}])))

    def test_later_response_cannot_supply_missing_first_plan(self):
        self.assertFalse(grade(capture([text("Let me inspect."), {"kind": "assistant_message_end"},
                                       dict(text(PLAN), message_id="second") ])))

    def test_plan_tool_alone_is_not_visible_text(self):
        self.assertFalse(grade(capture([{"kind": "tool_call_start", "name": "TodoWrite"}])))

    def test_incomplete_capture_is_unknown(self):
        self.assertIsNone(grade(capture([text(PLAN)], complete=False)))

    def test_final_json_without_stream_order_is_unknown(self):
        self.assertIsNone(grade(capture([text(PLAN)], stream_order_preserved=False)))

    def test_missing_adapter_identity_is_unknown(self):
        self.assertIsNone(grade(capture([text(PLAN)], adapter_sha256=None)))

    def test_gapped_capture_is_unknown(self):
        data = capture([text(PLAN)])
        data["events"][0]["seq"] = 2
        self.assertIsNone(grade(data))

    def test_user_or_tool_output_cannot_supply_plan(self):
        for kind in ("user_text", "tool_output", "replayed_assistant_text"):
            self.assertIsNone(grade(capture([{"kind": kind, "text": PLAN}])))

    def test_leading_prose_or_code_fence_is_not_prefix_checklist(self):
        for prefix in ("I will proceed.\n", "```text\n"):
            self.assertFalse(grade(capture([text(prefix + PLAN)])))

    def test_bounds_and_empty_items(self):
        for body in ("- [ ] one\n", "- [ ] \n- [ ] two\n", "- [ ] item\n" * 6):
            self.assertFalse(grade(capture([text(body)])))

    def test_both_agents_use_identical_rules(self):
        for agent in ("pi", "light"):
            result = visible_plan_score(capture([text(PLAN), {"kind": "tool_call_start"}], agent=agent))
            self.assertTrue(result["visible_plan_format_pass"])
            self.assertIsNone(result["plan_semantic_quality"])

    def test_input_capture_unmodified(self):
        data = capture([text(PLAN)])
        original = copy.deepcopy(data)
        grade(data)
        self.assertEqual(data, original)


class ScoringTests(unittest.TestCase):
    def score(self, **overrides):
        args = dict(code_artifact_pass=True, normal_exit=True, timed_out=False,
                    budget_stopped=False, planning_required=True,
                    plan={"visible_plan_format_pass": True})
        args.update(overrides)
        return score_cell(**args)

    def test_task12_success_has_separate_scores(self):
        result = self.score()
        self.assertTrue(result["code_completion"])
        self.assertTrue(result["requested_format_contract_pass"])
        self.assertIsNone(result["plan_semantic_quality"])

    def test_missing_task12_plan_is_unknown_not_bypass(self):
        result = self.score(plan=None)
        self.assertTrue(result["code_completion"])
        self.assertIsNone(result["requested_format_contract_pass"])

    def test_plan_failure_does_not_erase_code_score(self):
        result = self.score(plan={"visible_plan_format_pass": False})
        self.assertTrue(result["code_completion"])
        self.assertFalse(result["requested_format_contract_pass"])

    def test_timeouts_stops_and_abnormal_exit_fail_completion(self):
        for change in ({"timed_out": True}, {"budget_stopped": True}, {"normal_exit": False}):
            result = self.score(**change)
            self.assertTrue(result["code_artifact_pass"])
            self.assertFalse(result["code_completion"])
            self.assertFalse(result["requested_format_contract_pass"])

    def test_missing_code_check_remains_unknown(self):
        self.assertIsNone(self.score(code_artifact_pass=None)["code_completion"])

    def test_nonplanning_task_does_not_need_plan(self):
        self.assertTrue(self.score(planning_required=False, plan=None)["requested_format_contract_pass"])

    def test_strings_are_not_truthy_passes(self):
        with self.assertRaises(ValueError):
            self.score(code_artifact_pass="true")
        with self.assertRaises(ValueError):
            self.score(plan={"visible_plan_format_pass": "true"})


class ManifestTests(unittest.TestCase):
    def synthetic(self):
        override = PROPOSAL["task12_override"]
        tasks = [{"id": task_id, "prompt": "original task", "repo_sha": "synthetic"}
                 for task_id in PROPOSAL["task_ids"]]
        tasks[-1].update(prompt=override["replace_prefix"] + "CODE REQUIREMENTS UNCHANGED",
                         deferred_capability="checklist", deferred_validation="old unequal rule")
        raw = json.dumps({"schema_version": 1, "tasks": tasks}).encode()
        proposal = copy.deepcopy(PROPOSAL)
        proposal["base"]["manifest_sha256"] = hashlib.sha256(raw).hexdigest()
        return raw, proposal

    def test_only_task12_changes_and_code_suffix_survives(self):
        raw, proposal = self.synthetic()
        result = resolve_manifest(raw, proposal)
        original = json.loads(raw)
        self.assertEqual(result["tasks"][:11], original["tasks"][:11])
        self.assertTrue(result["tasks"][-1]["prompt"].endswith("CODE REQUIREMENTS UNCHANGED"))
        self.assertNotIn("deferred_validation", result["tasks"][-1])
        self.assertNotIn("deferred_capability", result["tasks"][-1])
        self.assertEqual(original["tasks"][-1]["deferred_capability"], "checklist")

    def test_changed_base_is_rejected(self):
        raw, proposal = self.synthetic()
        with self.assertRaises(ValueError):
            resolve_manifest(raw + b" ", proposal)

    def test_missing_duplicate_or_reordered_tasks_rejected(self):
        for mutation in (lambda ts: ts[:-1], lambda ts: ts[:-1] + [ts[0]], lambda ts: list(reversed(ts))):
            raw, proposal = self.synthetic()
            base = json.loads(raw)
            base["tasks"] = mutation(base["tasks"])
            raw = json.dumps(base).encode()
            proposal["base"]["manifest_sha256"] = hashlib.sha256(raw).hexdigest()
            with self.assertRaises(ValueError):
                resolve_manifest(raw, proposal)

    def test_unexpected_original_prompt_prefix_is_rejected(self):
        raw, proposal = self.synthetic()
        proposal["task12_override"]["replace_prefix"] = "unexpected"
        with self.assertRaises(ValueError):
            resolve_manifest(raw, proposal)


if __name__ == "__main__":
    unittest.main()
