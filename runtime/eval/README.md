# Agent Eval Quality Gate

> This tiny public suite and its scripted executor are legacy diagnostic smokes,
> not a private real-agent scorecard or competitive result. They cannot produce
> Trusted Fix Rate. The versioned contract is documented in
> [`../../docs/evaluation-contract-v1.md`](../../docs/evaluation-contract-v1.md).
> The separate competitive and trust-conformance definitions live under
> [`suites/`](suites/) and are documented in
> [`../../docs/evaluation-suites-v1.md`](../../docs/evaluation-suites-v1.md).

Validate those definitions without running a task or loading a provider:

```bash
npm run check:eval-suites -- --json
```

The suite layer also defines deterministic competitive/trust fault plans and
strict, separately namespaced reset/report evidence envelopes. Run them with
`npm run eval:executor -- trust-run` and `run-agent-real-batch` (see
[`../../docs/eval/real-agent-baseline-runbook.md`](../../docs/eval/real-agent-baseline-runbook.md)).

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
  --agent-command "agenc -p --output-format json {prompt}" \
  --provider xai --model grok-4 \
  --output eval/reports/grok-4.json
```

The real executor needs `AGENC_HOME` pointing at an isolated home, never your
own. Print mode has no TTY for the project-trust prompt, so the runner trusts
each temporary task workspace inside that home before the agent runs there.
`--setup-command <cmd>` (repeatable) runs in every workspace before the agent,
with the same placeholders as `--agent-command`; task-level `setupCommands`
run after it.

`eval/baseline-real-grok-4.6-xhigh.json` is the first real-agent baseline
(grok-4.6 at xhigh effort over xAI, isolated home, 2026-09-04). It is a
separate file from the mock baseline so each executor compares against its
own kind of run; `npm run eval:coding:check` compares the newest report in
`eval/reports` against it, warning on the session ratios and failing on the
pass-rate, token and latency limits.
In that run 12 of 12 command tasks passed and the session task passed 14 of
15 steps; step 15 failed only because the changelog verifier counted list
items while the agent wrote one headed section per step. The verifier now
accepts both, so the recorded 92.31% fix rate understates the run.

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

## Session tasks and harness metrics

A task with `"kind": "session"` drives one daemon session through several
prompts (`steps[]`) instead of running one agent command. It measures the loop
the desktop and TUI users actually experience: context growth, compaction,
tool errors, unnecessary re-reads and cache behaviour across a whole project,
not one patch. `asteroid-drift-15` is the first one: the 15-prompt browser game
from the September harness review, with deterministic verifiers after the
steps that matter (scaffold, style rules, module layout, features, tests,
README, final CHANGELOG and high scores) and a scripted reference solution so
the mock executor proves the checkers.

Real runs go through the AgenC SDK against a daemon in an isolated home. The
runner refuses to start a daemon in the default home:

```bash
AGENC_HOME=/absolute/isolated/home npm run eval:coding
```

The home's `config.toml` selects the model under test (the September baseline
is `grok-4.6` at `reasoning_effort = "xhigh"` over the xAI sign-in stored for
that home). Each step records wall time, token usage, stop reason, its verifier
results and a `metrics` block; the task carries the aggregate:

| metric | source | meaning |
| --- | --- | --- |
| `toolCalls`, `toolCallsByName` | live `tool_call` events | how much work each prompt took |
| `toolErrors`, `warnings` | rollout tool results and `warning` events | failed tool calls the model had to recover from |
| `fileReads`, `fileReReads` | live events | a re-read is a second read of a path with no Edit or Write in between |
| `compactions`, `compactionAttempts`, `compactionFailures`, `compactionRollbacks` | live `history_reset` plus rollout `compaction_*` records | context management pressure and its failure rate |
| `promptTokensFirst`, `promptTokensLast`, `cachedTokensLast`, `cachedTokensMax` | rollout `token_count` | context growth and prompt-cache behaviour |
| `permissionRequests` | live events | approvals the unattended run had to deny |
| `providerFailures` | rollout `execution_admission` `held_unknown` records | model turns the provider dropped after dispatch; a step that did no work because of one is an error, not a pass |
| `assistantMessages`, `assistantChars`, `reasoningOutputTokens` | live events and rollout | verbosity and reasoning spend |

`check:eval-regression` derives tool-error rate, re-read ratio, compactions per
step and cache-hit ratio from these and reports their movement against the
baseline as warnings; `--max-tool-error-rate-increase-pp`,
`--max-reread-ratio-increase-pp` and `--max-compactions-per-step-increase`
turn any of them into a hard gate.

This lane is diagnostic and non-confirmatory, like the rest of this directory;
competitive claims come from the TFR suites under `eval/suites/`.
