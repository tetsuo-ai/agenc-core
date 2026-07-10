# Trajectory training data — export & curate

Turn real AgenC sessions into local training data in three steps: enable the
export sink, run sessions, curate with `agenc trajectories export`. Everything
is local file processing; nothing leaves the machine.

## 1. Enable the export sink

The runtime ships an opt-in, per-session trajectory export sink
(`runtime/src/session/trajectory-export.ts`). It mirrors every rollout row —
messages, tool calls, turn lifecycle events — to an append-only JSONL file,
redacting secrets (`redactSecretsInValue`) at write time.

```bash
# one file per session under this directory (recommended):
export AGENC_TRAJECTORY_EXPORT_DIR=~/agenc-trajectories

# — or — append every session to a single file:
export AGENC_TRAJECTORY_EXPORT_PATH=~/agenc-trajectories/all.jsonl
```

Each line is a `TrajectoryExportRecord`:

```json
{"schemaVersion": 1, "exportedAtUnixMs": 0, "sessionId": "…", "rolloutPath": "…", "item": { "type": "response_item", "payload": { … } }}
```

Unset the variables to disable the sink. Files are created `0600`.

## 2. Run sessions

Use AgenC normally. Every session started while the env var is set is exported
as it runs — interactive TUI, headless `agenc -p`, background agents, and
gateway-backed channel turns that write the same rollout store.

## 3. Curate

```bash
# chat-format SFT JSONL to stdout (reads $AGENC_TRAJECTORY_EXPORT_DIR):
agenc trajectories export --format sft --out sft.jsonl

# preference pairs:
agenc trajectories export --format dpo --dir ~/agenc-trajectories --out dpo.jsonl
```

### Filtering

Only trajectories that ended well are kept:

- at least one completed turn (`turn_complete`),
- no terminal `error` event (transient `stream_error`s the session recovered
  from do not disqualify it),
- no abort/interrupt (`turn_aborted` — covers Esc and cancellations),
- no user tool-use rejection markers in the persisted messages,
- for SFT additionally no thread rollback (a rollback is an explicit user
  rejection of part of the trajectory; those sessions feed DPO).

There is no `--require-eval-passed` filter: exported records carry no
evaluation outcome field, so there is nothing to gate on. Pair trajectory
export with the local eval suite ([`agent-eval-reports.md`](agent-eval-reports.md))
when you need quality labels; keep the two pipelines separate.

### Redaction

Rows are passed through the same `redactSecretsInValue` pass the sink applies
at write time, so exports produced by older builds still come out redacted.

### Formats

`--format sft` — one conversation per line in standard chat schema. History is
rebuilt with the canonical event-log reducer, so compactions apply exactly as
the model saw them:

```json
{"messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…", "tool_calls": [{"id": "…", "type": "function", "function": {"name": "…", "arguments": "…"}}]}, {"role": "tool", "content": "…", "tool_call_id": "…", "name": "…"}], "meta": {"sessionId": "…"}}
```

`--format dpo` — honest preference pairs derived from `thread_rolled_back`
regenerations: when a user rewinds a turn and re-runs the **same** prompt, the
append-only export keeps both the discarded continuation (rejected) and the
kept one (chosen) from an identical prefix. Pairs are emitted only when the
prefix survived unchanged, both sides re-open with an identical user prompt,
and both contain assistant output — anything weaker is skipped, never
fabricated. If no such regenerations exist, the command exits with an error
explaining what is missing:

```json
{"prompt": [{"role": "user", "content": "…"}], "chosen": [{"role": "assistant", "content": "…"}], "rejected": [{"role": "assistant", "content": "…"}], "meta": {"sessionId": "…"}}
```

## Follow-ups (not covered here)

A distillation runbook (training on the emitted JSONL) and an eval-comparison
script for before/after models are tracked separately on the product roadmap
([`roadmap.md`](roadmap.md)).
