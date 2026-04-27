# Runtime Persistence Compatibility Gate

This document freezes the live persistence and replay contract for the
runtime replacement work in `agenc-core/runtime/src/session/*`.

The goal in this wave is not to redesign persistence. The goal is to
name the current contract, pin it with tests, and block accidental drift
while runtime ownership moves from the hybrid AgenC path to the AgenC runtime
runtime port.

## Scope

The frozen surface is the current on-disk session state:

- `rollout-<timestamp>-<sessionId>.jsonl`
- `rollout-<timestamp>-<sessionId>.jsonl.lock`
- `index.json`

It also covers the replay rules implemented by:

- `session-store.ts`
- `rollout-reconstruction.ts`
- `event-log-reducer.ts`
- `plan-mode.ts` only where its emitted events affect replay

## Versioning

Two version markers exist today and they do different jobs:

### `rolloutSchemaVersion`

- Stored on `session_meta` rows.
- Current value: `1`.
- Checked only from the first `session_meta` line during store open.
- This is the only hard compatibility gate today.

### `eventVersion`

- Stored per `RolloutItem` row.
- Current value: `1`.
- Stamped on serialization when omitted.
- Current readers do not reject rows based on `eventVersion`.
- Its live role today is row-shape provenance and forward-compat
  bookkeeping, not open-time gating.

## Replay-authoritative rows and events

The append-only rollout JSONL file is authoritative. `index.json` is
not.

### Authoritative rows

- `session_meta`
  - authoritative for schema gating and session metadata rows
- `response_item`
  - authoritative for replayed conversation history
- `compacted`
  - authoritative for compaction boundaries and replacement history
- `turn_context`
  - authoritative for replayed turn baseline and previous-turn settings
- `event_msg`
  - authoritative for replayed structural events
- `session_state`
  - authoritative for persisted session-scoped mutable slots

### Non-authoritative snapshot

`index.json` is a best-effort acceleration sidecar:

- `toolResultBytesByTurn`
- `toolCallTurnIds`
- `offsetsBySeq`
- `snapshotSequenceNumber`

Current contract:

- replay never requires `index.json`
- rollout reconstruction does not rebuild history from `index.json`
- a stale snapshot is ignored and surfaced as
  `warning:snapshot_behind_rollout`
- a fresh snapshot may be consumed as metadata, but rollout rows remain
  the source of truth

## Mixed-history rules

Mixed history is already supported and is now frozen as-is.

### Mixed schema history

- A rollout whose header `rolloutSchemaVersion` is lower than the
  runtime version is accepted.
- Opening such a rollout does not perform an eager rewrite or migration
  pass.
- New rows may therefore be appended to an existing file whose first
  `session_meta` row still carries an older schema number.

### Mixed compaction history

- The newest surviving `compacted.replacementHistory` found by the
  reverse scan becomes the replay baseline.
- Older history before that boundary is no longer authoritative for
  replayed conversation state.
- Forward replay still applies the suffix after that compaction
  boundary.

### Legacy compaction rows

- A `compacted` row without `replacementHistory` is still valid.
- Replay rebuilds history from surviving real user messages plus the
  compaction summary.
- That legacy rebuild clears the replay reference context item.

### Contextual user injections are not user-turn boundaries

The following are persisted but must not count as rollback/reverse-scan
user-turn boundaries:

- tool-role response items
- user-role tool result / function output payloads
- contextual injected user text such as `<environment_context>...`

### Mixed event generations

- Legacy embedded event aliases are accepted on read:
  - `task_started` -> `turn_started`
  - `task_complete` -> `turn_complete`
- Unknown top-level rollout row types are wrapped as
  `{ type: "unknown" }` and skipped by replay.
- Known `event_msg` rows whose inner event type is not replay-relevant
  are tolerated as telemetry and do not mutate reconstructed history.
- Persisted plan-mode events currently fall into that bucket:
  - `plan_started`
  - `plan_delta`
  - `plan_item_completed`
  - `plan_exited`

## Reject vs upgrade policy

The current policy is intentionally narrow:

### Reject

Reject opening a rollout when:

- the first `session_meta.rolloutSchemaVersion` is greater than
  `ROLLOUT_SCHEMA_VERSION`

Current failure mode:

- throw `SchemaMismatchError`
- message instructs the operator to use `/fork` or upgrade the runtime

### Accept without migration

Accept opening a rollout when:

- the header schema version is equal to the runtime version
- the header schema version is lower than the runtime version

Current accept behavior:

- no full-file migration
- no eager header rewrite on open
- no snapshot-authoritative reconstruction
- no row rejection based on `eventVersion`

### Upgrade

There is no automatic persistence upgrade pass today.

What exists instead:

- fresh rollouts stamp the current `rolloutSchemaVersion`
- serialized rows stamp the current `eventVersion`
- replay tolerates mixed old/new rows according to the rules above

If the runtime later grows a real migration path, that is a new
contract and must land with an explicit schema-policy update and new
tests.

## Frozen before runtime ownership moves

The following behavior is frozen for the runtime replacement:

1. Rollout JSONL is the replay authority; `index.json` is hint-only.
2. The compatibility gate rejects only forward header-schema mismatch.
3. Older schema headers are accepted without eager migration.
4. Reverse-scan chooses the newest surviving replacement history.
5. Legacy compaction without replacement history rebuilds from user
   messages plus summary.
6. Contextual user injections and tool-result rows do not count as
   user-turn boundaries.
7. Unknown top-level rollout variants are skipped, not fatal.
8. Persisted plan-mode event rows are tolerated during replay and do
   not mutate reduced session history.

Anything that changes one of those rules is not a refactor. It is a
persistence contract change and requires:

- a schema/versioning decision
- an explicit doc update here
- new compatibility coverage
