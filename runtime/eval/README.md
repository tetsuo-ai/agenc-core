# Agent Eval Quality Gate

Local, deterministic coding-task suite plus a regression gate over
agent-eval reports (`src/eval/agent-eval-report.schema.json`).

## Layout

- `tasks/manifest.json` — the suite manifest consumed by
  `scripts/run-agent-eval.mjs`.
- `tasks/<task-id>/fixture/` — tiny self-contained fixture repo copied into a
  throwaway temp workspace before the agent runs.
- `tasks/<task-id>/verify.mjs` — pure, deterministic checker; runs with the
  workspace as cwd and exits nonzero on failure. No network, no model calls.
- `tasks/<task-id>/solution.sh` + `solution/` — the scripted "mock executor"
  answer used to test the harness itself (and to prove each checker can pass).
- `baseline-report.json` — the committed baseline the regression gate compares
  against.
- `reports/` — gitignored output directory for fresh runs.

## Running the suite

Mock executor (no API keys; applies each task's committed `solution.sh`):

```bash
npm run eval:agent -- --suite eval/tasks --executor mock --output eval/reports/mock.json
```

Real agent (headless CLI; the command receives `{prompt}` already shell-quoted):

```bash
npm run eval:agent -- --suite eval/tasks \
  --agent-command "agenc -p {prompt} --output-format json" \
  --provider xai --model grok-4 \
  --output eval/reports/grok-4.json
```

Model/config matrix (one schema-valid report per entry):

```bash
npm run eval:agent -- --suite eval/tasks --config eval/eval-config.example.json --output-dir eval/reports
```

Every report embeds the git SHA (`run.environment.commit`), the executor mode,
and a `configFingerprint` (sha256 over the benchmark, executor, agent command,
agent identity, and the normalized task list) so runs are only compared
like-for-like.

## Regression gate

```bash
npm run check:eval-regression                      # newest eval/reports/*.json vs baseline
npm run check:eval-regression -- eval/reports/grok-4.json
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

## Baseline refresh procedure

1. Run the suite with the executor/config you gate on (compare like with
   like — do not gate real-model runs against a mock baseline or vice versa):
   `npm run eval:agent -- --suite eval/tasks --executor mock --run-id baseline-<date> --output eval/reports/candidate.json`
2. Inspect it: `npm run check:agent-eval-report -- eval/reports/candidate.json`
   and confirm the pass/cost/latency numbers are an intentional new floor.
3. Diff against the old baseline:
   `npm run check:eval-regression -- eval/reports/candidate.json`
4. Promote it: `cp eval/reports/candidate.json eval/baseline-report.json`
5. Commit `eval/baseline-report.json` with a note explaining why the floor
   moved (new tasks, new model, accepted cost increase, ...).

## Adding a task

Keep fixtures tiny (a few files). Each task needs: a `fixture/` dir, a prompt
in `manifest.json`, a pure `verify.mjs` (programmatic pass/fail, no network),
and a scripted `solution.sh` so the mock executor and the harness tests can
prove the checker passes after the intended change (and fails without it —
`tests/eval/agent-eval-suite.test.ts` checks a no-op solution yields
`failed`). After adding a task, refresh the baseline (above).
