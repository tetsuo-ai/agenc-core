# run.cancel cascade + spawn admission gate (M3 final slice)

> **Historical implementation slice.** References below to JSON-ledger
> `BudgetLedger` holds describe the pre-M3 path. Production cancellation and
> reservation transitions now run through the durable
> [`ExecutionAdmissionKernel`](execution-admission-kernel.md).

Status: DESIGN — implements the last red trust-conformance family
(`cancel-parent-after-child-admission`: `descendant_admission_stopped`,
`queued_and_running_descendants_cancelled`). Builds against the frozen
Wave-B contract (`runtime/src/contracts/run-contracts.ts`,
`docs/design/shared-run-contracts-v1.md`); the reserved method name
`run.cancel` ("Tree-scoped cancel: parent + queued + running descendants")
and the `allow | queue | deny | approval_required` admission vocabulary are
binding. Extends existing seams; no second engine.

## 1. The gap (verified against main @ 65c2d457f)

- No production path writes `agent_runs.status = 'cancelled'`; the sole
  production status writer is `recordAgentStatusTransition` →
  `updateAgentRunStatus` (`state/snapshot-policy.ts:369`,
  `agentRunStatusForTransition` has no `cancelled` arm).
- The live interrupt cascade exists (`agents/control.ts:913` `interrupt`
  recurses over `descendantsOf`; `background-agent-runner.ts:1977`
  `interruptAgentTurn` cascades over `openThreadSpawnChildren`) but is
  in-memory only and `interrupted` is deliberately non-final. Nothing
  durable cascades; a crash forgets the cancel ever happened below the
  parent row.
- Startup recovery resurrects survivors: `loadRecoverableAgentRuns`
  (`state/recovery.ts:156`) selects non-terminal runs FLAT — it never joins
  `thread_spawn_edges` or checks ancestor status, and the restore loop
  (`daemon-cli.ts:2455` `hydrateAgenCDaemonStartupRecovery`) calls
  `restoreAgent` per run with no parent-cancelled guard.
- Nothing refuses new admission under a cancelled parent. The durable
  admission commit point for the spawn tree is
  `ThreadSpawnEdgeRepository.create` (`state/spawn-edges.ts:34`) — the
  production spawn path commits through it
  (`control.ts:1789 persistThreadSpawnEdgeForSource` →
  `rollout-store.ts:152 createThreadSpawnEdge` → the SQLite repo; the JSON
  file is legacy-import-only since `loadThreadSpawnEdges`).
- `run.cancel` is absent from `AGENC_DAEMON_METHODS` and the dispatcher.

## 2. Design

### 2.1 New state module: `runtime/src/state/run-cancellation.ts`

Pattern-follows `state/unknown-outcome-gate.ts` (fail-closed check + typed
`*BlockedError` with a `code` literal at the durable commit point; `"flag"`
style opt-outs only where a caller demonstrably cannot refuse).

Vocabulary:

- `CANCEL_LOCKED_AGENT_RUN_STATUSES = ["cancelled", "unknown_outcome"]` —
  the review/cancel-locked statuses. NOT all terminal statuses: a
  `completed` background agent is legitimately revived by a follow-up
  message (the snapshot writer always records `running`,
  `agent-lifecycle.ts:2048`), so blanket terminal-stickiness would break a
  real flow. `cancelled` is an explicit human decision; `unknown_outcome`
  is review-locked by M4 semantics. Both are sticky.

API:

- `checkSpawnAdmissionGate(driver, { parentThreadId }): SpawnAdmissionDecision`
  — walks the ENTIRE ancestor chain from `parentThreadId` (inclusive) UP
  `thread_spawn_edges` (`child_thread_id → parent_thread_id`, edges of ANY
  status — a closed edge still defines ancestry) with a cycle guard and
  depth bound. If ANY ancestor with an `agent_runs` row is cancel-locked →
  `{ allowed: false, decision: "deny", reason: "parent_cancel_locked",
  parentRunId, parentStatus }` (reason is a machine-readable member of the
  frozen `AdmissionDecision` shape, not prose). The walk deliberately does
  NOT stop at the first run row found: a terminal-but-revivable
  intermediate (a `completed` child of a cancelled root) must not shield
  admissions below it. No cancel-locked row anywhere up the chain →
  allowed.
- `class SpawnAdmissionBlockedError extends Error` — `code =
  "SPAWN_ADMISSION_BLOCKED"`, carries `childThreadId`, `parentRunId`,
  `parentStatus`; message names the refused child, the cancel-locked
  ancestor, and that the refusal maps to admission decision `deny`.
- `cancelAgentRunTree(driver, { runId, reason, cancelledAt }):
  CancelAgentRunTreeReport` — ONE SQLite transaction:
  1. Subtree = `runId` + BFS over `thread_spawn_edges` (any edge status;
     cycle-guarded).
  2. Every subtree run whose status is non-terminal
     (`pending/running/working/paused/blocked/suspended`) → status
     `cancelled`, `last_active_at = cancelledAt`, metadata patch
     `{ cancelReason, cancelledBy: runId, cancelledAt }`. Already-terminal
     descendants keep their status — cancellation never rewrites history
     (a `completed` child stays `completed`).
  3. Every OPEN subtree edge → `closed` (existing CAS `setStatus`).
  4. `in_flight_tool_calls` rows are NOT touched — partial evidence is
     preserved; startup recovery later classifies them by the existing
     category rules (side-effecting → `poisoned`, i.e. evidence retained
     and review-gated, which is exactly the M4 semantics).
  Report: `{ rootStatusBefore, cancelledRunIds, priorStatusById,
  closedEdgeChildIds, alreadyTerminal, missing }`. Idempotent: cancelling
  an already-cancelled tree returns `alreadyTerminal: true` and mutates
  nothing. Unknown `runId` → `missing: true`, no throw (the daemon layer
  maps it to a typed RPC error).
- `repairCancelledSubtrees(driver, { now }): RepairReport` — ONE-SHOT
  recovery interplay. `cancelAgentRunTree` is a single transaction and
  stamps `cascadeComplete: true` in the root's metadata, so
  cascade-cancelled trees are never re-examined. Repair targets only
  cancelled roots WITHOUT the stamp (a root cancelled by a non-cascade
  writer, e.g. a relayed status transition): their surviving non-terminal
  descendants are finished off once (`cancelReason:
  "recovery_cascade_repair"`), then the root is stamped so later startups
  never re-police the tree — a descendant legitimately revived afterwards
  (completed → running via a follow-up message) is never re-killed.
  Scoped to `cancelled` ancestors only — descendants of a merely
  `completed`/`errored` parent are legitimate survivors and stay
  recoverable.

### 2.2 Enforcement at the durable seams (non-bypassable)

- `ThreadSpawnEdgeRepository.create(edge, opts?)` consults
  `checkSpawnAdmissionGate` on `edge.parentThreadId` inside the repo and
  throws `SpawnAdmissionBlockedError` on refusal. Gate check + INSERT run
  under ONE `BEGIN IMMEDIATE` transaction
  (`StateSqliteDriver.transactionImmediate`): the write lock is held
  across the check, closing the cross-process TOCTOU where a concurrent
  `run.cancel` commits between the admission decision and the edge landing
  (the cascade would never have enumerated that child). Default mode
  `"enforce"`; `opts.admissionGate: "import"` skips the check ONLY for the
  legacy JSON edge import (`rollout-store.ts loadThreadSpawnEdges`), which
  records historical topology rather than admitting new work. Same shape
  as `recordInFlightToolCallStart`'s `unknownOutcomeGate: "enforce" |
  "flag"`.
- `updateAgentRunStatus` gains cancel-lock stickiness: if the existing
  status is cancel-locked and the incoming status differs, the write is a
  guarded no-op returning `{ applied: false, reason:
  "cancel_locked_status_sticky", existingStatus }` (return type goes from
  `void` to a report — existing callers that ignore the return keep
  compiling). Same-status writes still land (metadata patches on the
  terminal record, e.g. recording a cancel reason twice, stay possible).
  No-op instead of throw because the sole production caller is the
  post-hoc snapshot observer relaying status from a dying agent — it
  cannot un-die the agent; a late `errored` after `cancelled` must lose
  silently, mirroring the observer "flag" rationale.
- `upsertAgentRun` gains the same stickiness: existing cancel-locked row +
  different incoming status → whole write skipped, `{ applied: false }`.
  This closes the upsert-laundering hole (the same hole #1541 closed for
  poisoned tool rows).
- `recoverDaemonStateOnStartup` runs `repairCancelledSubtrees` inside its
  existing transaction BEFORE `loadRecoverableAgentRuns`, so a
  crash-orphaned descendant of a cancelled parent is finished off rather
  than resurrected, and the restore loop never sees it.
- `agentRunStatusForTransition` (`snapshot-policy.ts:1051`) gains a
  `cancelled` passthrough arm so the production transition writer can
  relay a cancel-shaped transition if one ever reaches it (stickiness
  still guarantees it cannot revive).

### 2.3 Daemon method `run.cancel`

Frozen name, standard 10-step wiring (pattern: `session.applyConfig`):
`AGENC_DAEMON_METHODS` + descriptor + `RunCancelParams { runId, reason? }`
/ `RunCancelResult` + `AgenCDaemonResultByMethod` + capability entry
(`hasMethod(agentManager, "cancelRunTree")`) + dispatcher `Pick` allowlist
+ validator + dispatch case + `agent-lifecycle.ts` manager method + runner
seam + schema.json mirror + CLI/SDK stubs.

Handler flow (manager `cancelRunTree`):

1. **Durable first**: `cancelAgentRunTree` on the state DB. The durable
   record is the authority; if the daemon dies after this step, recovery
   repair finishes the job. Unknown run → typed `RUN_NOT_FOUND`-style RPC
   error; `alreadyTerminal` → success result with `alreadyTerminal: true`
   (idempotent).
2. **Live propagation second**, reusing the contract-mandated primitive:
   for each live agent in the subtree, the existing
   `control.interrupt`/`interruptAgentTurn` cascade + `stopAgent` on the
   root. Late status writes from dying agents are absorbed by stickiness
   (`cancelled` wins, always).
3. **Void reservations**: new additive `BudgetLedger.voidHoldsForAgent(
   agentId): number` — deletes OPEN holds for that agent under the
   existing disk lock WITHOUT touching spend/pause (unlike operator
   `reset`). `voided` is a FULL refund per the frozen contract: the day
   debit is refunded when the hold's day window is current, and the month
   debit whenever its month window is current — including holds whose day
   already rolled (unlike `consumeHold`'s `window_rolled`, which keeps
   the month debit because the usage is unknown, not cancelled). Called
   over the FULL `subtreeRunIds` (not just freshly-cancelled ids) and
   ALSO on an `alreadyTerminal` retry: a crash between a prior cancel's
   durable cascade and its voiding leaves stranded holds that only a
   retried `run.cancel` can release (voiding is idempotent). Cross-store
   atomicity with SQLite is impossible (ledger is a file); ordering
   durable-cancel → void is safe because an unvoided hold only
   over-reserves (fails closed), never under-reserves.

Result: `{ runId, alreadyTerminal, cancelledRunIds, closedEdges,
interruptedLive, voidedHolds }`.

### 2.4 Trust-driver rewrite (`eval-executor/trust-run.ts`)

`runCancelParentAfterChildAdmission` stops injecting the fault as a bare
status write and drives the REAL primitives:

- cancel_parent → `cancelAgentRunTree` (the production cascade seam).
- `queued_and_running_descendants_cancelled` → read back both children's
  statuses (`pending` child exercises the queued half, `running` child the
  running half).
- `descendant_admission_stopped` → attempt a late child admission through
  the gated seams (`upsertAgentRun` of the child + `edges.create` under
  the cancelled parent); PASS only if `edges.create` throws
  `SpawnAdmissionBlockedError` (typed check — any other throw is rethrown
  as infrastructure error, exactly the current honest-probe rule) AND no
  edge row exists afterwards. Also probe resurrection: `upsertAgentRun`
  flipping the cancelled parent back to `running` must be a no-op.
- `partial_evidence_preserved` → unchanged (in-flight row still present).
- Test `runtime/tests/eval/trust-conformance-executor.test.ts` flips the
  pinned cancellation-family outcome to `passed` (both directions pinned,
  revert-sensitivity proven by stashing the state-layer change).

Expected scoreboard: TRR 7/7.

## 3. Explicitly out of scope (follow-ups)

- Pre-dispatch `BudgetEnforcer.admit({ kind: "spawn" })` wiring at
  `AgentControl.spawn` and `checkUnknownOutcomeMutationGate` pre-dispatch
  consultation (the admission-kernel consolidation; this slice adds the
  durable deny seam it will sit on).
- `run.status` / `run.result` / `run.replay` / `run.evidence` (M4/M5).
- A production `pending → running` promoter (no production writer emits
  `pending` today).
- Gating the legacy JSON edge file itself (import-only; the SQLite repo is
  the durable authority).

## 4. Risks & known limitations

- **Legitimate revival flows**: mitigated by locking only
  `cancelled`/`unknown_outcome`, never `completed`/`errored`/`stopped`,
  and by one-shot repair (`cascadeComplete` stamp) so revived descendants
  are never re-killed on later startups.
- **Shared project DB, multiple daemons**: the admission gate + edge
  INSERT run under one `BEGIN IMMEDIATE` transaction; cascade and repair
  run in SQLite transactions; edge-close uses the existing CAS; stickiness
  makes concurrent late writers converge on `cancelled`. `agenc state
  import` over a cancel-locked run fails atomically instead of
  half-applying (run-row write dropped, session state replaced).
- **Live agents in OTHER processes** (e.g. a CLI-local session whose tree
  the daemon cancels): the durable record wins immediately — stickiness
  rejects their late status writes, the gate refuses their new spawns —
  but their in-flight work is NOT interrupted; it runs until its own
  turn/loop checks fail or the next startup recovery. Cross-process live
  interruption needs an IPC signal and is a deliberate follow-up.
- **Ancestor walk cost**: gate walk is depth-bounded (existing spawn depth
  cap) and hits the `parent_thread_id` index; repair sweep visits only
  unstamped cancelled roots inside the existing recovery transaction.
- **False refusal on unrelated trees**: gate only consults the ancestor
  chain of the specific parent; runs with no cancel-locked `agent_runs`
  ancestor are never refused.
