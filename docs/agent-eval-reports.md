# Agent Evaluation Reports

AgenC records local SWE-style evaluation results in a checked JSON shape and
summarizes them without remote CI, hosted model APIs, or benchmark-specific
infrastructure.

This doc covers the **report schema + validator**, the **local coding-task
suite**, and the **regression gate**. Implementation detail for the suite
layout also lives in [`runtime/eval/README.md`](../runtime/eval/README.md)
(see also that file for task-authoring conventions).

All npm scripts below live on the `@tetsuo-ai/runtime` workspace:

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- …
npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- …
npm --workspace=@tetsuo-ai/runtime run check:eval-regression -- …
```

(There is no root-level `check:eval-regression` alias.)

## Schema

```text
runtime/src/eval/agent-eval-report.schema.json
```

Validate and summarize a report:

```bash
npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- path/to/report.json
```

Print a machine-readable summary:

```bash
npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- path/to/report.json --json
```

The script computes attempted-task fix rate from
`passed / (passed + failed + error)`, excluding skipped tasks. Verifier pass
rate uses the same skipped-task exclusion. `riskFlags` are free-form strings so
local harnesses can record benchmark-leakage, verifier-modification,
deleted-test, network-use, or other shortcut-detection signals as they become
relevant.

## Ad-hoc runner (manifest → report)

Run a local task manifest and emit a report:

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
  --tasks path/to/tasks.json \
  --output path/to/report.json \
  --agent-command 'agenc --output-format json {prompt}'
```

Minimal manifest:

```json
{
  "benchmark": "local-smoke",
  "tasks": [
    {
      "id": "task-001",
      "prompt": "Fix the failing test.",
      "verifiers": [
        {
          "name": "unit-tests",
          "command": "npm test"
        }
      ]
    }
  ]
}
```

Task-level `agentCommand` overrides the manifest or CLI `--agent-command`.
Commands run locally with placeholders `{prompt}`, `{promptJson}`, `{taskId}`,
and `{cwd}` shell-quoted into the command string. The runner records command
exit codes, verifier status, token usage when structured agent stdout exposes
`tokenUsage` or `usage`, and validates the generated report against the schema.

## Local coding-task suite (`runtime/eval/`)

The quality-gate suite is a deterministic coding-task harness plus a regression
comparison against a committed baseline.

| Path | Role |
| --- | --- |
| `runtime/eval/tasks/manifest.json` | Suite manifest consumed by `scripts/run-agent-eval.mjs` |
| `runtime/eval/tasks/<task-id>/fixture/` | Tiny self-contained fixture repo copied into a temp workspace |
| `runtime/eval/tasks/<task-id>/verify.mjs` | Pure deterministic checker (cwd = workspace; exit nonzero on fail; no network) |
| `runtime/eval/tasks/<task-id>/solution.sh` + `solution/` | Scripted "mock executor" answer (proves checkers can pass) |
| `runtime/eval/baseline-report.json` | Committed baseline the regression gate compares against |
| `runtime/eval/reports/` | Gitignored output directory for fresh runs |
| `runtime/eval/eval-config.example.json` | Example model/config matrix |

### Mock executor (no API keys)

Applies each task's committed `solution.sh`:

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
  --suite eval/tasks --executor mock --output eval/reports/mock.json
```

(Run with cwd `runtime/`, or adjust paths relative to that workspace.)

### Real agent (headless CLI)

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
  --suite eval/tasks \
  --agent-command "agenc -p {prompt} --output-format json" \
  --provider xai --model grok-4 \
  --output eval/reports/grok-4.json
```

### Model / config matrix

One schema-valid report per entry:

```bash
npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
  --suite eval/tasks \
  --config eval/eval-config.example.json \
  --output-dir eval/reports
```

Every report embeds the git SHA (`run.environment.commit`), the executor mode,
and a `configFingerprint` (sha256 over the benchmark, executor, agent command,
agent identity, and the normalized task list) so runs are only compared
like-for-like.

## Regression gate

```bash
# From the runtime workspace (cwd or via --workspace):
npm --workspace=@tetsuo-ai/runtime run check:eval-regression
# → newest eval/reports/*.json vs baseline-report.json

npm --workspace=@tetsuo-ai/runtime run check:eval-regression -- eval/reports/grok-4.json
```

Exits nonzero when the candidate regresses beyond thresholds. Defaults:

| Metric | Definition | Default threshold |
| --- | --- | --- |
| Pass rate | passed / attempted (skipped excluded) | any drop > 0pp fails |
| Cost | avg tokens per attempted task | > +20% fails |
| Latency | avg duration per attempted task | > +50% fails |

Override with `--max-pass-rate-drop <pp>`, `--max-token-increase-pct <pct>`,
`--max-latency-increase-pct <pct>`. A config-fingerprint mismatch is a warning
by default; add `--require-same-config` to make it a failure. Zero attempted
tasks always fails.

Anything that changes the turn loop, prompts, or tools should keep this gate
green before landing.

## Baseline refresh procedure

1. Run the suite with the executor/config you gate on (compare like with like
   — do not gate real-model runs against a mock baseline or vice versa):

   ```bash
   npm --workspace=@tetsuo-ai/runtime run eval:agent -- \
     --suite eval/tasks --executor mock \
     --run-id baseline-<date> \
     --output eval/reports/candidate.json
   ```

2. Inspect it:

   ```bash
   npm --workspace=@tetsuo-ai/runtime run check:agent-eval-report -- eval/reports/candidate.json
   ```

   Confirm the pass / cost / latency numbers are an intentional new floor.

3. Diff against the old baseline:

   ```bash
   npm --workspace=@tetsuo-ai/runtime run check:eval-regression -- eval/reports/candidate.json
   ```

4. Promote it:

   ```bash
   cp runtime/eval/reports/candidate.json runtime/eval/baseline-report.json
   ```

5. Commit `runtime/eval/baseline-report.json` with a note explaining why the
   floor moved (new tasks, new model, accepted cost increase, …).

## Adding a task

Keep fixtures tiny (a few files). Each task needs: a `fixture/` dir, a prompt
in `manifest.json`, a pure `verify.mjs` (programmatic pass/fail, no network),
and a scripted `solution.sh` so the mock executor and the harness tests can
prove the checker passes after the intended change (and fails without it —
`runtime/tests/eval/agent-eval-suite.test.ts` checks a no-op solution yields
`failed`). After adding a task, refresh the baseline (above).

## Minimal report shape

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "local-2026-06-14",
    "benchmark": "swe-style-local-smoke",
    "startedAt": "2026-06-14T12:00:00Z",
    "finishedAt": "2026-06-14T12:05:00Z",
    "agent": {
      "name": "agenc",
      "provider": "local",
      "model": "vllm-compatible"
    },
    "environment": {
      "repo": "tetsuo-ai/agenc-core",
      "commit": "abc123",
      "branch": "main",
      "runner": "local",
      "sandbox": "workspace",
      "localOnly": true
    }
  },
  "tasks": [
    {
      "id": "task-001",
      "status": "passed",
      "durationMs": 120000,
      "tokens": {
        "input": 12000,
        "output": 3000
      },
      "commands": [
        {
          "command": "npm test",
          "exitCode": 0,
          "durationMs": 60000
        }
      ],
      "verifiers": [
        {
          "name": "unit-tests",
          "status": "passed",
          "command": "npm test"
        }
      ],
      "patch": {
        "changedFiles": 2,
        "additions": 40,
        "deletions": 10
      }
    }
  ]
}
```

## Related

- Suite author notes: [`runtime/eval/README.md`](../runtime/eval/README.md)
- Trajectory export for training data: [`trajectory-training-data.md`](trajectory-training-data.md)
- Agent surface contract gate (root): `npm run check:agent-surface-contract`
