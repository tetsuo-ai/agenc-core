# Durable runs, effects, and events

This document is the design, recovery, and operator contract for M4 durable
runs. It covers the boundary between an agent's append-only history, external
effects, client delivery, terminal results, and restart recovery.

The central rule is simple: the existing rollout JSONL is the canonical run
journal. SQLite schema version 15 indexes that journal and stores immutable
lifecycle/effect projections, but it does not become a second event authority.
If the two disagree, recovery rebuilds SQLite from the fsync-committed JSONL.

## Guarantees and limits

M4 guarantees that:

- durable events are appended and fsynced before any in-process or daemon
  client can observe them;
- every replayed event preserves the canonical `eventId` assigned before
  persistence and its per-run `sequence`; the older `id` field remains a
  reusable request/subscription correlation value, not event identity;
- retention, compaction, corruption truncation, and missing sources are
  explicit gaps, never silent cursor jumps;
- a root background run writes one durable terminal result that remains
  queryable after disconnect or daemon restart;
- an external effect has a durable intent before dispatch and a durable,
  sticky outcome after acknowledgement;
- an unprovable non-idempotent outcome becomes `unknown_outcome`, requires
  review, and cannot be laundered into late success;
- large tool-result artifacts have durable intent/commit evidence and are
  published as complete immutable files, not partially visible targets; and
- replay and recovery are idempotent. Reapplying the same event is a no-op,
  while reusing an identity for different content fails closed.

M4 does **not** promise exactly-once execution for arbitrary shell, network,
or interactive effects. A process can die after an external system commits an
operation but before AgenC records the acknowledgement. The only honest state
in that window is `unknown_outcome`.

## Authority and projections

```text
 Session.emit
     |
     | 1. allocate canonical eventId + per-run sequence
     v
 SessionStore append-only rollout JSONL
     |
     | 2. write + fsync for a durable event
     v
 canonical committed event
     |                         \
     | 3. publish live          \ rebuild / query
     v                           v
 EventLog + txEvent       SQLite schema v15
 client notifications     thread_rollout_items
                          lifecycle/effect/binding tables
                                  |
                                  v
                       run.replay / result / evidence
```

The canonical files are the existing per-session rollouts under the project
`sessions/` or `archived_sessions/` tree. They use `O_APPEND`; durable event
types flush immediately with `fsync`. On open, the rollout reader truncates a
corrupt partial tail to the last complete record. The additive unknown-event
shim preserves forward compatibility when an older reducer encounters a newer
event type.

The `thread_rollout_items` table is a byte-offset and hash projection of those
files. `run.replay` refreshes the bounded projection for the requested run
before reading it. The projection can be dropped and rebuilt without losing
the journal. The pre-M4 `execution_admission_journal` remains a compatibility
source only when no canonical rollout source is available.

Schema v15 adds four state tables:

| Table                  | Role                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `run_lifecycle_epochs` | Ordered open/reopen epochs for one stable `runId`                                     |
| `run_terminal_results` | One immutable terminal result per `(runId, epoch)`                                    |
| `run_effects`          | Intent, sticky outcome, and explicit review state for tool effects                    |
| `run_journal_bindings` | Historical rollout paths, active source, sequence bounds, and explicit retired ranges |

The tables store transition state and journal coordinates, not duplicate event
payloads. Journal bindings retain historical source paths so an archive or
reopen does not erase provenance. Bounds may expand monotonically; retiring a
range requires a recorded `retention`, `compaction`, or
`corruption_truncated` gap.

## Lifecycle epochs and terminal results

A new run starts at epoch 1. The terminal transition follows this order:

1. Select the terminal payload from the managed thread status, final assistant
   message, usage, exit code, and stop reason, and close new run ingress.
2. Resolve or abort pending permission continuations while the canonical
   writer is still open.
3. Quiesce and drain the root task, child agents, live execs, session-end
   hooks, mailboxes, conversations, and every tracked durable continuation.
   Abort/permission/effect evidence produced by that drain commits before the
   terminal boundary.
4. The before-close finalizer verifies no permission decision remains pending,
   then appends and fsyncs `run_terminal` as the final automatic execution
   event for that epoch and projects it into `run_terminal_results`.
5. Seal the execution writer against later automatic appends, flush and close
   it, and only then advance the compatibility `agent_runs` projection and
   notify lifecycle consumers. The stopped-session operator-review exception
   described below takes a new exclusive lease; it does not reopen execution.

This order makes both crash windows recoverable. If the process dies before
the SQLite projection, the canonical event rebuilds it. If it dies after the
projection, replaying the same event is an idempotent acknowledgement.
`run.result` reads the durable projection and returns
`output.available: true` with `exitCode`, `stopReason`, `finalMessage`,
`usage`, and `lastSequence`. That sequence is the immutable terminal snapshot
coordinate, not necessarily the later audit-journal tail.

The compatibility `agent_runs` row is updated in the same SQLite transaction
as a current-epoch terminal projection. Schema migration 29 repairs rows from
older runtimes that remained `running` despite such a terminal. It does not
overwrite cancel-locked verdicts, fabricate child rows, or repaint a reopened
epoch from an earlier terminal.

Terminal content is first-write sticky. Repeating the exact result returns an
idempotent no-op. A different result for the same epoch raises a conflict, and
SQLite triggers forbid direct updates. This prevents a late callback from
changing a recorded failure or unknown outcome into success.

A deliberate reopen is a new lifecycle epoch, not a rewrite. A durable
`run_reopened` event names the previous epoch, the next epoch, the reason, and
the reopen time. Reopen is allowed only after the current epoch is terminal.
Pending unknown-outcome reviews do **not** block reopen when that terminal is
`completed`, `failed`, or `cancelled`; `/resolve` and
`session.resolveToolCall` run inside the reopened session. The public agent
resume path refuses an `unknown_outcome` terminal regardless of review status.
An intent with no settlement record at all (a dangling intent) also refuses
reopen and cannot be settled by an effect-review command. Dependent mutations
stay stopped until each projected review resolves; no automatic replay occurs.
Terminal history for prior epochs stays queryable.

Runs created before M4 can still have a terminal `agent_runs` row without a
canonical terminal payload. For that compatibility case, `run.result` returns
`output.available: false` instead of inventing an answer.

Every admitted in-process child or review delegate owns a separate canonical
run journal. If spawn dispatch commits but `Session` construction fails, AgenC
seals a minimal child journal with a failed or cancelled terminal result so the
run remains inspectable. Once any canonical source records `run_terminal` for
an epoch, opening another writer for that `(runId, epoch)` is refused even when
the new writer would use a fresh rollout path; only an explicit reopen may
advance the lifecycle epoch.

Resource teardown happens after the child journal is sealed. A provider,
sandbox-broker, or LSP cleanup failure is emitted as a warning and does not
retroactively change the public or durable terminal outcome. Failure to seal
the journal itself remains a run failure.

## Honest effect semantics

Tool recovery classification is part of the effect contract, not a guess made
after a crash:

| Category         | Idempotency key                                          | Recovery rule                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotent`     | Required, stable, and derived from the logical operation | The only category eligible for replay. Journal recovery records `retry_safe_deferred`; an explicit owner may retry using the same key. It does not blindly execute during store open. |
| `side-effecting` | Forbidden                                                | A lost post-dispatch acknowledgement becomes `unknown_outcome`. New dependent side-effecting calls stop until review resolves it.                                                     |
| `interactive`    | Forbidden                                                | A lost post-dispatch acknowledgement becomes `unknown_outcome`; the human-in-the-loop interaction is not auto-replayed.                                                               |

The durable event sequence is:

```text
effect_intent (fsync)
       |
       +-- cancelled before dispatch --> effect_result(cancelled)
       |
       +-- dispatch --> effect_result(committed | failed | cancelled)
       |
       +-- dispatch, acknowledgement unprovable
                         --> effect_unknown_outcome(requiresReview: true)
```

`effect_intent` contains the run/step/call identity, tool name, recovery
category, arguments digest, attempt number, and an idempotency key only when
the category is `idempotent`. Arguments stay out of the event payload so the
journal does not become a second secret-bearing input store.

`effect_result` acknowledges only a proven `committed`, `failed`, or
`cancelled` outcome. `effect_unknown_outcome` is terminal-but-unresolved. Its
projection is review-locked: a late result cannot overwrite it, and the review
state can move only `pending -> resolved`. For a settled terminal status,
review-required does not mean resume-refused. `completed`, `failed`, and
`cancelled` terminals reopen with reviews still pending so the operator can
run `/resolve` in the live session. The in-flight tool recovery index still
marks the call `poisoned`, so `assertDependentMutationAllowed` and the
live-effect gate block a new side-effecting dispatch until that review is
resolved.

Restart classification consults the durable admission boundary. A reservation
still `reserved`, or already recovered to `voided`, proves the effect never
crossed dispatch and produces a cancelled result. `dispatched`,
`held_unknown`, or missing evidence cannot prove that, so a non-idempotent
intent without an acknowledgement becomes `unknown_outcome`. Recovery families
share one sequence cursor; artifact and effect recovery cannot project two
different events at the same journal coordinate.

An admission reservation and an effect answer different questions. The
reservation records whether capacity/spend crossed the dispatch boundary; the
effect journal records whether the physical tool outcome is known. After a
post-dispatch crash, a reservation may remain `held_unknown` while the effect
requires review. Neither state is refunded or replayed merely because the
daemon restarted.

Two operator paths settle a projected `unknown_outcome` review. For a
`completed`, `failed`, or `cancelled` terminal, resume first and then use
`/resolve` or `session.resolveToolCall` in the live session.

The offline CLI still works after the session is stopped:

```bash
AGENC_REVIEWER_ID=operator_7 \
  agenc state resolve-tool-call <session-id> <tool-call-id> \
    <confirmed_committed|confirmed_no_effect|remains_unknown> \
    <evidence-ref> <evidence-sha256>
```

For an M4 effect, the live path appends through the Session that already owns
the journal lease. The offline path takes the stopped rollout's exclusive
lease. Both verify the matching `effect_unknown_outcome`, then append and fsync
one idempotent `effect_review_resolved` event before the SQLite review
projection advances. The event records the run, step, call, typed disposition,
reviewer, evidence reference and SHA-256, workflow status, domain action, and
review time. It lifts the mutation gate only for a terminal typed disposition;
it never reruns the tool or changes the unknown physical outcome into a
fabricated success. Reviewer identity falls
back from `AGENC_REVIEWER_ID` to `USER`, `USERNAME`, then `local_operator`.

The offline command is a post-terminal audit exception when `run_terminal`
already exists: it appends only after taking the stopped rollout's exclusive
lease, and it never resumes agent execution or changes the terminal result.
Replay and journal-binding bounds include the later review evidence;
`run.result.output.lastSequence` remains the sequence of the terminal snapshot.

## Resume and effect review

`reopenRun` (`runtime/src/state/run-durability.ts`) and the rollout-store gate
(`reopenTerminalEpoch`) enforce the durable epoch rules. The public
app-server resume path adds the stricter rule for an `unknown_outcome`
terminal. The M4 requirements stand: dependent mutations stop, review is
required, and no automatic replay occurs.

| Terminal / evidence | Reopen | What happens next |
| --- | --- | --- |
| `completed`, `failed`, or `cancelled` with pending reviews | Allowed | New epoch. `/resolve` runs in the live session. Side-effecting tools stay gated. |
| `cancelled` with no pending reviews | Allowed | Everyday Ctrl-C-then-continue. Cancel is a settled terminal, not a brick. |
| `unknown_outcome` terminal | Refused by public `agent.create` resume | The offline CLI can append review evidence for a projected unknown-outcome effect, but the same terminal session remains non-resumable. |
| Dangling intent (side-effecting or interactive intent, no settlement record) | Refused | Evidence gap, not a review queue. `/resolve` and the offline review command cannot settle it. |
| Active suspension with matching canonical and durable state and no unresolved effects | Resumed in the same epoch | Appends `run_resumed`; this is not a terminal reopen. |
| Active suspension with mismatched state or unresolved effects | Refused | Repair or reconcile the durable evidence before another resume attempt. |
| Non-terminal open epoch | Continued in the same epoch | Crash recovery applies its evidence gates; this is not a lifecycle retry. |

A cancelled epoch is a settled terminal outcome. An explicit resume reopens
it under a new epoch exactly like a completed run. An `unknown_outcome`
terminal stays refused by the public resume path after review resolution; the
review preserves audit evidence but does not rewrite that terminal result.

Retained-agent resume compares `createdAt` on the retained record (daemon
clock at `agent.create`) to the rollout header (session writer) within
**5 seconds** (`RETAINED_CREATED_AT_TOLERANCE_MS`). Strict equality used to
refuse every retained root session. Identity checks on objective, model, and
provider still fail closed for a swapped-in rollout.

Planning refusals that provably occur before any physical effect use
`validationErrorToolResult` to record `confirmed_no_effect`. These include the
ExitPlanMode "You are not in plan mode" check and other argument or mode
checks. A bare `isError` from a non-idempotent tool still poisons the mutation
gate. ExitPlanMode deliberately keeps a bare error after a possible plan-file
write so a genuine mid-flight failure remains `unknown_outcome`.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Ctrl-C then `--resume` / `/resume` is refused with review-required | Confirm the terminal is `unknown_outcome` or a dangling intent exists. Settled cancel/complete/fail should reopen. |
| Session opens but every write/shell tool is blocked | Pending `unknown_outcome` reviews. Run `/resolve`, not another resume. |
| `/resolve` says there is no live session | Resume first only for a settled `completed`, `failed`, or `cancelled` terminal. For an `unknown_outcome` terminal, use the offline command to record review evidence; that does not make the same session resumable. |
| Offline `resolve-tool-call` reports `not_found` for a dangling intent | Expected. A raw intent has no `unknown_outcome` settlement to review and needs recovery classification or evidence repair rather than a review disposition. |
| "You are not in plan mode" blocked later mutations | Fixed: that refusal now attests `confirmed_no_effect`. A leftover poison is an older journal. |
| Retained session refuses with a createdAt mismatch of a few milliseconds | Current code allows 5s. A larger gap, or a model/provider/objective mismatch, is still a hard refuse. |
| Interrupted turn starts over instead of continuing from its last checkpoint | See [In-turn checkpoint resume](#in-turn-checkpoint-resume) and check the recorded resume-gate failure reason. |
| Open reports `durable checkpoint upgrade blocked` | Integrity, mixed-version, or work-limit failure. Resume stays disabled. Preserve the rollout; restore intact source bytes from backup or start a new session. See [Upgrade and downgrade](#upgrade-and-downgrade). |
| Open reports `resumableState contains unversioned fields` | The checkpoint carries a key outside the versioned slice. New fields need a new checkpoint version and rollout schema. See [Checkpoint slice versions](#checkpoint-slice-versions). |
| Older binary refuses `rollout schema v4` | Expected. Schema 4 is newer than a schema-3 runtime. Upgrade the runtime; do not rewrite the header by hand. |

## In-turn checkpoint resume

Epoch reopen (table above) decides whether a **run** may start another
turn. In-turn resume decides whether an **orphaned turn** continues from
its last `turn_checkpoint` instead of opening a fresh turn.

After a successful nonterminal sample, `run-turn.ts` advances
`modelSampleOrdinal`. Before the next admission, it force-emits a `turn_checkpoint`
(`emitTurnCheckpoint("iteration", { force: true })`). Interval throttling
cannot defer that barrier. The checkpoint-version-3 event, stored in rollout
schema 4, fsyncs:

- the durable response prefix and its version-2 `prefixHash` algorithm
- `resumableState` from `toCheckpointSlice(state)`

The slice always carries `turnCount`, `recoveryReentryCount`,
`maxOutputTokensRecoveryCount`, `continuationNudgeCount`,
`stopHookBlockingCount`, `planToolRequiredRetryCount`, and
`modelSampleOrdinal`. It optionally stores `modelSampleResumePrompt` as
`continuation_nudge` or `empty_response`. It also stores
`editorToolCallsAdmitted` after an editor admission and
`pendingAdmissionFallback` while a provider swap awaits admission. The
reader validates those fields before `restoreFromCheckpoint` applies them.
Crash recovery can restore the runtime-only state and derive the same next
sample step ID from the checkpointed ordinal. See
[execution-admission-kernel.md](execution-admission-kernel.md#model-step-identity).

`resumeTurnFromCheckpoint` (`runtime/src/conversation/thread-manager.ts`)
continues that turn only when every gate holds. A gate rejection may open a
fresh turn only when no provider state changed or compensation proved that the
original state was restored. The existing checkpoint remains unchanged.

When the checkpoint carries `pendingAdmissionFallback`, resume first prepares
that fallback's provider and model as one route. Publication covers the
provider binding, session configuration, model metadata, runtime config,
provider client continuation state, and checkpoint-owned pending switch. The
resumed turn context, admission evidence, and provider call are created only
after the session binding matches both route values.

### Resume outcomes

| Outcome | State requirement | Startup behavior |
| --- | --- | --- |
| Resumed | Every gate passed and any pending provider route was published completely. | Continue the orphaned turn. Do not create a fresh turn. |
| Clean rejection | Provider publication never began, or compensation proved that the original route, config, model metadata, and client continuation state were restored. Provider rollback advances the revision so stale prepared work cannot commit. | A fresh turn is permitted. Fresh-turn events append after the unchanged checkpoint. |
| Terminal failure | Provider publication changed live state and complete compensation could not be proved. | Halt startup and fence the session. Turn construction and `runTurn` reject further work; no fresh turn is created or dispatched. |

`provider-restore-failed` can report either rejection class. The structured
resume result distinguishes them. Only terminal failure sets
`freshTurnAllowed` to `false` and carries the rollback failure detail.

| Gate | Default | Failure reason |
| --- | --- | --- |
| `durableTurns.resume.onRestart` | `true` | `disabled` |
| A readable checkpoint exists on an unterminated turn | n/a | `no-checkpoint` |
| `durableTurns.resume.buildPinning` matches the writing build | `true` | `build-mismatch` |
| Checkpoint reader accepts the payload (`readTurnCheckpoint`) | n/a | `integrity-invalid` or `integrity-deferred` |
| History prefix hash matches | n/a | `prefix-mismatch` |
| Single-writer resume lease (`durableTurns.resume.requireLease`) | `true` | `lease-unavailable` |
| Pending fallback provider and model are restored together | n/a | `provider-restore-failed`; apply the outcome table above |

The writer, event types, and strict reader share the slice contract in
`runtime/src/session/turn-checkpoint-slice.ts`. The reader accepts legacy
version 1, canonical version 2, and version 3. It also has a narrow
compatibility path for version-2 checkpoints written with
`editorToolCallsAdmitted` or `pendingAdmissionFallback`; those rows are
validated against the version-3 slice and normalized in memory. Other
unknown fields still fail with `resumableState contains unversioned fields`.
Rollout schemas 1, 2, and 3 are promoted atomically to schema 4 after their
prefix and tool-result integrity checks pass. Schema 3 remains the
transactional-compaction format and can contain checkpoint-version-2 rows;
schema 4 requires checkpoint-version-3 rows. The rewrite preserves compaction
records and publishes the new header with the upgraded checkpoints as one
operation. A rejected checkpoint is not rewritten, and a runtime whose maximum
rollout schema is 3 refuses a schema-4 header before replay or append.

### Checkpoint slice versions

Current writes use checkpoint version 3 in rollout schema 4. The prefix
digest stays on the version-2 algorithm (`agenc.checkpoint-prefix.v2`).
[CP-0003](critical-path/0003-versioned-durable-checkpoints.md) shipped the
version-2 integrity contract; this pairing is the successor write format,
not a rewrite of that ADR.

| Rollout schema | Checkpoint version | Role |
| --- | --- | --- |
| 1 | 1 | Legacy prefix hash |
| 2 | 2 | Tool-result integrity checkpoints |
| 3 | 2 | Transactional compaction. Schema 3 does **not** mean checkpoint v3 |
| 4 | 3 | Current writer slice, including editor admission and pending fallback |

Adding a serialized `resumableState` field requires a new checkpoint version
**and** a new rollout schema. Do not extend the version-2 allowlist, and do
not reuse schema 3 for checkpoint v3. Unknown versions and unknown keys fail
closed. The writer, reader, event types, and recovery journal share
`runtime/src/session/turn-checkpoint-slice.ts`.

`restoreFromCheckpoint` assumes the slice has already passed
`readTurnCheckpoint`; it does not enforce the wire-integrity contract.
`readTurnCheckpoint` is the fail-closed reader.

#### Slice constraints

- Required counters are non-negative safe integers: `turnCount`,
  `recoveryReentryCount`, `maxOutputTokensRecoveryCount`,
  `continuationNudgeCount`, and `stopHookBlockingCount`.
- `editorToolCallsAdmitted` is omitted when `0`. When present it is a
  non-negative safe integer. The live editor cap is
  `EDITOR_INTERACTION_MAX_TOOL_CALLS` (`32` in
  `runtime/src/session/editor-interaction.ts`).
- `pendingAdmissionFallback` requires `fromModel`, `toModel`, and `reason`.
  `fromProvider` and `toProvider` are optional. Each string is non-empty and
  at most `4096` UTF-8 bytes (`MAX_CHECKPOINT_FALLBACK_TEXT_BYTES`). Extra
  keys fail closed (`contains unversioned fields`).
- `modelSampleResumePrompt` is only `continuation_nudge` or
  `empty_response`.
- Nested objects (`pendingBudgetDecision`, `autoCompactTracking`,
  `transition`) use exact keys.

The writer validates the fallback envelope before persist
(`validatePendingAdmissionFallbackSlice`). A failed serialize throws
`cannot serialize turn checkpoint: …` and does not write a partial row.

#### Upgrade and downgrade

`planLegacyDurableCheckpointUpgrade` builds an atomic rewrite and never
publishes. `RolloutStore.promoteDurableCheckpointSchema` applies the plan
with `rewriteRolloutItemsAtomically` only after prefix, tool-pair, bounds,
and checkpoint-version checks pass. Re-planning the published output is
deterministic and reports `changed: false`.

A blocked upgrade throws `DurableCheckpointUpgradeBlockedError`. Resume
stays disabled. Preserve the rollout bytes; restore intact source from
backup or start a new session. The planner does not rewrite a rejected
checkpoint. Mixed versions in one rollout fail `rollout_schema_mixed`
without rewriting source bytes.

An older runtime whose maximum rollout schema is 3 refuses a schema-4
header before replay or append (`SchemaMismatchError`: `rollout schema v4
is newer than runtime v3 — please use /fork to migrate or upgrade
@tetsuo-ai/runtime`). Prefer upgrading the runtime. Do not rewrite the
header by hand.

## Persist before publish

For a durable event, `Session.emit` uses a split publication path:

1. `EventLog.stamp` assigns the next sequence and a unique canonical
   `eventId` without notifying subscribers. It preserves `Event.id` for legacy
   correlation and rejects canonical identity reuse.
2. `SessionStore.append(..., { durable: true })` writes the event and fsyncs
   the rollout. A failed durable flush returns failure and `Session.emit`
   throws; publication does not continue.
3. The committed event is published to `EventLog` subscribers and the
   compatibility `txEvent` stream.

This ordering closes the old window where a client could see a transition that
was absent after restart. It applies to terminal, reopen, artifact
intent/commit, recovery-decision, and all effect lifecycle events, as well as
the existing durable turn events. Progress events remain batched for up to
100 ms, so consumers must not treat an arbitrary progress notification as a
commit record. If a client persisted a cursor for a published tail event that
was not durable at daemon death, replay reports `cursor_ahead` rather than
silently accepting that cursor.

Live notification buffers use the same honesty rule. If byte or count limits
evict sequenced events, the multiplexer inserts an `event_gap` marker with the
run, prior cursor, and first available sequence. It does not splice the buffer
silently.

## Immutable artifact publication

Large tool results first append and fsync `artifact_intent`, including the
stable artifact identity, content digest, byte length, source call, and final
target. They then use the M4 atomic artifact helper before their path is
returned to the model:

1. write a unique temporary file;
2. fsync its complete bytes;
3. publish with a same-filesystem, no-replace hard link;
4. remove the temporary name and fsync the parent directory.

Those child-path operations stay bound to the already-open trusted-root
descriptor. The supported and acceptance-tested aliases are `/proc/self/fd`
or `/dev/fd` on Linux and `/dev/fd` on macOS. A platform where AgenC cannot
resolve such a descriptor-relative path fails commit, cleanup, and recovery
observation closed with `ARTIFACT_SAFE_OPERATION_UNSUPPORTED`; the current
Windows implementation therefore does not publish large tool-result artifacts
until an equivalent descriptor-bound primitive is available.

After publication, `artifact_committed` records `committed` or
`already_committed` and references the intent sequence. An identical retry is
therefore an idempotent acknowledgement. Different bytes for the same target
raise `ARTIFACT_CONTENT_CONFLICT` and never overwrite prior evidence.

On restart, a dangling artifact intent is resolved only from observable bytes.
A matching digest produces `artifact_committed(outcome: recovered)`. A missing
target produces `artifact_retry_safe_deferred`; a mismatched target produces
`artifact_conflict_review_required`. Recovery never overwrites the target or
re-runs the tool that produced it. Private temp files abandoned by `SIGKILL`
are removed under the resumed session's exclusive lease with an exact-parent,
regular-file-only, bounded sweep; they are never promoted. A crash therefore
exposes either no target or the complete target, never a partially written
artifact.

## Cursor replay and reconnect

`run.replay` is an exclusive-cursor API. `afterSequence = N` asks for events
strictly after `N`; `limit` defaults to 100 and accepts 1 through 200. A
canonical response identifies:

```json
{
  "source": {
    "kind": "run_journal",
    "sequenceScope": "run",
    "canonical": "rollout_jsonl",
    "projection": "thread_rollout_items"
  }
}
```

Canonical pages are contiguous. If the requested next sequence is no longer
available, the response returns no cursor jump and an explicit gap:

```json
{
  "gap": {
    "kind": "event_gap",
    "runId": "run_123",
    "afterSequence": 17,
    "firstAvailableSequence": 24,
    "reason": "retention"
  },
  "nextAfterSequence": 17
}
```

Gap reasons are `retention`, `compaction`, and `corruption_truncated`. A run
with no journal source returns `source_unavailable`. No case authorizes a
client to advance without making an application-level reconciliation choice.
If `afterSequence` is beyond the canonical tail, replay returns a distinct
`cursor_ahead` gap with `lastAvailableSequence`; this covers a stale/wrong
cursor and a client-observed non-durable tail without pretending the events
still exist.

The embedding SDK wraps this protocol with
`client.reattachRun({ runId, afterSequence })`:

- it preserves and exposes the exclusive cursor with `attachment.cursor()`;
- it advances only as each event is yielded to the consumer;
- it suppresses exact duplicate `(sequence, eventId, content)` delivery and
  reports it through `onDuplicate` plus `diagnostics()`;
- it rejects reused identities with different content, non-monotonic pages,
  missing sequences, mismatched cursors, and unexplained cursor jumps with
  `AgencRunReplayProtocolError`;
- it throws `AgencRunReplayGapError` without advancing past the gap; and
- `attachment.result()` fetches the durable final result by `runId`,
  independent of the connection that started the run.

Delivery is replay-safe, not magic exactly-once delivery. Persist the cursor
only after the application has processed an event. If the application crashes
between processing and saving the cursor, the event can be delivered again;
use its stable identity to make consumer work idempotent.

## SIGKILL failure matrix

The acceptance suite starts a real child process, arms one test-only failpoint,
waits for a fsynced marker, and lets the child kill itself with `SIGKILL`.
Recovery runs in a fresh process and then runs a second time to prove the
repair is idempotent. Production cannot arm these hooks without the exact test
token.

For every boundary, including reservation, model, tool, artifact,
event-publication, and terminal evidence, the suite also starts the real daemon
entrypoint in a fresh process and reconnects through the public embedding SDK.
It replays from cursor 0, disconnects, and verifies start, midpoint, exact-tail,
and beyond-tail cursors against a second fresh daemon. A cursor beyond the
durable tail raises `AgencRunReplayGapError` without moving; terminal cases also
fetch the immutable result.

| Boundary                                                | State after restart                                                                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after_admission_sqlite_commit_before_canonical_append` | The guarded crash window leaves the SQLite decision intact; startup appends that exact event ID and payload to the canonical per-run tail under its exclusive descriptor-pinned lease before replay is served. |
| `before_reservation_commit`                             | No reservation exists; the durable job is queued and recovered once.                                                                                                                                           |
| `after_reservation_commit`                              | The undispatched reservation is voided once.                                                                                                                                                                   |
| `before_model_response_commit`                          | One physical provider attempt is conserved as `held_unknown`; it is not replayed or refunded.                                                                                                                  |
| `after_model_response_commit`                           | The single provider attempt is already reconciled.                                                                                                                                                             |
| `before_tool_spawn`                                     | The intent exists, no physical tool attempt occurred, and recovery records cancellation/void.                                                                                                                  |
| `after_tool_spawn`                                      | One tool attempt occurred; the effect becomes review-locked `unknown_outcome` and the reservation is `held_unknown`.                                                                                           |
| `before_tool_ack_commit`                                | Same honest ambiguous state as the post-spawn window; no result is fabricated.                                                                                                                                 |
| `after_tool_ack_commit`                                 | One intent and one committed result exist; the reservation reconciles once.                                                                                                                                    |
| `before_artifact_commit`                                | No target is visible; restart removes the abandoned private temp, journals `artifact_retry_safe_deferred`, and does not auto-publish bytes.                                                                    |
| `after_artifact_commit`                                 | Complete target bytes already exist; restart proves their digest and journals `artifact_committed(outcome: recovered)` without rerunning the producer.                                                         |
| `before_event_publish`                                  | The canonical event exists, live observers saw nothing, and reconnect delivers it once.                                                                                                                        |
| `after_event_publish`                                   | Canonical event and both live publications exist; reconnect deduplicates to one unique delivery.                                                                                                               |
| `before_terminal_commit`                                | The canonical terminal event rebuilds the missing SQLite projection; history contains one result.                                                                                                              |
| `after_terminal_commit`                                 | Reapplying the terminal event is a no-op; history still contains one result.                                                                                                                                   |

The matrix lives in
[`runtime/tests/durability/failure-matrix.acceptance.test.ts`](../../runtime/tests/durability/failure-matrix.acceptance.test.ts).
Focused tests also cover failpoint arming and immutable artifact conflicts.

## Migration and rollback

Schema migration 15 is additive and transactional. Before upgrading any
project database with existing user tables from a version below 15, the driver
holds a `BEGIN IMMEDIATE` writer reservation and automatically creates:

```text
$AGENC_HOME/projects/<project-slug>/agenc-state_1.pre-v15.sqlite
```

SQLite `VACUUM INTO` creates a consistent temporary snapshot. AgenC sets mode
`0600`, verifies `PRAGMA integrity_check`, verifies that the snapshot is truly
pre-v15, fsyncs the file, publishes it, and fsyncs the project directory before
applying migration 15. A stale backup from a failed earlier attempt is replaced
under the same writer lock.

An older runtime whose maximum known schema is below 15 refuses to open a v15
database. Prefer a roll-forward repair. If a downgrade is unavoidable:

1. stop every daemon and foreground runtime that can write the project;
2. preserve the live v15 database and rollout files as recovery evidence;
3. restore `agenc-state_1.pre-v15.sqlite` into a separate staged
   `AGENC_HOME`;
4. validate the restored database before starting the older runtime; and
5. keep execution ingress closed until review accounts for work completed
   after the backup.

Do not delete migration row 15, drop durability tables, or copy selected rows
back into the old database. The backup predates all M4 writes; restoring it
discards post-upgrade projections, and there is no automatic history merge.
The canonical rollout files should be retained even during rollback because
they remain the evidence needed for a later v15-aware reconciliation.

## Source map

| Concern                                     | Implementation                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Canonical event types and split publication | `runtime/src/session/event-log.ts`, `runtime/src/session/session.ts`                               |
| Append/fsync rollout store                  | `runtime/src/session/session-store.ts`                                                             |
| Effect dispatch boundary                    | `runtime/src/budget/admitted-tool-call.ts`                                                         |
| v15 state and projection rules              | `runtime/src/state/run-durability.ts` (`reopenRun`), `runtime/src/state/migrations/015_run_durability_schema.ts` |
| Resume reopen + pending-review gate         | `runtime/src/session/rollout-store.ts` (`reopenTerminalEpoch`), `runtime/src/app-server/agent-lifecycle.ts` (`RETAINED_CREATED_AT_TOLERANCE_MS`) |
| In-turn checkpoint resume                   | `runtime/src/session/run-turn.ts` (`emitTurnCheckpoint`), `runtime/src/session/turn-state.ts` (`toCheckpointSlice`), `runtime/src/session/durable-checkpoint-reader.ts`, `runtime/src/conversation/thread-manager.ts` (`resumeTurnFromCheckpoint`) |
| Shared checkpoint slice contract            | `runtime/src/session/turn-checkpoint-slice.ts` (`TURN_CHECKPOINT_SLICE_KEYS`, `validatePendingAdmissionFallbackSlice`) |
| Rollout schema pairing and upgrade planner  | `runtime/src/session/event-log.ts` (`ROLLOUT_SCHEMA_VERSION`), `runtime/src/session/durable-checkpoint-upgrade.ts` (`planLegacyDurableCheckpointUpgrade`), `runtime/src/session/rollout-store.ts` (`promoteDurableCheckpointSchema`, `DurableCheckpointUpgradeBlockedError`) |
| Journal projection and cursor pages         | `runtime/src/app-server/run-journal-replay.ts`, `runtime/src/app-server/run-inspection.ts`         |
| Terminal lifecycle commit                   | `runtime/src/app-server/background-agent-runner.ts`, `runtime/src/app-server/daemon-cli.ts`        |
| Operator effect-review evidence             | `runtime/src/state/effect-review.ts`, `runtime/src/commands/resolve.ts`, `runtime/src/bin/state-cli.ts` |
| Pre-effect validation (no mutation poison)  | `runtime/src/tools/results.ts` (`validationErrorToolResult`)                                       |
| Replay-safe SDK client                      | `packages/agenc-sdk/src/client.ts`, `packages/agenc-sdk/src/protocol.ts`                           |
| Immutable artifact publication              | `runtime/src/durability/atomic-artifact.ts`                                                        |
| Crash injection                             | `runtime/src/durability/failpoints.ts`                                                             |

Related contracts:

- [`execution-admission-kernel.md`](execution-admission-kernel.md) covers the
  reservation and `held_unknown` side of the same physical boundaries.
- [`shared-run-contracts-v1.md`](shared-run-contracts-v1.md) is the frozen
  cross-milestone run/effect/event vocabulary.
- [`../reference/daemon.md`](../reference/daemon.md) documents the public
  `run.*` RPCs.
- [`../../packages/agenc-sdk/README.md`](../../packages/agenc-sdk/README.md)
  shows durable SDK reconnect usage.
