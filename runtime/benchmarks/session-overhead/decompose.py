#!/usr/bin/env python3
"""Decompose an existing replay panel without collecting new timings.

Usage: python3 decompose.py PANEL_DIRECTORY > decomposition.json

Reads plan.json and each cell's agent.json, requests.json and metrics.json.
The session clock includes harness teardown; tail_ms must not be interpreted
as application close/seal time without additional timestamps. Bootstrap CIs
are exploratory attribution, not a replacement for the panel's decision rule.
"""

import json
import math
from pathlib import Path
import random
import statistics
import sys


def quantile(values, probability):
    values = sorted(values)
    position = (len(values) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def bootstrap(values, samples, seed):
    rng = random.Random(seed)
    means = [statistics.mean(rng.choices(values, k=len(values))) for _ in range(samples)]
    return {
        "delta_ms": statistics.mean(values),
        "ci95_ms": [quantile(means, .025), quantile(means, .975)],
        "absolute_mean_p95_ms": quantile([abs(value) for value in means], .95),
        "paired_differences_ms": values,
    }


def decompose(directory):
    plan = json.loads((directory / "plan.json").read_text())
    rows = {}
    for cell in plan["schedule"]:
        root = directory / "cells" / cell["label"]
        host = json.loads((root / "host.json").read_text())
        assert host["passed"] and host["head"] == plan[cell["arm"]]
        agent = json.loads((root / "agent.json").read_text())
        requests = json.loads((root / "requests.json").read_text())
        metrics = json.loads((root / "metrics.json").read_text())
        assert not requests["errors"]
        requests = requests["requests"]
        assert len(requests) == plan["steps"] + 1
        assert len(metrics["gaps_ms"]) == plan["steps"]
        gaps = [b["received_ms"] - a["sent_ms"] for a, b in zip(requests, requests[1:])]
        assert all(math.isclose(a, b, abs_tol=1e-5) for a, b in zip(gaps, metrics["gaps_ms"]))
        row = {
            "startup_ms": requests[0]["received_ms"] - agent["started_ms"],
            "gaps_total_ms": sum(gaps),
            "provider_ms": sum(r["sent_ms"] - r["received_ms"] for r in requests),
            "tail_ms": agent["finished_ms"] - requests[-1]["sent_ms"],
        }
        session = agent["finished_ms"] - agent["started_ms"]
        assert math.isclose(sum(row.values()), session, abs_tol=1e-5)
        row["session_ms"] = session
        rows[cell["label"]] = row

    results = {}
    for index, storage in enumerate(plan["storages"]):
        results[storage] = {}
        for metric in next(iter(rows.values())):
            phases = {}
            for phase in ("AA", "AB"):
                cells = [c for c in plan["schedule"] if c["storage"] == storage and c["phase"] == phase]
                pairs = sorted({c["pair"] for c in cells})
                left, right = [], []
                for pair in pairs:
                    group = [c for c in cells if c["pair"] == pair]
                    assert len(group) == 2
                    arms = {c["replica"]: rows[c["label"]][metric] for c in group}
                    assert set(arms) == {"A", "B"}
                    left.append(arms["A"])
                    right.append(arms["B"])
                phases[phase] = bootstrap(
                    [b - a for a, b in zip(left, right)],
                    plan["bootstrap_resamples"], plan["bootstrap_seed"] + index,
                )
                phases[phase].update(a_mean_ms=statistics.mean(left), b_mean_ms=statistics.mean(right))
            results[storage][metric] = {
                "phases": phases,
                "aa_floor_ms": phases["AA"]["absolute_mean_p95_ms"],
            }
    return {"heads": {key: plan[key] for key in ("base", "candidate")}, "cells": rows, "results": results}


if __name__ == "__main__":
    json.dump(decompose(Path(sys.argv[1]).resolve()), sys.stdout, indent=2)
    print()
