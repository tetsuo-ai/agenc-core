"""Verify frozen measured records offline. No keys, network or account state."""
import hashlib
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("live_eval", HERE / "live-eval.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
folder = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "measurements-2026-09-29"
capture = json.loads((folder / "capture.json").read_text())
suite, _ = runner.load_suite(folder / "suite.json")
suite_source = (HERE / "live-eval-tasks.json").read_bytes()
assert runner.digest(suite_source) == capture["suiteSha256"], "predeclared suite changed"
assert runner.canonical_digest(suite) == capture["suiteCanonicalSha256"], "captured suite changed"
assert runner.digest((HERE / "live-eval.py").read_bytes()) == capture["runnerSha256"], "collection runner changed"
raw_records = (folder / "records.jsonl").read_bytes()
assert runner.digest(raw_records) == capture["recordsSha256"], "recorded answers changed"
records = [json.loads(line) for line in raw_records.splitlines() if line]
by_id = {task["id"]: task for task in suite["tasks"]}
seen = set()
for record in records:
    task = by_id[record["taskId"]]
    identity = (record["taskId"], record["model"])
    assert identity not in seen and record["model"] in runner.MODELS, "unexpected or duplicate record"
    seen.add(identity)
    assert record["promptSha256"] == runner.digest(task["prompt"].encode("utf8"))
    assert record["split"] == task["split"] and record["kind"] == task["kind"] and record["complexity"] == task["complexity"]
    assert runner.grade(record["answer"], task["expected"]) == record["grade"], "grader mismatch"
    assert runner.usage_cost(record["model"], record["usage"]) == record["usageCostUsdAtPeakRates"], "price calculation mismatch"
assert len(records) == 24 and all((task["id"], model) in seen for task in suite["tasks"] for model in runner.MODELS)
fixture = json.loads((folder / "recorded-measurements.json").read_text())
assert fixture["provenance"] == "recorded-measurements" and fixture["missingOrUnpriced"] == []
assert {entry["id"] for entry in fixture["tasks"]} == {task["id"] for task in suite["tasks"] if task["split"] == "holdout"}
for record in records:
    if record["split"] == "holdout":
        assert fixture["outcomes"][record["taskId"]]["deepseek/" + record["model"]] == {
            "passed": record["grade"]["passed"], "costUsd": record["usageCostUsdAtPeakRates"], "latencyMs": record["latencyMs"]}
summary = [{"split": split, "model": model, "passed": sum(record["grade"]["passed"] for record in records
           if record["split"] == split and record["model"] == model), "tasks": 6}
           for split in ("calibration", "holdout") for model in runner.MODELS]
print(json.dumps({"verifiedRecords": len(records), "networkCalls": 0, "scores": summary}))
