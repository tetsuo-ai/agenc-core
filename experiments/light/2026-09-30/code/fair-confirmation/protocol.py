"""Draft protocol resolution and synthetic-only scoring; never launches a run.

The plan score measures a visible checklist's format and position, not quality.
Normalized evidence must be produced by a separately reviewed capture adapter.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re


def resolve_manifest(base_bytes: bytes, proposal: dict) -> dict:
    """Return a new proposed manifest; never modify base data or filesystem."""
    if hashlib.sha256(base_bytes).hexdigest() != proposal["base"]["manifest_sha256"]:
        raise ValueError("base manifest hash mismatch")
    base = json.loads(base_bytes)
    tasks = copy.deepcopy(base["tasks"])
    ids = [task["id"] for task in tasks]
    if ids != proposal["task_ids"] or len(set(ids)) != 12:
        raise ValueError("exact twelve-task inventory required")
    override = proposal["task12_override"]
    task = next(task for task in tasks if task["id"] == override["id"])
    if not task["prompt"].startswith(override["replace_prefix"]):
        raise ValueError("task12 original prefix mismatch")
    task["prompt"] = override["with_prefix"] + task["prompt"][len(override["replace_prefix"]):]
    for field in override["remove_fields"]:
        if field not in task:
            raise ValueError("missing original deferred field")
        del task[field]
    for field in ("category", "workload_revision", "planning_grader"):
        task[field] = override[field]
    return {
        "schema_version": 2,
        "protocol_id": proposal["protocol_id"],
        "status": proposal["status"],
        "sample_role": proposal["sample_role"],
        "base_manifest_sha256": proposal["base"]["manifest_sha256"],
        "tasks": tasks,
    }


KINDS = {"assistant_text_delta", "assistant_reasoning_delta", "tool_call_start", "assistant_message_end"}
CHECKLIST_LINE = re.compile(r"^- \[ \] (\S.*\S|\S)$")


def visible_plan_score(capture: dict) -> dict:
    """Tri-state format-only score from complete ordered provider stream events.

    Tool output, user messages and replayed prompt/history are forbidden event
    sources. Hidden reasoning is ignored. Ordinals are contiguous capture order,
    not wall-clock timestamps or order synthesized from final response JSON.
    """
    def result(passed, reason):
        return {"visible_plan_format_pass": passed, "reason": reason,
                "plan_semantic_quality": None, "grader": "visible-checklist-prefix-v1"}

    if (capture.get("schema_version") != 1 or capture.get("complete") is not True
            or capture.get("stream_order_preserved") is not True
            or not re.fullmatch(r"[0-9a-f]{64}", str(capture.get("adapter_sha256", "")))):
        return result(None, "missing_complete_ordered_capture_provenance")
    events = capture.get("events")
    if not isinstance(events, list):
        return result(None, "invalid_capture")
    first_message = None
    visible = []
    ended = False
    frozen = False
    for index, event in enumerate(events, 1):
        if (not isinstance(event, dict) or type(event.get("seq")) is not int
                or event["seq"] != index or event.get("kind") not in KINDS
                or not isinstance(event.get("message_id"), str) or not event["message_id"]):
            return result(None, "invalid_or_discontinuous_event_order")
        kind = event["kind"]
        if kind in {"assistant_text_delta", "assistant_reasoning_delta"} and not isinstance(event.get("text"), str):
            return result(None, "invalid_text_delta")
        if first_message is None:
            first_message = event["message_id"]
        if event["message_id"] != first_message:
            frozen = True
        if kind == "tool_call_start":
            frozen = True
        if kind == "assistant_message_end" and event["message_id"] == first_message and not frozen:
            ended = True
        if kind == "assistant_text_delta" and event["message_id"] == first_message and not frozen:
            if ended:
                return result(None, "text_after_message_end")
            visible.append(event["text"])
    text = "".join(visible).lstrip()
    lines = text.splitlines()
    items = []
    for line in lines:
        match = CHECKLIST_LINE.fullmatch(line.rstrip())
        if match is None:
            break
        items.append(match.group(1))
    if not 2 <= len(items) <= 5:
        return result(False, "first_visible_response_lacks_2_to_5_prefix_checklist_items")
    return result(True, "visible_prefix_checklist_present_semantics_unscored")


def score_cell(*, code_artifact_pass, normal_exit, timed_out, budget_stopped,
               planning_required, plan=None):
    """Keep artifact correctness, execution completion, and planning separate."""
    values = (code_artifact_pass, normal_exit, timed_out, budget_stopped)
    if type(planning_required) is not bool:
        raise ValueError("planning_required must be explicit")
    if any(value is not None and type(value) is not bool for value in values):
        raise ValueError("scores must be explicit booleans or unknown")
    if code_artifact_pass is False or normal_exit is False or timed_out is True or budget_stopped is True:
        code_completion = False
    elif None in values:
        code_completion = None
    else:
        code_completion = True
    plan_pass = plan.get("visible_plan_format_pass") if plan is not None else None
    if plan_pass is not None and type(plan_pass) is not bool:
        raise ValueError("plan score must be an explicit boolean or unknown")
    if not planning_required:
        requested_contract = code_completion
    elif code_completion is False or plan_pass is False:
        requested_contract = False
    elif code_completion is None or plan_pass is None:
        requested_contract = None
    else:
        requested_contract = True
    return {"code_artifact_pass": code_artifact_pass, "code_completion": code_completion,
            "visible_plan_format_pass": plan_pass,
            "requested_format_contract_pass": requested_contract,
            "plan_semantic_quality": None}
