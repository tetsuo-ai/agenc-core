# Measured DeepSeek provider-selection evaluation

This directory contains a fixed known-answer suite and a replay of native DeepSeek measurements. It measures answer correctness, reported token usage and call latency. It does not measure sub-agent tool use, daemon recovery, cross-provider credentials or competing commercial routers.

The suite has twelve tasks. Calibration and holdout each contain one simple and one hard task for extraction, coding and reasoning. Both `deepseek-flash` and `deepseek-v4-pro` receive every identical prompt once. Model order alternates by task, reasoning effort is `high`, and each request is capped at 8192 output tokens, including reasoning. There are no retries. The task split, expected answers and labels were fixed before provider calls.

Expected answers have deterministic JSON graders. Object key order is ignored; array order, all values and keys must match. Booleans do not equal numbers. Expected answers are never sent to the provider. No model-supplied code is executed. The seven-job scheduling task has a capacity lower bound and an independent exhaustive oracle. The JavaScript microtask answer was verified using the authored program on Node 26.8.1 before calls.

## Files

- `live-eval-tasks.json`: fixed prompts, split, labels, expected answers and verification notes.
- `live-eval.py`: Linux-only live runner, exact grader, offline self-test and measured-matrix exporter.
- `test-live-eval.py`: eleven offline harness tests with mock API responses. Mock responses are not benchmark evidence.
- `live-eval-replay.mjs`: imports the actual Core selector and classifier for measured replay. It does not write the installation's routing-outcome store.

## Offline verification

From this directory:

```sh
python3 live-eval.py self-test
python3 test-live-eval.py
```

The self-test verifies the scheduling optimum and grader behavior without network access. Harness tests check identical prompts, alternating order, held-out export, malformed usage, input structure, conservative budget admission, retained timeout reservations, interruptions, duplicate-run refusal, Mac network refusal and frozen-answer integrity.

## Paid collection on Linux

Provide `DEEPSEEK_API_KEY` only in the process environment. Do not put credentials in arguments, files or logs. Network execution refuses non-Linux platforms before reading that environment variable. Root must record the whole job's initial public balance and choose a fresh output folder.

```sh
python3 live-eval.py run \
  --output /path/to/new-run-folder \
  --job-start-balance <recorded-initial-job-balance> \
  --budget-usd 3 \
  --max-output-tokens 8192 \
  --max-calls 24 \
  --effort high
```

The harness has a $3 per-run ceiling and a $20 total-job balance guard. Before each request it reserves twice the registry peak price of the requested maximum output plus a conservative input bound. All attempts retain that reservation for the entire run, including unknown outcomes. Balance failures stop new calls. Each request has a 180-second wall clock deadline, and redirects are refused.

Use `--exclusive-account` only when no other caller uses the key during collection. It labels attribution and does not lock the account. A zero exit code means 24 attempts were recorded, not that all answers passed. Partial runs preserve their evidence and return a nonzero exit code. The runner refuses to overwrite an existing run folder.

Only final answers, normalized usage, timings, task/request IDs and sanitized error codes are retained. Provider reasoning text, request headers, raw error bodies and credentials are excluded. The manifest records task and runner hashes, prices, limits and balance before and after.

## Prices and cost interpretation

Prices are captured from the native registry snapshot identified in `PRICE_PROVENANCE`. They are the published peak rates verified in Core on 2026-09-11:

| Model | Uncached input / million | Cached input / million | Output / million |
| --- | ---: | ---: | ---: |
| deepseek-flash | $0.30 | $0.006 | $1.20 |
| deepseek-v4-pro | $1.32 | $0.044 | $3.96 |

`usageCostUsdAtPeakRates` is a reported-token cost estimate, not a reconciled per-call charge. Off-peak billing can be lower. Account balances can be rounded and affected by concurrent callers. Missing usage stays unknown, not zero. Completion tokens already include reasoning; reasoning tokens are never billed twice by the grader.

## Replay

Revalidate stored task hashes and exact grades, then export the held-out matrix:

```sh
python3 live-eval.py export --run /path/to/run-folder
```

From the Core repository root, import the selector directly and replay recorded outcomes:

```sh
node_modules/.bin/tsx runtime/eval/provider-selector-live/live-eval-replay.mjs \
  . /path/to/run-folder
```

The replay writes `selector-replay.json` and `selector-replay.md`, recording selector and profile source hashes. It compares cold-start selection, selection calibrated only from the six calibration tasks, current text classification plus selection, always Pro, always cheapest and fixed Flash. Calibration quality uses independent JSON verifier results, not merely completion. Calibration cost learning is omitted because per-call dollars are not reconciled.

`selector` and `selector_calibrated` use the predeclared human task kind and complexity. `selector_classified` uses the runtime text classifier. All strategies use the identical measured holdout outcome matrix, actual pre-call input bounds, the fixed output cap and no tools. Passes per estimated dollar remains unknown if selected observations or usage costs are missing. Sum of call latency is not parallel-agent wall time.

The exported `recorded-measurements.json` also works with `runtime/scripts/eval-child-provider-selection.ts`. That older replay helper uses standardized 2000-input/500-output estimates and tool support, so name the replay used when quoting numbers.

## Limits

Six held-out tasks and one completion per model are diagnostic evidence, not a market-wide benchmark. The predeclared Pro baseline is called strongest for comparison; this does not assume it wins every task. Both models may pass, leaving a selector that chooses Pro more expensive than fixed Flash. Report such losses plainly.

Held-out means excluded from calibration, not externally sealed or third-party authored. Do not tune model profiles or task labels after seeing these results and still claim the same tasks as unseen holdout. Subsequent tuning needs new held-out tasks. Only DeepSeek was called live.
