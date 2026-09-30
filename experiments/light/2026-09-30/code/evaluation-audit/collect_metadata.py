#!/usr/bin/env python3
"""Read-only metadata collector; run via SSH stdin; outputs allowlisted JSON.

No imported benchmark code, provider calls, environment/credential reads,
ledger access, result writes, log text or model prompt/response export.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import datetime
import hashlib
import json
from pathlib import Path
import re

FIELDS = ("id", "phase", "provider", "task", "agent", "model", "repeat", "pass", "check_pass",
          "coding_pass", "recorded_pass", "symmetric_pass", "frozen_pass", "exit_code", "timeout",
          "budget_stop", "stop_reason", "provider_unavailable", "wall_seconds", "model_calls", "tool_calls",
          "provider_errors", "usage_complete", "input_tokens", "cached_tokens", "uncached_tokens",
          "output_tokens", "agent_revision", "prompt_sha256", "harness_sha256", "configuration_sha256")
PROVENANCE_FIELDS = ("task_manifest_sha256", "provider", "workers", "seed", "max_calls",
                     "reasoning_effort", "output_cap", "openai_reasoning_replay", "node_version",
                     "python_version", "configuration_sha256", "candidate_revision", "pi_version",
                     "spend_cap_usd", "balance_floor_usd", "luna_study_call_cap",
                     "light_adaptive_effort", "light_adaptive_high")
KEY = re.compile(r"sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|PRIVATE KEY")


def primitive(value):
    if value is None or type(value) in (bool, int, float):
        return value
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,220}", value) and not KEY.search(value):
        return value
    raise ValueError("Unexpected metadata value (content withheld)")


def sampling(body):
    reason = body.get("reasoning") or {}
    if not isinstance(reason, dict):
        raise ValueError("Malformed reasoning settings")
    caps = [body[k] for k in ("max_tokens", "max_completion_tokens", "max_output_tokens") if body.get(k) is not None]
    if not caps or len(set(caps)) != 1:
        raise ValueError("Missing or conflicting output caps")
    effort = reason.get("effort", body.get("reasoning_effort"))
    if reason.get("effort") is not None and body.get("reasoning_effort") is not None and reason["effort"] != body["reasoning_effort"]:
        raise ValueError("Conflicting reasoning effort")
    thinking = body.get("thinking")
    if isinstance(thinking, dict):
        thinking = {primitive(k): primitive(v) for k, v in thinking.items()}
    else:
        thinking = primitive(thinking)
    return {"model": primitive(body.get("model")), "output_cap": primitive(caps[0]),
            "reasoning_effort": primitive(effort),
            "reasoning_options": {primitive(k): primitive(v) for k, v in reason.items() if k != "effort"},
            "thinking": thinking, "temperature": primitive(body.get("temperature")), "top_p": primitive(body.get("top_p"))}


def collect(root, phases, models, candidate_phases=("candidate-c16", "candidate-api-takeoverruntime")):
    if isinstance(candidate_phases, str):
        candidate_phases = candidate_phases.split(",")
    rows, issues, watched = [], [], {}
    initial_dirs = sorted(path for path in root.iterdir() if path.is_dir() and any(path.name.startswith(p + "-") for p in phases))

    def read(path):
        before = path.stat()
        raw = path.read_bytes()
        after = path.stat()
        stamp = (after.st_size, after.st_mtime_ns)
        watched[path] = stamp
        if (before.st_size, before.st_mtime_ns) != stamp:
            raise ValueError("Artifact changed during read")
        return raw

    for directory in initial_dirs:
        match = re.fullmatch(r"(.+)-(" + "|".join(map(re.escape, models)) + r")-(\d{2}-[a-z-]+)-(pi|light)-r(\d+)", directory.name)
        if not match:
            continue
        phase, model, task, agent, repeat = match.groups()
        if phase not in phases or ((phase in candidate_phases) != (agent == "light")):
            continue
        identity = {"id": primitive(directory.name), "phase": phase, "model": model,
                    "task": task, "agent": agent, "repeat": int(repeat)}
        path = directory / "result.json"
        if not path.exists():
            # A running/failed-before-result attempt remains unknown, not dropped.
            rows.append({**identity, "_unfinished": True, "usage_complete": False})
            issues.append({"id": identity["id"], "kind": "attempt_without_result"})
            continue
        try:
            raw = read(path)
            result = json.loads(raw)
            row = {k: primitive(result[k]) for k in FIELDS if k in result}
            if any(row.get(k) != v for k, v in identity.items()):
                raise ValueError("Directory/result identity mismatch")
            row["source_result_sha256"] = hashlib.sha256(raw).hexdigest()
            provenance = result.get("provenance") or {}
            row["provenance"] = {k: primitive(provenance[k]) for k in PROVENANCE_FIELDS if k in provenance}
            manifest = provenance.get("harness_files_sha256")
            if isinstance(manifest, dict):
                if not all(re.fullmatch(r"[A-Za-z0-9_./-]+", name) and re.fullmatch(r"[a-f0-9]{64}", value)
                           for name, value in manifest.items()):
                    raise ValueError("Invalid harness manifest")
                row["provenance"]["harness_files_sha256"] = manifest
            recorded_sampling = result.get("sampling")
            if isinstance(recorded_sampling, dict):
                normalized = sampling(recorded_sampling)
                # Restore conventional keys so compare.normalized_sampling can
                # consume both historical exports and this collector's records.
                row["sampling"] = {"model": normalized["model"], "max_tokens": normalized["output_cap"],
                                   "reasoning": {"effort": normalized["reasoning_effort"], **normalized["reasoning_options"]},
                                   **{k: normalized[k] for k in ("thinking", "temperature", "top_p")}}
            signatures, errors = {}, []
            wires = sorted(directory.glob("wire-*.json"))
            for wire in wires:
                try:
                    body = json.loads(read(wire))["body"]
                    signature = sampling(body)
                    signatures[json.dumps(signature, sort_keys=True)] = signature
                except (OSError, ValueError, KeyError, TypeError):
                    errors.append(wire.name)
            row["sampling_signatures"] = list(signatures.values())
            row["wire_calls"] = len(wires)
            row["capture_errors"] = errors
            if sorted(directory.glob("wire-*.json")) != wires:
                issues.append({"id": row["id"], "kind": "wire_inventory_changed"})
            rows.append(row)
        except (OSError, ValueError, KeyError, TypeError):
            rows.append({**identity, "_malformed": True, "usage_complete": False})
            issues.append({"id": identity["id"], "kind": "unreadable_changed_or_invalid_metadata"})
    if sorted(path for path in root.iterdir() if path.is_dir() and any(path.name.startswith(p + "-") for p in phases)) != initial_dirs:
        issues.append({"kind": "directory_inventory_changed"})
    for path, stamp in watched.items():
        try:
            current = path.stat()
            if (current.st_size, current.st_mtime_ns) != stamp:
                issues.append({"id": path.parent.name, "kind": "artifact_changed_during_snapshot"})
        except OSError:
            issues.append({"id": path.parent.name, "kind": "artifact_disappeared_during_snapshot"})
    return {"schema_version": 1, "collected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "snapshot_complete": not issues, "snapshot_issues": issues, "runs": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/home/paul/claude-agenc-work/light-ultra/runs"))
    parser.add_argument("--phases", default="candidate-c16,candidate-api-takeoverruntime,baseline,candidate-api-b,candidate-api-p")
    parser.add_argument("--models", default="deepseek-flash,gpt-6-luna")
    parser.add_argument("--candidate-phases", default="candidate-c16,candidate-api-takeoverruntime")
    args = parser.parse_args()
    output = collect(args.root, args.phases.split(","), args.models.split(","), args.candidate_phases)
    encoded = json.dumps(output, indent=2, allow_nan=False)
    if KEY.search(encoded):
        raise ValueError("Credential-pattern check rejected output")
    print(encoded)


if __name__ == "__main__":
    main()
