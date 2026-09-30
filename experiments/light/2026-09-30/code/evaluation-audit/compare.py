#!/usr/bin/env python3
"""Read-only, fail-closed comparison of explicitly selected Light/Pi evidence.

Reads result metadata only; prints JSON; never rewrites evidence, contacts a
provider, selects the best run, or imputes unavailable outcomes/usage as zero.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics
import sys

TASKS = (
    "01-chunked-strict", "02-split-limit", "03-window-padding", "04-count-by",
    "05-empty-refactor", "06-key-rotation-map", "07-source-manifest",
    "08-integer-encoding", "09-separator-payload", "10-expiry-boundary",
    "11-compression-marker", "12-partition-map",
)
CANDIDATE_SHA = "0638f0267b70a241c3a34c21214ad0659d582bc5"
METRICS = ("input_tokens", "output_tokens", "cached_tokens", "uncached_tokens",
           "raw_tokens", "uncached_plus_output_tokens", "wall_seconds",
           "model_calls", "tool_calls")
TOKEN_METRICS = set(METRICS[:6])
SETTINGS = ("provider", "workers", "seed", "max_calls", "reasoning_effort",
            "output_cap", "node_version", "python_version", "spend_cap_usd",
            "balance_floor_usd", "luna_study_call_cap")
HASH_FIELDS = ("harness_sha256", "prompt_sha256", "configuration_sha256")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def boolean(value):
    return value if type(value) is bool else None


def original(row):
    # An explicit unknown original must not be replaced by a later rescore.
    return boolean(row.get("recorded_pass") if "recorded_pass" in row else row.get("pass"))


def completion(row, code_only=False):
    score = boolean(row.get("coding_pass")) if code_only else original(row)
    if row.get("_unfinished") or row.get("_malformed"):
        return None
    if score is None:
        return None
    if score is False or any(row.get(k) is True for k in
                             ("timeout", "budget_stop", "provider_unavailable")):
        return False
    exit_code = row.get("exit_code")
    if type(exit_code) is not int:
        return None
    if exit_code != 0:
        return False
    if row.get("timeout") is not False:
        return None
    if not code_only:
        check = boolean(row.get("check_pass"))
        if check is not True:
            return check
    return True


def task12(row):
    return str(row.get("task", "")).startswith("12-")


def normalized_sampling(row):
    raw = row.get("sampling")
    if not isinstance(raw, dict) or not raw.get("model"):
        return None
    reason = raw.get("reasoning") or {}
    if not isinstance(reason, dict):
        return None
    caps = [raw[k] for k in ("max_tokens", "max_completion_tokens", "max_output_tokens")
            if raw.get(k) is not None]
    if not caps or len(set(caps)) != 1:
        return None
    effort = reason.get("effort", raw.get("reasoning_effort"))
    if reason.get("effort") is not None and raw.get("reasoning_effort") is not None:
        if reason["effort"] != raw["reasoning_effort"]:
            return None
    return {"model": raw["model"], "output_cap": caps[0], "reasoning_effort": effort,
            "reasoning_options": {k: v for k, v in reason.items() if k != "effort"},
            **{k: raw.get(k) for k in ("thinking", "temperature", "top_p")}}


def metadata_issues(row, revision, label):
    issues = []
    if row.get("agent_revision") != revision:
        issues.append(label + ":source_revision_missing_or_mismatched")
    for name in HASH_FIELDS:
        value = row.get(name)
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            issues.append(label + ":missing_or_invalid_" + name)
    provenance = row.get("provenance") or {}
    if not isinstance(provenance, dict):
        provenance = {}
    for name in SETTINGS + ("task_manifest_sha256", "harness_files_sha256"):
        if provenance.get(name) is None:
            issues.append(label + ":missing_" + name)
    if provenance.get("provider") == "openai" and type(provenance.get("openai_reasoning_replay")) is not bool:
        issues.append(label + ":missing_openai_reasoning_replay")
    if provenance.get("configuration_sha256") != row.get("configuration_sha256"):
        issues.append(label + ":configuration_digest_inconsistent")
    expected_source = provenance.get("candidate_revision" if label == "candidate" else "pi_version")
    if expected_source is not None and expected_source != row.get("agent_revision"):
        issues.append(label + ":provenance_source_inconsistent")
    sample = normalized_sampling(row)
    if sample is None:
        issues.append(label + ":missing_or_invalid_sampling")
    elif sample["model"] != row.get("model"):
        issues.append(label + ":sampling_model_mismatch")
    wire = row.get("sampling_signatures")
    if wire is None:
        issues.append(label + ":missing_all_call_sampling_evidence")
    elif not wire or any(signature != sample for signature in wire):
        issues.append(label + ":sampling_changes_or_wire_mismatch")
    if row.get("wire_calls") != row.get("model_calls") or not numeric(row.get("model_calls")) or row.get("model_calls") == 0:
        issues.append(label + ":wire_call_coverage_mismatch")
    if row.get("capture_errors"):
        issues.append(label + ":capture_errors")
    return issues


def contract_issues(candidate, baseline, candidate_revision, baseline_revision):
    issues = metadata_issues(candidate, candidate_revision, "candidate")
    issues += metadata_issues(baseline, baseline_revision, "baseline")
    for name in ("prompt_sha256", "harness_sha256"):
        if candidate.get(name) is not None and baseline.get(name) is not None and candidate[name] != baseline[name]:
            issues.append(name + ":mismatch")
    a, b = candidate.get("provenance") or {}, baseline.get("provenance") or {}
    for name in SETTINGS + ("task_manifest_sha256", "harness_files_sha256", "openai_reasoning_replay"):
        if a.get(name) is not None and b.get(name) is not None and a[name] != b[name]:
            issues.append(name + ":mismatch")
    if normalized_sampling(candidate) != normalized_sampling(baseline):
        issues.append("sampling:mismatch")
    return sorted(set(issues))


def contract_review(candidate, baseline):
    """A digest difference proves different bytes, not a runtime behavior change."""
    a, b = candidate.get("provenance") or {}, baseline.get("provenance") or {}
    settings = [name for name in SETTINGS + ("openai_reasoning_replay",)
                if a.get(name) is not None and b.get(name) is not None and a[name] != b[name]]
    ma, mb = a.get("harness_files_sha256"), b.get("harness_files_sha256")
    changed = [] if not isinstance(ma, dict) or not isinstance(mb, dict) else sorted(
        name for name in set(ma) | set(mb) if ma.get(name) != mb.get(name))
    test_like = [name for name in changed if re.search(r"(^|/)(test_[^/]+\.py|tests?/)" r"|\.(test|spec)\.[^.]+$", name)]
    return {"recorded_execution_setting_differences": settings,
            "recorded_sampling_differs": (normalized_sampling(candidate) != normalized_sampling(baseline))
            if all(normalized_sampling(r) is not None for r in (candidate, baseline)) else None,
            "changed_harness_files": changed,
            "test_named_changes_requiring_execution_path_review": test_like,
            "other_harness_changes_requiring_review": [name for name in changed if name not in test_like],
            "interpretation": "Missing evidence blocks exact acceptance. Unequal digests require compatibility review; they alone do not prove different execution behavior. No compatibility waiver has been applied."}


def observed_metric(row, metric):
    if metric in ("raw_tokens", "uncached_plus_output_tokens"):
        source = "input_tokens" if metric == "raw_tokens" else "uncached_tokens"
        a, b = row.get(source), row.get("output_tokens")
        return a + b if numeric(a) and numeric(b) else None
    value = row.get(metric)
    return value if numeric(value) else None


def metric_value(row, metric):
    if metric in TOKEN_METRICS or metric == "tool_calls":
        if row.get("usage_complete") is not True:
            return None
    if metric in TOKEN_METRICS:
        values = [row.get(k) for k in ("input_tokens", "cached_tokens", "uncached_tokens")]
        if not all(numeric(v) for v in values) or values[0] != values[1] + values[2]:
            return None
    return observed_metric(row, metric)


def outcome_summary(rows, getter):
    scores = [getter(row) for row in rows]
    counts = {"passed": sum(v is True for v in scores), "failed": sum(v is False for v in scores),
              "unknown": sum(v is None for v in scores), "attempts": len(scores)}
    counts["rate"] = counts["passed"] / len(scores) if scores and not counts["unknown"] else None
    return counts


def aggregate(rows):
    metrics = {}
    for metric in METRICS:
        known = [v for row in rows if (v := metric_value(row, metric)) is not None]
        observed = [v for row in rows if (v := observed_metric(row, metric)) is not None]
        complete = bool(rows) and len(known) == len(rows)
        metrics[metric] = {"known_attempts": len(known), "missing_attempts": len(rows) - len(known),
                           "observed_sum": sum(observed) if observed else None,
                           "sum": sum(known) if complete else None,
                           "mean": statistics.mean(known) if complete else None}
        if metric == "wall_seconds":
            metrics[metric].update(median=statistics.median(known) if complete else None,
                                  p90=sorted(known)[math.ceil(.9 * len(known)) - 1] if complete else None)
    # Categories must be supplied by an explicit, separately identified analysis.
    # Do not infer a breakdown from model_calls or silently count missing as zero.
    classified = [row for row in rows if isinstance(row.get("call_categories"), dict)
                  and row.get("call_categories_method") and row.get("call_categories_complete") is True
                  and all(numeric(v) for v in row["call_categories"].values())
                  and sum(row["call_categories"].values()) == row.get("model_calls")]
    methods = sorted({row["call_categories_method"] for row in classified})
    categories = Counter()
    for row in classified:
        categories.update(row["call_categories"])
    return {"attempts": len(rows), "recorded_outcomes": outcome_summary(rows, original),
            "effective_original_outcomes": outcome_summary(rows, completion),
            "code_only_outcomes": outcome_summary(rows, lambda r: completion(r, True)),
            "proposed_symmetric_outcomes": outcome_summary(rows, lambda r: boolean(r.get("symmetric_pass"))),
            "usage_complete_attempts": sum(r.get("usage_complete") is True for r in rows),
            "metrics": metrics,
            "call_categories": {"complete": bool(rows) and len(classified) == len(rows) and len(methods) == 1,
                                "known_attempts": len(classified), "missing_attempts": len(rows) - len(classified),
                                "methods": methods, "observed_counts": dict(categories)}}


def cluster_interval(pairs, metric, samples=10000):
    """Paired task means; bootstrap tasks, never individual repeats as IID."""
    grouped = defaultdict(list)
    missing = []
    for candidate, baseline in pairs:
        a, b = metric_value(candidate, metric), metric_value(baseline, metric)
        if a is None or b is None:
            missing.append({"task": candidate["task"], "repeat": candidate["repeat"]})
        else:
            grouped[candidate["task"]].append(a - b)
    means = [statistics.mean(grouped[task]) for task in sorted(grouped)]
    result = {"pairs": len(pairs), "known_pairs": sum(map(len, grouped.values())),
              "missing_pairs": missing, "tasks_with_known_values": len(means),
              "mean_task_delta": None, "ci95": None, "interpretation": "inconclusive",
              "method": f"equal-weight task means; {samples} seeded task-cluster percentile resamples",
              "delta_direction": "descriptive cache volume; no automatic favorable direction" if metric == "cached_tokens" else "negative favors Light"}
    if not means or missing:
        result["reason"] = "missing_metric_pairs" if missing else "no_eligible_pairs"
        return result
    result["mean_task_delta"] = statistics.mean(means)
    if len(means) < 2:
        result["reason"] = "one_task_cannot_estimate_across_task_uncertainty"
        return result
    rng = random.Random(20260930)
    draws = sorted(statistics.mean(rng.choices(means, k=len(means))) for _ in range(samples))
    lo, hi = draws[max(0, math.ceil(.025 * samples) - 1)], draws[math.ceil(.975 * samples) - 1]
    result["ci95"] = [lo, hi]
    result["interpretation"] = "inconclusive" if lo <= 0 <= hi else ("candidate_lower" if hi < 0 else "candidate_higher")
    result["reason"] = "interval_includes_zero" if lo <= 0 <= hi else "directional_exploratory_evidence"
    return result


def compare(rows, *, candidate_phases=("candidate-c16",), baseline_phases=("baseline",),
            models=("deepseek-flash",), tasks=TASKS, repeats=(1,),
            candidate_revision=CANDIDATE_SHA, baseline_revision="0.73.1"):
    for name, values in (("candidate_phases", candidate_phases), ("baseline_phases", baseline_phases),
                         ("models", models), ("tasks", tasks), ("repeats", repeats)):
        if not values or len(values) != len(set(values)):
            raise ValueError("Empty or duplicate " + name)
    if any(type(r) is not int or r < 1 for r in repeats):
        raise ValueError("Repeats must be positive integers")
    selected = {"candidate": [], "baseline": []}
    extra = {"candidate": [], "baseline": []}
    for row in rows:
        if row.get("model") not in models or row.get("task") not in tasks:
            continue
        arm = ("candidate" if row.get("agent") == "light" and row.get("phase") in candidate_phases else
               "baseline" if row.get("agent") == "pi" and row.get("phase") in baseline_phases else None)
        if arm:
            (selected if type(row.get("repeat")) is int and row["repeat"] in repeats else extra)[arm].append(row)
    models_report = []
    for model in models:
        arms = {arm: [r for r in rs if r["model"] == model] for arm, rs in selected.items()}
        index = {arm: defaultdict(list) for arm in arms}
        for arm, rs in arms.items():
            for row in rs:
                index[arm][(row["task"], row["repeat"])].append(row)
        missing = {arm: [] for arm in arms}
        duplicates = {arm: [] for arm in arms}
        pairs, eligible = [], []
        diagnostics = []
        for task in tasks:
            for repeat in repeats:
                key = (task, repeat)
                for arm in arms:
                    members = index[arm][key]
                    if not members:
                        missing[arm].append({"task": task, "repeat": repeat})
                    elif len(members) > 1:
                        duplicates[arm].append({"task": task, "repeat": repeat,
                                                "ids": [r.get("id") for r in members]})
                if any(len(index[arm][key]) != 1 for arm in arms):
                    continue
                a, b = index["candidate"][key][0], index["baseline"][key][0]
                pairs.append((a, b))
                issues = contract_issues(a, b, candidate_revision, baseline_revision)
                if not issues:
                    eligible.append((a, b))
                diagnostics.append({"task": task, "repeat": repeat, "candidate_id": a.get("id"),
                                    "baseline_id": b.get("id"), "contract_issues": issues,
                                    "contract_review": contract_review(a, b),
                                    "contract_matched": not issues,
                                    "original_comparable": not issues and not task12(a),
                                    "code_only_comparable": not issues and all(completion(r, True) is not None for r in (a, b)),
                                    "task12_planning_contract": "historically_unequal" if task12(a) else "not_applicable"})
                diagnostics[-1]["observed_metric_deltas"] = {
                    metric: metric_value(a, metric) - metric_value(b, metric)
                    if all(metric_value(r, metric) is not None for r in (a, b)) else None
                    for metric in METRICS}
        lost, observed_lost, unknown = [], [], []
        # Any Pi-completed task with a failed Light repeat blocks a broad claim,
        # including unmatched repeats; task12 uses only separately captured code.
        for task in tasks:
            a_rows, b_rows = [r for r in arms["candidate"] if r["task"] == task], [r for r in arms["baseline"] if r["task"] == task]
            getter = (lambda r: completion(r, True)) if task.startswith("12-") else completion
            if any(getter(r) is True for r in b_rows):
                if any(getter(r) is False for r in a_rows):
                    observed_lost.append(task)
                if not a_rows or any(getter(r) is None for r in a_rows):
                    unknown.append(task)
        for a, b in eligible:
            getter = (lambda r: completion(r, True)) if task12(a) else completion
            if getter(b) is True and getter(a) is False:
                lost.append(a["task"])
        blockers = []
        if any(missing.values()): blockers.append("missing_cells")
        if any(duplicates.values()): blockers.append("duplicate_cells_no_arbitrary_pairing")
        if len(eligible) != len(pairs): blockers.append("unmatched_source_prompt_harness_or_settings")
        if observed_lost: blockers.append("observed_completion_loss_on_pi_completed_task")
        if unknown: blockers.append("unknown_candidate_completion_on_pi_completed_task")
        if any(task.startswith("12-") for task in tasks): blockers.append("historical_task12_planning_contract_unequal")
        if any(completion(r) is None for rs in arms.values() for r in rs): blockers.append("unknown_outcomes")
        if any(metric_value(r, metric) is None for rs in arms.values() for r in rs for metric in TOKEN_METRICS): blockers.append("unknown_or_inconsistent_usage")
        if len(repeats) < 2: blockers.append("one_repeat_diagnostic_only")
        # This analysis cannot certify a panel as independently held out.
        blockers.append("independent_repeated_confirmation_required")
        original_pairs = [(a, b) for a, b in eligible if not task12(a)]
        code_pairs = [(a, b) for a, b in eligible if all(completion(r, True) is not None for r in (a, b))]
        models_report.append({"model": model, "expected_cells_per_arm": len(tasks) * len(repeats),
                              "arms": {arm: aggregate(rs) for arm, rs in arms.items()},
                              "missing_cells": missing, "duplicate_cells": duplicates,
                              "identity_pairs": len(pairs), "contract_matched_pairs": len(eligible),
                              "original_comparable_pairs": len(original_pairs), "code_only_comparable_pairs": len(code_pairs),
                              "performance_comparable_pairs": len(original_pairs),
                              "contract_matched_lost_completion_tasks": sorted(set(lost)),
                              "observed_lost_completion_tasks": observed_lost,
                              "observed_loss_caveat": "Historical contract differences limit causal attribution; loss still prevents a broad improvement claim.",
                              "pairs": diagnostics,
                              "paired_task_cluster_metrics": {metric: cluster_interval(original_pairs, metric) for metric in METRICS},
                              "identity_matched_diagnostic_metrics": {
                                  "eligible_for_acceptance": False,
                                  "caveat": "Descriptive pairs with matching task/repeat only; source/harness/settings may differ. Task12 excluded for unequal planning workload. These intervals do not remove confounding.",
                                  "metrics": {metric: cluster_interval([(a, b) for a, b in pairs if not task12(a)], metric) for metric in METRICS}},
                              "claim_status": "blocked_by_observed_completion_loss" if observed_lost else "inconclusive",
                              "broad_improvement_claim_supported": False, "blockers": blockers})
    cells = []
    for arm, rs in selected.items():
        for row in rs:
            cells.append({"arm": arm, **{k: row.get(k) for k in
                          ("id", "phase", "model", "task", "repeat", "agent_revision", *HASH_FIELDS)},
                          **{k: row.get(k) for k in ("check_pass", "exit_code", "timeout", "budget_stop", "stop_reason")},
                          "recorded_pass": original(row), "effective_original_pass": completion(row),
                          "coding_pass": boolean(row.get("coding_pass")), "code_only_completion": completion(row, True),
                          "proposed_symmetric_pass": boolean(row.get("symmetric_pass")),
                          "usage_complete": row.get("usage_complete") is True,
                          "task12_planning_comparable": False if task12(row) else None,
                          "metadata_issues": metadata_issues(row, candidate_revision if arm == "candidate" else baseline_revision, arm)})
    return {"schema_version": 1, "selection": {"candidate_phases": candidate_phases,
            "baseline_phases": baseline_phases, "candidate_revision": candidate_revision,
            "baseline_revision": baseline_revision, "models": models, "tasks": tasks, "repeats": repeats},
            "unselected_repeat_ids": {arm: [r.get("id") for r in rs] for arm, rs in extra.items()},
            "models": models_report, "selected_cells": cells,
            "limitations": [
                "Read-only metadata audit; reported source revisions do not independently verify built binaries.",
                "Configuration digests identify each run; they include arm/phase/source selection and need not equal across arms. Comparable settings, full harness manifest, task manifest and prompt must match exactly.",
                "First-call sampling alone does not prove every call used the same settings. Missing all-call evidence blocks exact matching.",
                "All selected attempts, failures, unknown outcomes and unknown usage remain in summaries. Duplicate cells block pairing, never select a preferred run.",
                "Code-only scores require explicit coding_pass; check_pass can include capability checks and is never silently relabeled.",
                "Historical task12 original and proposed scores are retained, but unequal planning contracts cannot establish a comparative planning win. Code-only outcomes do not remove task execution confounds.",
                "Task12 is excluded from strict comparative time/token/call estimates because its planning workload differed. Its observed arm-level metrics and code-only outcomes remain visible.",
                "Intervals containing zero are inconclusive, never evidence of equivalence. Task-cluster bootstrap cannot establish within-task repeatability with one repeat.",
                "Wall p90 is nearest rank and includes failed attempts. Model calls and runtime replay measure different things; fewer model calls do not establish faster runtime.",
                "No finite diagnostic panel establishes universal superiority. Independent repeated confirmation is required."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="JSON array, snapshot object, or - for stdin")
    parser.add_argument("--candidate-phases", default="candidate-c16")
    parser.add_argument("--baseline-phases", default="baseline")
    parser.add_argument("--models", default="deepseek-flash")
    parser.add_argument("--tasks", default=",".join(TASKS))
    parser.add_argument("--repeats", default="1")
    parser.add_argument("--candidate-revision", default=CANDIDATE_SHA)
    parser.add_argument("--baseline-revision", default="0.73.1")
    args = parser.parse_args()
    raw = sys.stdin.buffer.read() if args.input == "-" else Path(args.input).read_bytes()
    source = json.loads(raw)
    rows = source if isinstance(source, list) else source.get("runs", source.get("attempts"))
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        parser.error("Expected an array of result objects")
    report = compare(rows, candidate_phases=args.candidate_phases.split(","),
                     baseline_phases=args.baseline_phases.split(","), models=args.models.split(","),
                     tasks=args.tasks.split(","), repeats=[int(r) for r in args.repeats.split(",")],
                     candidate_revision=args.candidate_revision, baseline_revision=args.baseline_revision)
    report["input_sha256"] = hashlib.sha256(raw).hexdigest()
    if isinstance(source, dict):
        report["snapshot_complete"] = source.get("snapshot_complete")
        report["snapshot_issues"] = source.get("snapshot_issues", [])
        if source.get("snapshot_complete") is False:
            for model in report["models"]:
                model["blockers"].append("snapshot_incomplete_or_changed_during_read")
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
