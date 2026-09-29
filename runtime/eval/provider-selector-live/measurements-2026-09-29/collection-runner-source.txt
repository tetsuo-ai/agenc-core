#!/usr/bin/env python3
"""Fixed known-answer benchmark. Network mode is Linux-only; no key files are read.

Only the run subcommand calls DeepSeek. Other subcommands are entirely offline.
Provider errors are classified without saving response bodies or headers.
"""
import argparse
import datetime
import decimal
import hashlib
import itertools
import json
import math
import os
import pathlib
import platform
import re
import signal
import socket
import sys
import time
import urllib.error
import urllib.request
from fractions import Fraction

D = decimal.Decimal
HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_SUITE = HERE / "live-eval-tasks.json"
MODELS = ("deepseek-flash", "deepseek-v4-pro")
RATES = {
    "deepseek-flash": {"inputUsdPer1K": 0.0003, "outputUsdPer1K": 0.0012, "cachedInputUsdPer1K": 0.000006},
    "deepseek-v4-pro": {"inputUsdPer1K": 0.00132, "outputUsdPer1K": 0.00396, "cachedInputUsdPer1K": 0.000044},
}
PRICE_PROVENANCE = {
    "source": "agenc-core/runtime/src/session/cost.ts:404-415",
    "verifiedInRegistry": "2026-09-11",
    "registrySourceSnapshotSha256": "d2fe1c126257b7907dd6c195209e79674a34b144a788b4e050a36e125416aea1",
    "basis": "Native published peak USD rates. Off-peak billing can be lower. Usage-priced amounts are estimates, not invoices.",
    "reasoning": "completion_tokens includes reasoning tokens; reasoning_tokens is never charged a second time.",
}
SAFE_FINISH_REASONS = {"stop", "length", "tool_calls", "content_filter", "insufficient_system_resource"}


class SafeFailure(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8"))


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def load_suite(path):
    data = pathlib.Path(path).read_bytes()
    suite = json.loads(data)
    tasks = suite["tasks"]
    if len(tasks) != 12 or len({t["id"] for t in tasks}) != 12:
        raise SafeFailure("suite_must_have_12_unique_tasks")
    for split in ("calibration", "holdout"):
        cells = [(t["kind"], t["complexity"]) for t in tasks if t["split"] == split]
        if sorted(cells) != sorted(itertools.product(("extraction", "coding", "reasoning"), ("simple", "hard"))):
            raise SafeFailure("suite_split_stratification_invalid")
    if not all(isinstance(t["expected"], dict) and isinstance(t["prompt"], str) for t in tasks):
        raise SafeFailure("suite_schema_invalid")
    return suite, data


def json_answer(text):
    """Accept one JSON object, fenced or surrounded by prose. Reject ambiguity."""
    if not isinstance(text, str) or not text.strip():
        return None, "empty_answer"
    decoder = json.JSONDecoder(parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    candidates = []
    offset = 0
    while offset < len(text):
        start = text.find("{", offset)
        if start < 0:
            break
        try:
            value, length = decoder.raw_decode(text[start:])
        except (ValueError, json.JSONDecodeError):
            offset = start + 1
            continue
        candidates.append(value)
        offset = start + length
    if len(candidates) != 1 or not isinstance(candidates[0], dict):
        return None, "ambiguous_json" if len(candidates) > 1 else "invalid_json_answer"
    return candidates[0], "json_object"


def same_answer(actual, expected):
    # Avoid Python's True == 1 and silently accepted extra keys.
    if isinstance(expected, dict):
        return isinstance(actual, dict) and actual.keys() == expected.keys() and all(same_answer(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(same_answer(a, b) for a, b in zip(actual, expected))
    if isinstance(expected, bool):
        return type(actual) is bool and actual == expected
    if isinstance(expected, (int, float)):
        return finite_number(actual) and actual == expected
    return type(actual) is type(expected) and actual == expected


def grade(text, expected):
    actual, reason = json_answer(text)
    passed = actual is not None and same_answer(actual, expected)
    return {"passed": passed, "grader": "exact-json-v1", "parseStatus": reason,
            "verdict": "pass" if passed else "wrong_answer" if actual is not None else reason,
            "parsedAnswer": actual}


def normalize_usage(raw):
    if not isinstance(raw, dict):
        return {}
    result = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"):
        value = raw.get(key)
        if type(value) is int and value >= 0:
            result[key] = value
    details = raw.get("completion_tokens_details")
    if isinstance(details, dict) and type(details.get("reasoning_tokens")) is int and details["reasoning_tokens"] >= 0:
        result["reasoning_tokens"] = details["reasoning_tokens"]
    return result


def usage_cost(model, usage):
    prompt = usage.get("prompt_tokens")
    completion = usage.get("completion_tokens")
    if prompt is None or completion is None:
        return None
    hit = usage.get("prompt_cache_hit_tokens", 0)
    if hit > prompt or ("prompt_cache_miss_tokens" in usage and "prompt_cache_hit_tokens" in usage and hit + usage["prompt_cache_miss_tokens"] != prompt):
        return None
    rates = RATES[model]
    amount = (D(prompt - hit) * D(str(rates["inputUsdPer1K"])) + D(hit) * D(str(rates["cachedInputUsdPer1K"])) + D(completion) * D(str(rates["outputUsdPer1K"]))) / 1000
    return float(amount)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward authorization to another origin.
        raise SafeFailure("redirect_refused")


class DeepSeek:
    def __init__(self, key, timeout):
        self.key = key
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf8")
        request = urllib.request.Request("https://api.deepseek.com" + path, data=data, headers={
            "Authorization": "Bearer " + self.key, "Content-Type": "application/json",
        })
        def deadline(_number, _frame):
            raise SafeFailure("timeout")
        prior_handler = signal.signal(signal.SIGALRM, deadline)
        signal.setitimer(signal.ITIMER_REAL, self.timeout)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise SafeFailure("response_too_large")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise SafeFailure("invalid_response_shape")
            return value
        except urllib.error.HTTPError as error:
            # Do not read error body, headers, URL or repr(error).
            raise SafeFailure("http_" + str(int(error.code))) from None
        except (socket.timeout, TimeoutError):
            raise SafeFailure("timeout") from None
        except urllib.error.URLError as error:
            raise SafeFailure("timeout" if isinstance(error.reason, (socket.timeout, TimeoutError)) else "network_error") from None
        except (UnicodeError, ValueError):
            raise SafeFailure("invalid_response_json") from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, prior_handler)

    def balance(self):
        value = self.request("/user/balance")
        rows = value.get("balance_infos", [])
        usd = next((r for r in rows if isinstance(r, dict) and r.get("currency") == "USD"), None)
        if usd is None or type(value.get("is_available")) is not bool:
            raise SafeFailure("invalid_balance_shape")
        try:
            amount = D(str(usd["total_balance"]))
        except (KeyError, decimal.InvalidOperation):
            raise SafeFailure("invalid_balance_amount") from None
        if not amount.is_finite():
            raise SafeFailure("invalid_balance_amount")
        return {"is_available": value["is_available"], "total_balance": str(amount)}


def redact(value, key):
    if isinstance(value, str):
        return value.replace(key, "[REDACTED]") if key else value
    if isinstance(value, dict):
        return {k: redact(v, key) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, key) for v in value]
    return value


def write_json(path, value, key=""):
    # All output goes through this boundary. Atomic replacement stays in run dir.
    temporary = path.with_name(path.name + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump(redact(value, key), stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def run(args):
    if platform.system() != "Linux":
        raise SafeFailure("network_run_requires_linux")
    if args.max_output_tokens < 1 or args.max_output_tokens > 8192 or args.max_calls < 1 or args.max_calls > 24:
        raise SafeFailure("request_limits_invalid")
    if args.timeout_seconds < 1 or args.timeout_seconds > 300:
        raise SafeFailure("timeout_limit_invalid")
    budget = D(args.budget_usd)
    initial_job_balance = D(args.job_start_balance)
    if not budget.is_finite() or budget <= 0 or budget > 3 or not initial_job_balance.is_finite():
        raise SafeFailure("budget_invalid")
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key or "\n" in key or "\r" in key:
        raise SafeFailure("missing_or_invalid_deepseek_environment_key")
    suite, suite_bytes = load_suite(args.suite)
    folder = pathlib.Path(args.output).resolve()
    if folder.exists():
        raise SafeFailure("output_already_exists_use_new_run_label")
    # Validate the folder before the first account query.
    folder.mkdir(mode=0o700, parents=False)
    client = DeepSeek(key, args.timeout_seconds)
    before = client.balance()
    print(json.dumps(before), flush=True)
    manifest = {
        "suiteVersion": suite["suiteVersion"], "suiteSha256": digest(suite_bytes),
        "suiteCanonicalSha256": canonical_digest(suite),
        "runnerSha256": digest(pathlib.Path(__file__).read_bytes()), "startedAt": now_iso(),
        "models": list(MODELS), "rates": RATES, "priceProvenance": PRICE_PROVENANCE,
        "maxOutputTokens": args.max_output_tokens, "effort": args.effort, "timeoutSeconds": args.timeout_seconds,
        "maxCalls": args.max_calls, "budgetUsd": str(budget), "jobStartBalance": str(initial_job_balance),
        "balanceBefore": before, "accountUsageExclusive": args.exclusive_account,
        "splitPolicy": suite["splitPolicy"], "completionTokensIncludeReasoning": True,
        "callOrder": "calibration then holdout; alternating model order by task index; no retries",
        "network": "direct native DeepSeek chat-completions, no tools, no AgenC orchestration",
    }
    write_json(folder / "manifest.json", manifest, key)
    write_json(folder / "suite.json", suite, key)
    records = []
    reserved = D(0)
    stop_reason = "complete"
    after = before
    record_path = folder / "records.jsonl"
    try:
        with os.fdopen(os.open(record_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            for task_index, task in enumerate(suite["tasks"]):
                models = MODELS if task_index % 2 == 0 else tuple(reversed(MODELS))
                for model in models:
                    if len(records) >= args.max_calls:
                        stop_reason = "max_calls"
                        break
                    after = client.balance()
                    account_spend = max(D(0), D(before["total_balance"]) - D(after["total_balance"]))
                    job_spend = max(D(0), initial_job_balance - D(after["total_balance"]))
                    # One token per UTF-8 byte plus envelope overhead is a conservative
                    # prompt bound. Reserve twice peak quoted rates for every attempt.
                    # Unknown outcomes retain that reservation for the entire run.
                    input_bound = len((suite["systemPrompt"] + task["prompt"]).encode("utf8")) + 512
                    rates = RATES[model]
                    reserve = 2 * (D(input_bound) * D(str(rates["inputUsdPer1K"])) + D(args.max_output_tokens) * D(str(rates["outputUsdPer1K"]))) / 1000
                    if not after["is_available"] or D(after["total_balance"]) < reserve:
                        stop_reason = "no_available_credit"
                        break
                    if max(reserved, account_spend) + reserve > budget or job_spend + reserve > 20:
                        stop_reason = "spend_guard"
                        break
                    reserved += reserve
                    request_id = task["id"] + ":" + model
                    started = time.monotonic()
                    record = {
                        "requestId": request_id, "taskId": task["id"], "split": task["split"],
                        "kind": task["kind"], "complexity": task["complexity"], "model": model,
                        "promptSha256": digest(task["prompt"].encode("utf8")), "startedAt": now_iso(),
                        "inputTokenUpperBound": input_bound, "conservativeReservedCostUsd": float(reserve),
                        "answer": "", "usage": {}, "usageCostUsdAtPeakRates": None,
                    }
                    payload = {"model": model, "messages": [
                        {"role": "system", "content": suite["systemPrompt"]},
                        {"role": "user", "content": task["prompt"]}],
                        "max_tokens": args.max_output_tokens, "stream": False,
                        "thinking": {"type": "enabled"}, "reasoning_effort": args.effort}
                    try:
                        response = client.request("/chat/completions", payload)
                        choice = response.get("choices", [None])[0]
                        message = choice.get("message", {}) if isinstance(choice, dict) else {}
                        content = message.get("content") if isinstance(message, dict) else None
                        if isinstance(content, str):
                            record["answer"] = redact(content, key)
                        else:
                            record["error"] = "missing_final_answer"
                        record["finishReason"] = choice.get("finish_reason") if isinstance(choice, dict) and choice.get("finish_reason") in SAFE_FINISH_REASONS else "unknown"
                        record["usage"] = normalize_usage(response.get("usage"))
                        record["usageCostUsdAtPeakRates"] = usage_cost(model, record["usage"])
                        if isinstance(response.get("model"), str):
                            record["returnedModel"] = redact(response["model"][:160], key)
                    except SafeFailure as error:
                        record["error"] = str(error)
                    except Exception:
                        # Never stringify transport/library exceptions; they may contain a request.
                        record["error"] = "unexpected_response_error"
                    record["latencyMs"] = round((time.monotonic() - started) * 1000)
                    record["grade"] = grade(record["answer"], task["expected"])
                    records.append(record)
                    stream.write(json.dumps(redact(record, key), ensure_ascii=False, allow_nan=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                    print(json.dumps({"taskId": task["id"], "model": model,
                                      "passed": record["grade"]["passed"], "latencyMs": record["latencyMs"],
                                      "usageCostUsdAtPeakRates": record["usageCostUsdAtPeakRates"],
                                      "error": record.get("error")}), flush=True)
                if stop_reason != "complete":
                    break
    except SafeFailure as error:
        stop_reason = "balance_guard_" + str(error)
    except KeyboardInterrupt:
        stop_reason = "interrupted_inflight_reservation_retained"
    finally:
        try:
            after = client.balance()
            print(json.dumps(after), flush=True)
        except SafeFailure as error:
            manifest["balanceAfterError"] = str(error)
            after = None
        manifest.update(endedAt=now_iso(), stopReason=stop_reason, callsRecorded=len(records),
                        conservativeReservedCostUsd=float(reserved), balanceAfter=after)
        if after is not None:
            manifest["accountBalanceDeltaUsd"] = float(D(before["total_balance"]) - D(after["total_balance"]))
        write_json(folder / "manifest.json", manifest, key)
    return 0 if stop_reason == "complete" and len(records) == 24 else 2


def replay_export(args):
    folder = pathlib.Path(args.run).resolve()
    manifest = json.loads((folder / "manifest.json").read_text())
    suite, _ = load_suite(folder / "suite.json")
    if canonical_digest(suite) != manifest.get("suiteCanonicalSha256") or manifest.get("rates") != RATES:
        raise SafeFailure("suite_or_pricing_snapshot_mismatch")
    records = [json.loads(line) for line in (folder / "records.jsonl").read_text().splitlines() if line]
    lookup = {(r["taskId"], r["model"]): r for r in records}
    if len(lookup) != len(records):
        raise SafeFailure("duplicate_records")
    by_id = {t["id"]: t for t in suite["tasks"]}
    for record in records:
        task = by_id.get(record["taskId"])
        if task is None or digest(task["prompt"].encode("utf8")) != record["promptSha256"]:
            raise SafeFailure("task_prompt_hash_mismatch")
        if grade(record["answer"], task["expected"]) != record["grade"]:
            raise SafeFailure("stored_grade_mismatch")
    candidates = [{"provider": "deepseek", "model": model, "connected": True, "allowed": True,
                   "supportsToolUse": True, "supportsVision": model == "deepseek-flash", "supportsReasoning": True,
                   "contextWindow": 1048576, "maxOutputTokens": 64000, "billingSource": "byok", "cost": rates}
                  for model, rates in RATES.items()]
    outcomes = {}
    missing = []
    for task in suite["tasks"]:
        outcomes[task["id"]] = {}
        for model in MODELS:
            record = lookup.get((task["id"], model))
            if record is None or record["usageCostUsdAtPeakRates"] is None:
                missing.append(task["id"] + ":" + model)
                continue
            outcomes[task["id"]]["deepseek/" + model] = {
                "passed": record["grade"]["passed"], "costUsd": record["usageCostUsdAtPeakRates"], "latencyMs": record["latencyMs"]}
    output = {
        "provenance": "recorded-measurements", "split": "held-out", "suiteVersion": suite["suiteVersion"],
        "costBasis": "reported token usage times registry peak USD rates; not reconciled per-call charges",
        "accountBalanceDeltaUsd": manifest.get("accountBalanceDeltaUsd"), "missingOrUnpriced": missing,
        "candidates": candidates, "baselines": {"strongest": "deepseek/deepseek-v4-pro", "parent": "deepseek/deepseek-flash"},
        "tasks": [{"id": t["id"], "kind": t["kind"], "complexity": t["complexity"], "outcomeCase": t["id"]}
                  for t in suite["tasks"] if t["split"] == "holdout"],
        "outcomes": {t["id"]: outcomes[t["id"]] for t in suite["tasks"] if t["split"] == "holdout"},
    }
    write_json(folder / "recorded-measurements.json", output)
    print(json.dumps({"heldoutTasks": len(output["tasks"]), "records": len(records), "missingOrUnpriced": missing}))
    return 0 if not missing else 2


def schedule_oracle():
    durations = (3, 4, 4, 3, 5, 2, 3)
    dependencies = ((), (), (0,), (0,), (1,), (2, 3), (4, 5))
    best = None

    def visit(t, done, running, starts):
        nonlocal best
        if best is not None and t > best[0]:
            return
        ended = tuple(job for job, finish in running if finish <= t)
        done = done | frozenset(ended)
        running = tuple((job, finish) for job, finish in running if finish > t)
        if len(done) == 7:
            value = (t, starts)
            if best is None or value < best:
                best = value
            return
        ready = [j for j in range(7) if starts[j] < 0 and all(p in done for p in dependencies[j])]
        for count in range(min(2 - len(running), len(ready)) + 1):
            for chosen in itertools.combinations(ready, count):
                active = running + tuple((j, t + durations[j]) for j in chosen)
                if not active:
                    continue
                next_starts = tuple(t if j in chosen else value for j, value in enumerate(starts))
                visit(min(finish for _, finish in active), done, active, next_starts)
    visit(0, frozenset(), (), (-1,) * 7)
    return {"makespan": best[0], "starts": list(best[1])}


def self_test(args):
    suite, _ = load_suite(args.suite)
    tasks = {t["id"]: t for t in suite["tasks"]}
    # Independent combinatorial oracle for the hardest scheduling answer.
    assert schedule_oracle() == tasks["hold-hard-reasoning"]["expected"]
    assert {"minutes": [t for t in range(181) if t % 12 == 5 and t % 18 == 11]} == tasks["hold-simple-reasoning"]["expected"]
    probability = Fraction(2 * 3, math.comb(5, 2))
    assert {"numerator": probability.numerator, "denominator": probability.denominator} == tasks["cal-simple-reasoning"]["expected"]
    for task in suite["tasks"]:
        assert grade(json.dumps(task["expected"]), task["expected"])["passed"]
        assert grade("```json\n" + json.dumps(task["expected"]) + "\n```", task["expected"])["passed"]
        assert not grade("{}", task["expected"])["passed"]
    assert not grade('{"x":true}', {"x": 1})["passed"]
    assert not grade('{"x":1,"extra":2}', {"x": 1})["passed"]
    assert not grade('{"x":1} {"x":1}', {"x": 1})["passed"]
    assert grade('Answer: {"x":1}', {"x": 1})["passed"]
    assert not grade('{"x":NaN}', {"x": 1})["passed"]
    assert usage_cost("deepseek-flash", {"prompt_tokens": 1000, "completion_tokens": 1000, "reasoning_tokens": 900}) == 0.0015
    assert usage_cost("deepseek-flash", {"prompt_tokens": 1000, "completion_tokens": 1000, "prompt_cache_hit_tokens": 500}) == 0.001353
    assert usage_cost("deepseek-flash", {}) is None
    assert usage_cost("deepseek-flash", {"prompt_tokens": 1, "completion_tokens": 1, "prompt_cache_hit_tokens": 2}) is None
    assert redact({"answer": "test-secret"}, "test-secret") == {"answer": "[REDACTED]"}
    assert normalize_usage({"prompt_tokens": True, "completion_tokens": -1}) == {}
    print(json.dumps({"selfTest": "passed", "tasks": len(tasks), "networkCalls": 0,
                      "scheduleOracle": schedule_oracle()}))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    execute = sub.add_parser("run")
    execute.add_argument("--suite", default=str(DEFAULT_SUITE))
    execute.add_argument("--output", required=True)
    execute.add_argument("--job-start-balance", required=True, help="Public balance recorded before the entire xprov job")
    execute.add_argument("--budget-usd", default="3")
    execute.add_argument("--max-output-tokens", type=int, default=8192)
    execute.add_argument("--max-calls", type=int, default=24)
    execute.add_argument("--timeout-seconds", type=int, default=180)
    execute.add_argument("--effort", choices=("low", "high", "max"), default="high")
    execute.add_argument("--exclusive-account", action="store_true", help="Only if no other caller uses this key during the run")
    export = sub.add_parser("export")
    export.add_argument("--run", required=True)
    check = sub.add_parser("self-test")
    check.add_argument("--suite", default=str(DEFAULT_SUITE))
    args = parser.parse_args()
    return {"run": run, "export": replay_export, "self-test": self_test}[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SafeFailure as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
    except Exception:
        # Tracebacks from third-party/network calls can disclose authorization.
        print(json.dumps({"error": "unexpected_runner_failure"}), file=sys.stderr)
        sys.exit(2)
