import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import collect_metadata
import compare as audit


def cell(agent="light", task="01-chunked-strict", repeat=1, **updates):
    phase = "candidate-c16" if agent == "light" else "baseline"
    sample = {"model": "deepseek-flash", "thinking": {"type": "enabled"},
              "reasoning_effort": "high", "max_tokens": 8192, "temperature": None, "top_p": None}
    row = {"id": f"{phase}-deepseek-flash-{task}-{agent}-r{repeat}", "phase": phase,
           "agent": agent, "model": "deepseek-flash", "task": task, "repeat": repeat,
           "agent_revision": audit.CANDIDATE_SHA if agent == "light" else "0.73.1",
           "pass": True, "check_pass": True, "exit_code": 0, "timeout": False, "budget_stop": False,
           "usage_complete": True, "input_tokens": 100, "cached_tokens": 40, "uncached_tokens": 60,
           "output_tokens": 10, "wall_seconds": 5, "model_calls": 1, "tool_calls": 1,
           "prompt_sha256": "a" * 64, "harness_sha256": "b" * 64, "configuration_sha256": "c" * 64,
           "sampling": sample, "wire_calls": 1, "capture_errors": [],
           "provenance": {"provider": "deepseek", "workers": 1, "seed": 7, "max_calls": 45,
                          "reasoning_effort": "high", "output_cap": 8192, "node_version": "v26.5.0",
                          "python_version": "3.11.2", "task_manifest_sha256": "d" * 64,
                          "spend_cap_usd": 10, "balance_floor_usd": 1, "luna_study_call_cap": 100,
                          "harness_files_sha256": {"runner.py": "b" * 64},
                          "configuration_sha256": "c" * 64}}
    row["sampling_signatures"] = [audit.normalized_sampling(row)]
    row.update(updates)
    return row


def report(rows, tasks=("01-chunked-strict",), **kwargs):
    return audit.compare(rows, tasks=tasks, **kwargs)["models"][0]


class ComparisonTests(unittest.TestCase):
    def test_exact_pair_matches_but_one_repeat_never_promoted(self):
        result = report([cell(), cell("pi")])
        self.assertEqual(result["contract_matched_pairs"], 1)
        self.assertFalse(result["broad_improvement_claim_supported"])
        self.assertIn("one_repeat_diagnostic_only", result["blockers"])

    def test_wrong_source_is_retained_and_blocks_matching(self):
        result = report([cell(agent_revision="wrong"), cell("pi")])
        self.assertEqual(result["arms"]["candidate"]["attempts"], 1)
        self.assertEqual(result["contract_matched_pairs"], 0)

    def test_missing_source_does_not_equal_missing_source(self):
        a, b = cell(agent_revision=None), cell("pi", agent_revision=None)
        self.assertEqual(report([a, b])["contract_matched_pairs"], 0)

    def test_prompt_mismatch_blocks(self):
        result = report([cell(prompt_sha256="e" * 64), cell("pi")])
        self.assertIn("prompt_sha256:mismatch", result["pairs"][0]["contract_issues"])

    def test_missing_sampling_on_both_sides_blocks(self):
        self.assertEqual(report([cell(sampling=None), cell("pi", sampling=None)])["contract_matched_pairs"], 0)

    def test_first_sampling_does_not_prove_all_call_sampling(self):
        result = report([cell(sampling_signatures=None), cell("pi")])
        self.assertIn("candidate:missing_all_call_sampling_evidence", result["pairs"][0]["contract_issues"])

    def test_later_sampling_change_blocks(self):
        a = cell()
        a["sampling_signatures"].append({**a["sampling_signatures"][0], "reasoning_effort": "low"})
        self.assertEqual(report([a, cell("pi")])["contract_matched_pairs"], 0)

    def test_reasoning_summary_is_not_discarded(self):
        a, b = cell(), cell("pi")
        a["sampling"]["reasoning"] = {"effort": "high", "summary": "auto"}
        a["sampling_signatures"] = [audit.normalized_sampling(a)]
        self.assertIn("sampling:mismatch", report([a, b])["pairs"][0]["contract_issues"])

    def test_output_aliases_and_nulls_are_normalized(self):
        a, b = cell(), cell("pi")
        a["sampling"]["max_output_tokens"] = a["sampling"].pop("max_tokens")
        a["sampling"]["max_completion_tokens"] = None
        self.assertEqual(report([a, b])["contract_matched_pairs"], 1)

    def test_conflicting_output_caps_rejected(self):
        a = cell()
        a["sampling"]["max_output_tokens"] = 4096
        self.assertIsNone(audit.normalized_sampling(a))

    def test_worker_difference_is_proven_recorded_setting_change(self):
        a = cell()
        a["provenance"]["workers"] = 2
        pair = report([a, cell("pi")])["pairs"][0]
        self.assertIn("workers:mismatch", pair["contract_issues"])
        self.assertIn("workers", pair["contract_review"]["recorded_execution_setting_differences"])

    def test_missing_worker_is_missing_evidence_not_proven_setting_change(self):
        a = cell()
        del a["provenance"]["workers"]
        pair = report([a, cell("pi")])["pairs"][0]
        self.assertIn("candidate:missing_workers", pair["contract_issues"])
        self.assertNotIn("workers:mismatch", pair["contract_issues"])
        self.assertNotIn("workers", pair["contract_review"]["recorded_execution_setting_differences"])

    def test_null_settings_are_unknown_not_proven_execution_differences(self):
        for name in ("workers", "spend_cap_usd", "luna_study_call_cap"):
            with self.subTest(name=name):
                a = cell()
                a["provenance"][name] = None
                pair = report([a, cell("pi")])["pairs"][0]
                self.assertIn("candidate:missing_" + name, pair["contract_issues"])
                self.assertNotIn(name + ":mismatch", pair["contract_issues"])
                self.assertNotIn(name, pair["contract_review"]["recorded_execution_setting_differences"])

    def test_diagnostic_intervals_never_override_contract_block(self):
        tasks = ("01-chunked-strict", "02-split-limit")
        rows = [r for task in tasks for r in (cell(task=task, wall_seconds=1, harness_sha256="f" * 64), cell("pi", task=task))]
        result = report(rows, tasks=tasks)
        self.assertIsNone(result["paired_task_cluster_metrics"]["wall_seconds"]["ci95"])
        self.assertEqual(result["identity_matched_diagnostic_metrics"]["metrics"]["wall_seconds"]["ci95"], [-4, -4])
        self.assertFalse(result["identity_matched_diagnostic_metrics"]["eligible_for_acceptance"])
        self.assertFalse(result["broad_improvement_claim_supported"])

    def test_test_file_change_blocks_until_explicit_compatibility_review(self):
        a, b = cell(), cell("pi")
        a["provenance"]["harness_files_sha256"]["test_runner.py"] = "e" * 64
        pair = report([a, b])["pairs"][0]
        self.assertFalse(pair["contract_matched"])
        self.assertEqual(pair["contract_review"]["test_named_changes_requiring_execution_path_review"], ["test_runner.py"])
        self.assertEqual(pair["contract_review"]["recorded_execution_setting_differences"], [])

    def test_configuration_digest_may_differ_for_arm_selection(self):
        a = cell(configuration_sha256="f" * 64)
        a["provenance"]["configuration_sha256"] = "f" * 64
        self.assertEqual(report([a, cell("pi")])["contract_matched_pairs"], 1)

    def test_inconsistent_configuration_digest_blocks(self):
        self.assertEqual(report([cell(configuration_sha256="f" * 64), cell("pi")])["contract_matched_pairs"], 0)

    def test_duplicate_does_not_overwrite_failure(self):
        result = report([cell(), cell(**{"pass": False}), cell("pi")])
        self.assertEqual(result["identity_pairs"], 0)
        self.assertEqual(result["arms"]["candidate"]["effective_original_outcomes"]["failed"], 1)
        self.assertTrue(result["duplicate_cells"]["candidate"])
        self.assertEqual(result["claim_status"], "blocked_by_observed_completion_loss")

    def test_failed_runs_remain_in_tokens_wall_and_quality(self):
        a = cell(**{"pass": False, "wall_seconds": 20, "output_tokens": 100})
        result = report([a, cell("pi")])
        self.assertEqual(result["arms"]["candidate"]["metrics"]["raw_tokens"]["sum"], 200)
        self.assertEqual(result["arms"]["candidate"]["metrics"]["wall_seconds"]["p90"], 20)
        self.assertEqual(result["observed_lost_completion_tasks"], [a["task"]])

    def test_unknown_usage_is_not_zero_and_blocks_cluster_estimate(self):
        a = cell(usage_complete=False, input_tokens=0, cached_tokens=0, uncached_tokens=0, output_tokens=0)
        result = report([a, cell("pi")])
        metric = result["arms"]["candidate"]["metrics"]["raw_tokens"]
        self.assertEqual(metric["observed_sum"], 0)
        self.assertIsNone(metric["sum"])
        self.assertIsNone(result["paired_task_cluster_metrics"]["raw_tokens"]["mean_task_delta"])
        self.assertEqual(result["arms"]["candidate"]["effective_original_outcomes"]["passed"], 1)

    def test_bad_usage_accounting_and_nan_are_unknown(self):
        self.assertIsNone(audit.metric_value(cell(cached_tokens=101), "raw_tokens"))
        self.assertIsNone(audit.metric_value(cell(wall_seconds=float("nan")), "wall_seconds"))
        self.assertIsNone(audit.metric_value(cell(input_tokens=True), "input_tokens"))

    def test_timeout_recorded_pass_kept_but_effective_false(self):
        result = audit.aggregate([cell(timeout=True)])
        self.assertEqual(result["recorded_outcomes"]["passed"], 1)
        self.assertEqual(result["effective_original_outcomes"]["failed"], 1)

    def test_guard_stop_after_artifact_pass_remains_failed_with_paid_usage(self):
        row = cell(**{"pass": False, "check_pass": True, "exit_code": 1,
                      "budget_stop": True, "stop_reason": "unexpected_model_settings",
                      "input_tokens": 62707, "cached_tokens": 51518, "uncached_tokens": 11189,
                      "output_tokens": 2675})
        result = audit.compare([row, cell("pi")], tasks=(row["task"],))
        model = result["models"][0]
        self.assertEqual(model["claim_status"], "blocked_by_observed_completion_loss")
        self.assertEqual(model["arms"]["candidate"]["metrics"]["uncached_plus_output_tokens"]["sum"], 13864)
        retained = next(r for r in result["selected_cells"] if r["arm"] == "candidate")
        self.assertTrue(retained["check_pass"])
        self.assertFalse(retained["effective_original_pass"])
        self.assertEqual(retained["stop_reason"], "unexpected_model_settings")

    def test_unknown_original_does_not_fallback_to_rescore(self):
        row = cell(recorded_pass=None, symmetric_pass=True)
        self.assertIsNone(audit.original(row))
        self.assertIsNone(audit.completion(row))

    def test_task12_keeps_three_outcomes_and_excludes_planning_perf_comparison(self):
        task = "12-partition-map"
        a = cell(task=task, coding_pass=True, symmetric_pass=True, **{"pass": False})
        b = cell("pi", task=task, coding_pass=True, symmetric_pass=False)
        result = report([a, b], tasks=(task,))
        self.assertEqual(result["original_comparable_pairs"], 0)
        self.assertEqual(result["code_only_comparable_pairs"], 1)
        self.assertEqual(result["paired_task_cluster_metrics"]["raw_tokens"]["pairs"], 0)
        self.assertEqual(result["arms"]["candidate"]["effective_original_outcomes"]["failed"], 1)
        self.assertEqual(result["arms"]["candidate"]["code_only_outcomes"]["passed"], 1)
        self.assertEqual(result["observed_lost_completion_tasks"], [])

    def test_check_pass_is_never_inferred_code_only(self):
        self.assertIsNone(audit.completion(cell(), True))
        self.assertEqual(audit.aggregate([cell()])["code_only_outcomes"]["unknown"], 1)

    def test_unfinished_attempt_is_unknown_and_retained(self):
        result = report([cell(_unfinished=True), cell("pi")])
        self.assertEqual(result["arms"]["candidate"]["effective_original_outcomes"]["unknown"], 1)
        self.assertEqual(result["arms"]["candidate"]["attempts"], 1)

    def test_missing_baseline_cells_are_explicit(self):
        result = report([cell()])
        self.assertEqual(result["missing_cells"]["baseline"], [{"task": "01-chunked-strict", "repeat": 1}])

    def test_unselected_repeat_visible(self):
        result = audit.compare([cell(), cell("pi"), cell("pi", repeat=2)], tasks=("01-chunked-strict",))
        self.assertEqual(len(result["unselected_repeat_ids"]["baseline"]), 1)

    def test_no_interval_equivalence_claim(self):
        pairs = [(cell(task="01-chunked-strict", wall_seconds=4), cell("pi", task="01-chunked-strict")),
                 (cell(task="02-split-limit", wall_seconds=6), cell("pi", task="02-split-limit"))]
        result = audit.cluster_interval(pairs, "wall_seconds", samples=1000)
        self.assertEqual(result["interpretation"], "inconclusive")
        self.assertEqual(result["reason"], "interval_includes_zero")

    def test_cluster_weights_tasks_not_repeats(self):
        pairs = [(cell(task="01-chunked-strict", repeat=i, wall_seconds=6), cell("pi", task="01-chunked-strict", repeat=i)) for i in range(1, 10)]
        pairs.append((cell(task="02-split-limit", wall_seconds=2), cell("pi", task="02-split-limit")))
        result = audit.cluster_interval(pairs, "wall_seconds", samples=1000)
        self.assertEqual(result["mean_task_delta"], -1)
        self.assertEqual(result["tasks_with_known_values"], 2)

    def test_one_task_has_no_misleading_degenerate_ci(self):
        result = audit.cluster_interval([(cell(wall_seconds=2), cell("pi"))], "wall_seconds")
        self.assertIsNone(result["ci95"])
        self.assertEqual(result["interpretation"], "inconclusive")

    def test_uncached_plus_output_is_reported(self):
        self.assertEqual(audit.metric_value(cell(), "uncached_plus_output_tokens"), 70)

    def test_missing_categories_are_explicit(self):
        self.assertFalse(audit.aggregate([cell()])["call_categories"]["complete"])
        self.assertEqual(audit.aggregate([cell()])["call_categories"]["missing_attempts"], 1)

    def test_original_rows_not_mutated(self):
        rows = [cell(), cell("pi")]
        before = copy.deepcopy(rows)
        report(rows)
        self.assertEqual(rows, before)

    def test_duplicate_selection_rejected(self):
        with self.assertRaises(ValueError):
            audit.compare([], repeats=(1, 1))


class CollectorTests(unittest.TestCase):
    def test_separate_candidate_phases_are_collected_without_pi_substitution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for phase, agent in (("candidate-c16", "light"), ("candidate-api-takeoverruntime", "light"),
                                 ("candidate-api-takeoverruntime", "pi")):
                identity = f"{phase}-deepseek-flash-01-chunked-strict-{agent}-r1"
                (root / identity).mkdir()
            result = collect_metadata.collect(root, ["candidate-c16", "candidate-api-takeoverruntime"], ["deepseek-flash"])
            self.assertEqual(len(result["runs"]), 2)
            self.assertTrue(all(r["agent"] == "light" for r in result["runs"]))

    def test_allowlist_no_prompt_response_or_secret_export_and_no_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = cell()
            run = root / row["id"]
            run.mkdir()
            raw = json.dumps({**row, "secret_unused_field": "do-not-export"})
            (run / "result.json").write_text(raw)
            (run / "wire-001.json").write_text(json.dumps({"body": {**row["sampling"], "messages": [{"content": "private-prompt"}]}}))
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in run.iterdir()}
            result = collect_metadata.collect(root, ["candidate-c16"], ["deepseek-flash"])
            encoded = json.dumps(result)
            self.assertNotIn("do-not-export", encoded)
            self.assertNotIn("private-prompt", encoded)
            self.assertTrue(result["snapshot_complete"])
            self.assertEqual(result["runs"][0]["sampling_signatures"], row["sampling_signatures"])
            self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in run.iterdir()})

    def test_orphan_and_malformed_attempts_remain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            one, two = cell(), cell(task="02-split-limit")
            (root / one["id"]).mkdir()
            (root / two["id"]).mkdir()
            (root / two["id"] / "result.json").write_text("{")
            result = collect_metadata.collect(root, ["candidate-c16"], ["deepseek-flash"])
            self.assertEqual(len(result["runs"]), 2)
            self.assertFalse(result["snapshot_complete"])
            self.assertEqual(sum(r.get("_unfinished", False) for r in result["runs"]), 1)
            self.assertEqual(sum(r.get("_malformed", False) for r in result["runs"]), 1)

    def test_missing_wire_settings_not_silently_accepted(self):
        with self.assertRaises(ValueError):
            collect_metadata.sampling({"model": "deepseek-flash"})

    def test_credential_pattern_in_allowlisted_field_rejected(self):
        with self.assertRaises(ValueError):
            collect_metadata.primitive("sk-" + "a" * 40)


if __name__ == "__main__":
    unittest.main()
