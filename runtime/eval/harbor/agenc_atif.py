"""ATIF trajectory and usage from AgenC's native rollouts, for the Harbor adapter.

The conversion is the one the published Terminal-Bench 2.1 runs used (Harbor
Hub jobs 71f39f3b and 2bf2c84d). Every rollout file stays as it is in
``agent/native-rollouts``, each gets an ``.atif.json`` view next to it, and the
view with the most steps is also written as ``agent/trajectory.json``, the file
Harbor's uploader publishes as the trial's trajectory.

Usage comes from the same rollouts: ``token_count`` events carry each model
call's tokens and ``session_usage`` carries Core's running cost estimate. This
module has no Harbor import at load time, so it is testable with the system
Python.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

ATIF_SCHEMA = "ATIF-v1.8"


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", json.dumps(part, ensure_ascii=False))
            for part in content
            if isinstance(part, dict)
        )
    return json.dumps(content, ensure_ascii=False)


def read_rows(path: Path) -> list[dict[str, Any]]:
    rows = []
    for line in Path(path).read_text(errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def convert_rows(
    rows: Iterable[dict[str, Any]], agent: dict[str, Any], session_id: str
) -> dict[str, Any] | None:
    """One rollout's durable response items as an ATIF document, or None."""
    steps: list[dict[str, Any]] = []
    calls: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("type") != "response_item":
            continue
        item = row.get("payload") or {}
        role = item.get("role")
        text = content_text(item.get("content", ""))
        if role == "tool":
            owner = calls.get(item.get("toolCallId"))
            if owner is None:
                # ATIF only lets an observation name a call made in its own step, so
                # a result whose call is not in this rollout keeps the id in extra.
                steps.append(
                    {
                        "step_id": len(steps) + 1,
                        "source": "agent",
                        "message": "",
                        "observation": {"results": [{
                            "content": text,
                            "extra": {"native_payload": item, "unmatched_call_id": item.get("toolCallId")},
                        }]},
                        "extra": {"native_type": "unmatched_tool_result"},
                    }
                )
            else:
                owner.setdefault("observation", {"results": []})["results"].append({
                    "source_call_id": item.get("toolCallId"),
                    "content": text,
                    "extra": {"native_payload": item},
                })
            continue
        if role not in ("system", "developer", "user", "assistant"):
            continue
        step: dict[str, Any] = {
            "step_id": len(steps) + 1,
            "source": "agent" if role == "assistant" else "system" if role == "developer" else role,
            "message": text,
            "extra": {"native_payload": item},
        }
        if role == "assistant":
            step.update(model_name=agent["model_name"], reasoning_effort=agent["reasoning_effort"])
            if item.get("toolCalls"):
                tools = []
                for call in item["toolCalls"]:
                    try:
                        arguments = json.loads(call.get("arguments") or "{}")
                    except ValueError:
                        arguments = {"raw": call.get("arguments")}
                    if not isinstance(arguments, dict):
                        arguments = {"raw": arguments}
                    tools.append(
                        {
                            "tool_call_id": call["id"],
                            "function_name": call["name"],
                            "arguments": arguments,
                        }
                    )
                    calls[call["id"]] = step
                step["tool_calls"] = tools
        steps.append(step)
    if not steps:
        return None
    return {
        "schema_version": ATIF_SCHEMA,
        "session_id": session_id,
        "agent": {
            "name": agent["name"],
            "version": agent["version"],
            "model_name": agent["model_name"],
            "extra": {
                "reasoning_effort": agent["reasoning_effort"],
                "budget": agent["budget"],
                "commit": agent["commit"],
            },
        },
        "steps": steps,
        "notes": (
            "View of durable response items. Full native rollouts, events and any "
            "other threads are retained in agent/native-rollouts. Opaque provider "
            "reasoning state is not rendered as assistant text."
        ),
    }


def _validated_json(doc: dict[str, Any]) -> str:
    try:
        from harbor.models.trajectories import Trajectory
    except ImportError:  # outside Harbor (tests): keep the plain document
        return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    model = Trajectory.model_validate(doc)
    return model.model_dump_json(indent=2, exclude_none=True) + "\n"


def emit(agent_dir: Path, agent: dict[str, Any]) -> dict[str, Any]:
    """Write the .atif.json views and agent/trajectory.json; report what was written."""
    root = Path(agent_dir)
    files = sorted((root / "native-rollouts").glob("*.jsonl"))
    views = []
    for path in files:
        doc = convert_rows(read_rows(path), agent, path.stem)
        if doc:
            views.append((path, doc))
    if not views:
        return {"available": False, "reason": "No durable response items captured"}
    for path, doc in views:
        (root / "native-rollouts" / (path.stem + ".atif.json")).write_text(_validated_json(doc))
    primary = max(views, key=lambda view: len(view[1]["steps"]))[1]
    (root / "trajectory.json").write_text(_validated_json(primary))
    return {
        "available": True,
        "native_files": len(files),
        "atif_views": len(views),
        "primary_selection": "largest durable response-item view; all threads retained separately",
    }


def rollout_usage(paths: Iterable[Path]) -> dict[str, Any]:
    """Tokens summed over every model call, and Core's cost estimate summed over sessions.

    Each rollout file is one session. A child agent writes its own file and its
    token_count events stay there, so summing across files counts each call
    once. ``session_usage.costUsd`` is a running total within a session, so the
    largest value per file is that session's cost.
    """
    usage = {"calls": 0, "prompt": 0, "completion": 0, "cached": 0, "cost_usd": 0.0, "cost_known": False}
    for path in paths:
        session_cost = None
        for row in read_rows(path):
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            msg = payload.get("msg") if isinstance(payload.get("msg"), dict) else None
            if not msg:
                continue
            body = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
            if msg.get("type") == "token_count":
                usage["calls"] += 1
                usage["prompt"] += int(body.get("promptTokens") or 0)
                usage["completion"] += int(body.get("completionTokens") or 0)
                usage["cached"] += int(body.get("cachedInputTokens") or 0)
            elif msg.get("type") == "session_usage":
                cost = body.get("costUsd")
                if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                    session_cost = max(session_cost or 0.0, float(cost))
        if session_cost is not None:
            usage["cost_known"] = True
            usage["cost_usd"] += session_cost
    usage["cost_usd"] = round(usage["cost_usd"], 6)
    return usage
