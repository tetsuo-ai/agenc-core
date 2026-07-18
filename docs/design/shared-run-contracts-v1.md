# Shared run/budget/effect/event contracts (Wave B freeze)

Status: FROZEN v1 — the schema contract M3 (admission kernel), M4 (durable
journal/replay), and M5 (verified-change workflow) implement against.
Types live in `runtime/src/contracts/run-contracts.ts`. This document names
the exact existing seams each piece attaches to, per the roadmap rule:
extend and converge the existing machinery; do not start a second engine.

## Why now

Wave B fans implementation out across M3/M4/M5. Without one frozen schema,
each branch invents its own run identity, hold shape, and event cursor, and
the merge serializer spends its life reconciling them. This freeze is the
"small contract PR" the execution order requires.

## 1. Run identity

- `RunId` = the root agent id (= root `ManagedThread.threadId`), which is
  already the primary key of the durable `agent_runs` table
  (`runtime/src/state/agent-runs.ts`). No new id namespace.
- Subordinate ids (daemon sessionId, rollout conv-id, per-turn streamId, the
  eval executor's runId) map to a RunId through attachment records; they are
  never a substitute.
- `RunTerminalResult` is the durable record every run must produce; today the
  terminal outcome exists only as a client-side fold over streamed events
  (`daemonOneShotFinalStatus`, SDK `terminalStatusFromNotification`) and is
  unrecoverable after a disconnect. M4/M5 persist it on the existing
  `#recordAgentStatusTransition` write path in
  `runtime/src/app-server/background-agent-runner.ts` and serve it via
  `run.result`.
- Reserved daemon methods (`run.status`, `run.result`, `run.replay`,
  `run.evidence`, `run.cancel`) are added to `AGENC_DAEMON_METHODS` +
  dispatcher routing as they land; names are frozen here.

## 2. Admission + budget reservations (M3)

Attaches to the EXISTING `runtime/src/budget` engine (`BudgetEnforcer.admit`
/ `reconcile`, `BudgetLedger`), not a new one:

- `AdmissionRequest`/`AdmissionDecision` generalize today's
  `AdmitRequest`/`AdmitResult` with: step identity, `kind`
  (`model_turn | tool_exec | spawn`), and the `allow | queue | deny |
  approval_required` decision vocabulary.
- `BudgetReservation` adds what today's `BudgetHold` lacks: a durable
  `reservationId` (the idempotency key for exactly-once reconcile) and
  persistence. Holds move from in-memory to the state SQLite (pattern:
  `runtime/src/state/csv-agent-jobs.ts`), so a crash between reserve and
  reconcile is recoverable instead of a stranded debit. The ledger lockfile's
  fail-open path is retired in the same change.
- Resolution vocabulary: `reconciled | voided | held_unknown`. Unknown usage
  consumes its full reservation until recorded policy releases it.
- One shared enforcer instance is constructed at daemon bootstrap and
  injected into the three existing consumers (`gateway/hooks.ts`,
  `gateway/cron-delivery.ts`, `heartbeat/wire.ts`) and the two missing
  surfaces: the per-LLM-call site in `agents/run-agent.ts` (the merged
  AbortController seam) and tool execution (`ToolUseContext` already carries
  `maxBudgetUsd`).
- Hierarchy keys off the durable spawn tree
  (`runtime/src/state/spawn-edges.ts` + `agents/control.ts`
  parent/descendant walks). Child reservations are conserved within the
  parent's remaining allocation.
- Bounded concurrency + the persistent queue generalize the ONLY bounded
  dispatcher that exists (`agents/jobs/job-orchestrator.ts` clampConcurrency
  + SQLite mirroring); `AgentRegistry.reserveSpawnSlot`'s intentionally
  uncapped count gains a real capacity check inside the existing slotLock.
- Cancellation reuses `control.interrupt`'s descendant cascade as the single
  propagation primitive; a cancel voids the step's reservation in the same
  transaction that records it.

## 3. Effects (M4)

- Classification stays the enforced `ToolRecoveryCategory`
  (`idempotent | side-effecting | interactive`); this contract adds OUTCOME
  states only: `committed | failed | cancelled | unknown_outcome`.
- `unknown_outcome` bridges what already exists in two places — the
  `poisoned` status in `state/recovery.ts` and `mustHalt` classification in
  `session/durable-turns.ts` — into journal events
  (`effect_intent` / `effect_result` / `effect_unknown_outcome`) whose names
  align with the eval contract's `effect.unknown_outcome`, so live runtime
  and eval evidence share one vocabulary.
- Idempotent effects carry a durable `idempotencyKey`; retry happens only
  when the operation contract proves it safe. Exactly-once is never claimed
  for arbitrary shell/network effects.

## 4. Events and cursors (M4)

- The journal is the EXISTING per-session rollout (SessionStore flock +
  O_APPEND + fsync + truncateCorruptTail) extended with the new event
  variants — not a parallel store. New `EventMsg` variants are additive
  (I-26 unknown-variant shim keeps forward compat).
- The protocol's already-declared `AgenCEventBaseParams.sequence` becomes
  populated-in-effect for run events (producer: `eventBaseParams` in
  `background-agent-runner.ts`), backed by the run journal's monotonic
  counter (durable across restart via the existing `seedLastSeq`).
- Cursor replay (`RunEventCursor`) serves from the existing
  `thread_rollout_items` mirror (`state/threads.ts` already stores
  event_seq/event_id/byte_offset/line_hash) — a query API, not a new store.
- Retention gaps become explicit: everywhere the multiplexer today silently
  splices (`client-multiplexer.ts` bufferSessionEvent /
  evictBufferedEventsByBytes), an `event_gap` marker with
  `RunEventGap` semantics is delivered instead. The eval evidence-ledger's
  contiguous-sequence enforcement is the reference semantics.

## 5. What implementations may NOT do

- Introduce a new id namespace for runs, or key anything on sessionId where
  RunId is available.
- Add a second budget engine, admission path, journal writer, or task
  orchestrator. (The two existing budget systems converge on the extended
  `runtime/src/budget`; the post-hoc background-agent check becomes
  reserve + reconcile.)
- Refund `held_unknown` reservations implicitly, auto-replay a
  `side-effecting` effect, or drop events without an `event_gap` marker.
- Ship a `run.*` method whose name or core shape differs from the frozen
  vocabulary without a contract-change PR.
