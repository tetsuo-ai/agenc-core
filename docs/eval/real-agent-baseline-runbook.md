# Real-agent baseline runbook

How an authorized operator reproduces the full real-agent report from pinned
inputs (M1). One command per batch; resumable; no secrets on any argv.

## Prerequisites

- docker, Node from `devEngines` (`.nvmrc`-compatible ≥ 25.9.0).
- A staged agent overlay directory (see
  `docs/design/eval-pilot-executor-phase2b-egress.md`): `node/` (portable Node
  dist + `node/compat/libatomic.so.1`), `runtime/` (extracted runtime tarball
  — pin the CURRENT release, the overlay attests the build under test),
  `mock/`, `proxy/`.
- A provider key source: either a static key exported in the executor's env,
  or an executable that prints a fresh key (for OAuth-token providers).

## The command

```bash
node --experimental-strip-types runtime/src/eval-executor/cli.ts \
  run-agent-real-batch \
  --overlay /path/to/agent-overlay \
  --provider-host api.x.ai \
  --provider-base-url https://api.x.ai/v1 \
  --provider-model grok-4.5 \
  --key-command /path/to/print-fresh-key \
  --output /path/to/baseline-output \
  --agent-timeout-ms 1800000
```

(`npx tsx` works equally; run from `runtime/`.)

- Tasks default to every task in the frozen pilot source lock, in lock order;
  `--tasks id1,id2,...` selects and orders an explicit subset.
- `--key-command` runs before each task (execFile, no shell); its stdout
  becomes the key via the `--key-env-var` name (default
  `OPENAI_COMPATIBLE_API_KEY`). For a static key, omit `--key-command` and
  export the env var instead. The key travels executor env → `docker exec -e`
  → agent process; it is never on an argv and patches are scanned for it.
- Resume after an interruption by re-running the same command: tasks with an
  existing `agent-run-report.json` are skipped.
- Exit code 0 means every task ended with a report (the scorecard is
  complete); any driver-level loss exits 1 and is listed in
  `batch-summary.json`.

## Outputs

Under `--output`:

- `<taskId>/agent-run-report.json` — outcome, containment probes, key scan,
  token usage, report digest (the append-only raw evidence).
- `<taskId>/agent-patch.diff`, `<taskId>/agent-result.json`.
- `batch-progress.log` — timestamped per-task progress.
- `batch-summary.json` — per-task status + aggregate counts (VFR numerator is
  `verifiedFixes`).

Archive the whole output directory as the raw evidence bundle; the
human-readable summary (like `docs/eval/seed-baseline-2026-07-17.md`) is
written separately and references it.
