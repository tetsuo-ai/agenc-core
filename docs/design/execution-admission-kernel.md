# Execution admission kernel

This document is the design and operator contract for the M3 execution
admission kernel. Schema version 14 contains the durable admission state;
schema version 13 supplies the bounded thread-listing indexes used to keep the
daemon control plane responsive under load.

Admission is always present in production runtime bootstraps. Budget caps are
optional, but model calls, tool effects, and agent spawns still pass through
the kernel for concurrency, cancellation, deadline, and evidence enforcement
when no cap is configured. There is no admission-disable environment switch.

## Architecture

```text
TUI / print / SDK / daemon agent / child session
                       |
             ExecutionAdmissionClient
                       |
          ExecutionAdmissionKernel (one daemon)
            | live capacity + fair wakeups
            v
       ExecutionAdmissionRepository
            | BEGIN IMMEDIATE transitions
            v
  per-project agenc-state_1.sqlite
    queue | reservations | allocations | cancellations | journal
                       |
                  allow lease
                       v
       provider wire / tool effect / spawn commit
                       |
        reconcile | void | held_unknown | provider_overrun
```

The split is intentional:

- [`ExecutionAdmissionKernel`](../../runtime/src/budget/execution-admission-kernel.ts)
  is the process-wide authority for global and cross-workspace capacity,
  starvation-resistant wakeups, and live clients.
- [`ExecutionAdmissionRepository`](../../runtime/src/state/execution-admission.ts)
  is the durable authority for queue order, reservations, hierarchical
  allocations, cancellation locks, and decision evidence. Every
  read-check-write transition uses a SQLite `BEGIN IMMEDIATE` transaction.
- The boundary wrappers reserve before work, record the exact dispatch point,
  constrain the call to the admitted maximum, and settle the reservation once.

Run identity is stable across surfaces. A request is identified by
`(runId, stepId)` and has one of three kinds: `model_turn`, `tool_exec`, or
`spawn`. Enqueuing the same identity and request is idempotent; reusing the
identity with different request data is an error. The explicit decisions are
`allow`, `queue`, `deny`, and `approval_required`. Only `allow` carries a
durable reservation.

## Admitted surfaces and fail-closed behavior

Coverage is enforced at execution boundaries rather than duplicated in each
caller:

| Boundary | Covered runtime paths | Dispatch evidence |
| --- | --- | --- |
| Model | Main streamed turns, startup-prewarm attempts and fallback, compaction, tool-use summaries, permission classification, MCP sampling, and model-facing WebSearch/XSearch/WebFetch work | `provider_wire` |
| Tool | Direct and turn-routed tool execution, after permission approval and immediately before `tool.execute` | `tool_effect` |
| Spawn | `AgentControl`, delegate sessions, and legacy agent-hook spawns; child sessions inherit the root allocation and deadline. The dormant pane/team backend is fail-closed because it cannot propagate a parent allocation across processes. | `spawn_commit` |

TUI, print, socket/SDK, and daemon background-agent entry points share the
normal runtime bootstrap, which binds a client and sets `admissionRequired`.
Gateway, hook, cron, or future protocol work receives no special exemption: if
it enters through a runtime session it uses the same boundaries; if an adapter
cannot supply the required session/client, it must deny rather than call a
provider or commit an effect directly.

The legacy model-backed `WebSearchTool` path is disabled with
`legacy_web_search_model_path_disabled`; configured non-model search adapters
remain available and their tool effect is admitted normally. A provider call
outside the shared model wrapper, a tool effect outside the tool wrapper, or a
spawn outside `AgentControl` is an unsupported bypass and must be wired or
disabled before release.

Common fail-closed reasons include:

| Condition | Result |
| --- | --- |
| Required client/kernel is absent or closed | deny (`admission_kernel_unavailable` / `admission_kernel_closed`) |
| Model output has no finite positive maximum | deny (`unbounded_model_output`) |
| Hard USD cap with an unpriced model or a provider lacking authoritative usage and output limits | deny before dispatch |
| Budget exhausted, allocation blocked, parent cancelled, or deadline expired | deny/cancel with a journal reason |
| Policy requests approval | persist `approval_required`; the current client does not auto-approve or bypass it |
| Usage is missing or invalid after dispatch | consume the full reservation as `held_unknown` |
| Provider exceeds the reservation | persist `provider_overrun`, block the allocation, and cancel the run subtree |

Provider-side automatic fallback is not used to make a cap appear satisfied.
Every deliberate model/provider fallback is a visible `fallback` journal
event. Production provider calls are also constrained to the reservation's
admitted `maxOutputTokens`.

## Durable decisions and operator evidence

Admission state is stored in each project database:

```text
$AGENC_HOME/projects/<project-slug>/agenc-state_1.sqlite
```

Schema v14 adds nullable admission columns to the existing `agent_jobs` queue
and the following tables:

| Table | Purpose |
| --- | --- |
| `execution_admission_allocations` | Token/USD limits, used amounts, active holds, parent links, overrun block |
| `execution_admission_reservations` | Unique reservation and exactly-once settlement state |
| `execution_admission_reservation_allocations` | The allocation closure charged by each reservation |
| `execution_admission_cancellations` | Durable run cancellation locks |
| `execution_admission_journal` | Append-only, ordered decision and dispatch evidence |

The normal event path is:

```text
queued -> allowed -> dispatched -> reconciled
                               \-> held_unknown
                               \-> provider_overrun -> subtree cancelled
queued -> denied | approval_required | cancelled
allowed, before dispatch -> voided
```

Journal rows have a monotonically increasing `sequence`, a unique `event_id`,
run/step identity, kind, model/provider, reason, reserved and actual usage, and
boundary-specific `details_json`. Event names are `queued`, `allowed`,
`denied`, `approval_required`, `dispatched`, `reconciled`, `voided`,
`held_unknown`, `provider_overrun`, `cancelled`, `recovered`, and `fallback`.

There is no public mutation/reset RPC for admission accounting. The CLI and SDK
expose bounded run reads, evidence export, and tree cancellation:

```bash
agenc run status <run-id>
agenc run replay <run-id> --after 0 --limit 100
agenc run evidence <run-id> --limit 100
agenc run result <run-id>
agenc run cancel <run-id> --reason "operator stop"
```

The read RPCs search discovered project databases, reject ambiguous run IDs,
and never migrate or create state. Raw SQLite inspection remains available for
operators. For example:

```bash
sqlite3 -readonly "$DB" '
  SELECT sequence, timestamp, run_id, step_id, event, reason,
         provider, model, reserved_tokens, reserved_cost_nanos,
         actual_tokens, actual_cost_nanos
  FROM execution_admission_journal
  ORDER BY sequence DESC LIMIT 100;'

sqlite3 -readonly "$DB" '
  SELECT status, count(*)
  FROM agent_jobs
  WHERE admission_run_id IS NOT NULL
  GROUP BY status ORDER BY status;'
```

USD values are stored as integer nano-USD (`1 USD = 1,000,000,000` nano-USD)
to avoid floating-point conservation errors. Do not edit these tables by hand.
`agenc budget status` is a read-only compatibility view of configured policy.
The old per-surface ledger reset is rejected: v14 reservations, cancellation
locks, and allocations are immutable evidence and can only change through the
kernel's reconciliation/cancellation transitions.

## Hierarchical budgets

Before a charged call, the kernel reserves the conservative maximum against
every applicable scope in one transaction:

- calendar-day and calendar-month token/USD scopes from `[budget]`;
- the run allocation from `[agent.budget]`;
- child-run allocations linked to their parent run allocation.

The complete ancestor closure is checked and held atomically. Siblings can
therefore never reserve more than their shared parent has remaining, even when
they race. A model reservation contains estimated input tokens plus the finite
maximum output tokens. Local tool effects and spawns reserve zero charge but
still consume capacity and produce durable evidence; a model-backed tool makes
its nested provider call through the charged model boundary.

Settlement rules are conservative:

- `reconciled` replaces the hold with authoritative provider-reported usage;
- duplicate reconciliation is a no-op keyed by `reservation_id`;
- pre-dispatch failure/cancellation is `voided` and releases the hold;
- post-dispatch uncertainty is `held_unknown` and consumes the full hold;
- late authoritative usage may replace that conservative charge exactly once;
  a still-unknown late report leaves the hold unchanged;
- an actual token or USD amount above the reservation is
  `provider_overrun`, not ordinary success;
- unpriced work is denied under a hard USD cap, and unknown cost is never
  treated as free.

Allocation limits are immutable once a scope has been created. Changing a
daily/monthly cap during its current calendar window, or changing a cap while
resuming the same run, fails closed instead of silently rebasing previous
reservations. Apply cap changes at a new period/run boundary unless a reviewed
data migration is available.

## Concurrency and durable queue

The defaults are:

| Scope | Default active steps |
| --- | ---: |
| Global daemon | 64 |
| Workspace | 32 |
| Session | 8 |
| Immediate parent | 4 |
| Provider | 16 |

An admitted step must have capacity in every applicable scope. Active capacity
is owned by the one daemon process; durable eligibility and order are owned by
SQLite. Do not run two daemons against the same `AGENC_HOME`.

Queue rows are ordered by priority and durable queue sequence. The live
scheduler promotes work that has waited at least 30 seconds ahead of newer
non-starved work, then uses enqueue time and sequence for deterministic FIFO
ordering. Deadlines are absolute timestamps: expired work is cancelled and is
never dispatched.

The queue survives restart, but an in-memory Promise does not. Startup recovery
reconstructs accounting and queue eligibility before readiness; the owning
session/workflow recovery must reattach and reacquire the same logical step.
Detached rows retain their original priority and queue sequence but are not
runnable, so an owner that never returns cannot head-of-line block attached
work. Reattachment restores eligibility at the durable ordering position.
The kernel never blindly replays work that may already have crossed an external
boundary.

## Restart and cancellation semantics

The daemon opens and recovers every discovered project database before it
becomes ready. A recovery failure aborts daemon startup. Recovery performs the
following repairs transactionally:

- queued work loses stale process ownership but keeps its queue identity;
- a reservation that never reached dispatch is voided and its job requeued;
- a dispatched reservation with no live owner becomes `held_unknown`;
- expired queued/reserved work is cancelled;
- allocation used/held totals and overrun blocks are rebuilt from reservation
  history before new work is admitted.

The daemon reports non-zero recovery counts on stderr as
`admission recovery databases=... requeued=... held_unknown=...`.
`held_unknown` is intentionally conservative: restart never refunds it. A late
authoritative report may reconcile it or make a provider overrun explicit;
otherwise it remains charged until an explicit recorded policy decision.

Cancellation writes a lock for the target run and descendants found through
durable spawn edges and admission parent edges. It then:

- removes queued and approval-waiting work;
- voids reserved-but-undispatched work;
- converts dispatched work to `held_unknown`;
- rejects future admission beneath the cancelled ancestor;
- preserves every terminal row and journal event.

Abort signals and deadlines use the same durable cancellation path. A provider
overrun additionally marks the allocation blocked and terminates descendants.

## Configuration

Concurrency is configured by environment; `agent_max_threads` is the fallback
for the session limit when its dedicated environment variable is absent:

| Environment variable | Scope | Default |
| --- | --- | ---: |
| `AGENC_ADMISSION_GLOBAL_CONCURRENCY` | Daemon | 64 |
| `AGENC_ADMISSION_WORKSPACE_CONCURRENCY` | Workspace | 32 |
| `AGENC_ADMISSION_SESSION_CONCURRENCY` | Session | 8 / `agent_max_threads` |
| `AGENC_ADMISSION_PARENT_CONCURRENCY` | Immediate parent | 4 |
| `AGENC_ADMISSION_PROVIDER_CONCURRENCY` | Provider | 16 |

Values must be positive safe integers; invalid or non-positive values fall
back to the configured/default value. Environment changes require a daemon
restart. `agenc daemon reload` can apply a changed `agent_max_threads`, using
the daemon's existing environment for the other limits.

Budget policy uses the existing configuration:

```toml
agent_max_threads = 8

[budget]
enabled = true
daily_usd = 5.0
monthly_usd = 50.0
# daily_tokens = 2_000_000
# monthly_tokens = 20_000_000
enforce_interactive = false

[agent.budget]
# token_cap = 500_000
# dollar_cap = 2.0
# wall_clock_seconds = 3600
```

`[budget]` windows apply when enabled to autonomous work, and to interactive
work only when `enforce_interactive` is true. Their environment overrides are
`AGENC_BUDGET`, `AGENC_BUDGET_DAILY_USD`,
`AGENC_BUDGET_MONTHLY_USD`, `AGENC_BUDGET_DAILY_TOKENS`,
`AGENC_BUDGET_MONTHLY_TOKENS`, and
`AGENC_BUDGET_ENFORCE_INTERACTIVE`. `[agent.budget]` is a per-run hard cap;
`wall_clock_seconds` becomes a durable absolute deadline. Empty/disabled
budget configuration removes spend caps, not admission or concurrency.
`soft_threshold` / `AGENC_BUDGET_SOFT_THRESHOLD` remains warning policy and
does not alter a hard admission reservation.

## Responsive control plane (schema v13)

Admission load must not starve control operations. `session.list` defaults to
50 rows, is capped at 100, and uses opaque filter-scoped cursors. Persisted
thread pages use indexed `(timestamp, thread_id)` keyset seeks rather than
materializing total history, and storage work runs outside the session lock.

On stdio and WebSocket, cancel and interactive decisions plus bounded health,
status, attach, and session lookup RPCs use a priority lane. They wait for
connection initialization/authentication but do not wait behind a full
streaming turn. Read-only priority requests remain subject to connection
overload limits; only cancellation controls are overload-exempt.

Schema v13 supplies partial active/archived indexes for both `created_at` and
`updated_at`, with `thread_id` as the deterministic keyset tie-breaker.

## Migration compatibility

State migrations are per-project, ordered, transactional, and idempotent. The
daemon migrates every existing project database during startup and migrates a
newly discovered project before its first admission.

| Version | Change | Compatibility |
| --- | --- | --- |
| 13 `thread_listing_indexes` | Adds four partial thread-listing indexes | Data shape unchanged; indexes may remain permanently |
| 14 `execution_admission_schema` | Adds nullable admission columns to `agent_jobs` and five admission tables | Legacy queue rows remain unchanged with `admission_run_id = NULL` |

Upgrading from v13 to v14 is supported directly. The current runtime also
applies both migrations to older databases in order. An older runtime whose
maximum known schema is v13 or below deliberately refuses to open a v14
database with `StateSchemaMismatchError`; it will not silently ignore newer
admission state.

There is no automatic pre-v14 backup and no downgrade migration. The existing
`pre-v12` backup artifact is unrelated and must not be used as an M3 rollback
plan.

## Rollout

1. Verify the exact release SHA with typecheck, the full test suite, runtime PTY
   startup, the 100-child budget/concurrency fault test, and control-RPC load
   tests.
2. Stop the daemon and all foreground AgenC processes. Snapshot every project
   state database with SQLite's backup command, or snapshot the complete
   stopped `$AGENC_HOME/projects` tree including WAL files. Keep this as the
   pre-v14 rollback set.
3. Set conservative concurrency limits and explicit budget policy. Confirm the
   chosen capped provider/model advertises a finite output bound and
   authoritative usage.
4. Start the daemon in the foreground for the first canary. Startup must reach
   ready without `execution admission recovery failed` or schema errors.
5. Verify `schema_migrations` reports versions 13 and 14 in each discovered
   project DB. Inspect queue/reservation counts and the first journal events
   read-only.
6. Canary one model turn, one approved tool, one child spawn, a saturated queue,
   and parent cancellation. Verify `queued -> allowed -> dispatched` evidence
   and the expected settlement for each.
7. Exercise `health.*`, status, cancellation, and paginated `session.list`
   while a stream is blocked. Then expand traffic gradually while watching
   `held_unknown`, `provider_overrun`, queue age, and recovery messages.

## Safe rollback

Prefer a roll-forward fix that still understands schema v14. Keeping the v14
schema is safe; migrations are idempotent and additive.

If rollback to a pre-v14 runtime is unavoidable:

1. Block new work, stop every daemon/foreground process, and preserve the live
   v14 project tree as evidence.
2. Do **not** delete migration row 14, drop admission tables, clear holds, or
   rewrite statuses. That can manufacture budget and side-effect ambiguity.
3. Restore the complete pre-v14 snapshot into a separate/staged
   `AGENC_HOME`, validate it, then point the older runtime at that restored
   home. A pre-v14 runtime will correctly reject the live v14 database.
4. Keep execution ingress closed until the restored daemon is healthy. Be
   explicit that restoring the snapshot discards post-snapshot state; retain
   the v14 tree for later reconciliation.

If post-migration work cannot be discarded, do not downgrade. Leave execution
stopped or fail closed and deploy a v14-aware repair. There is currently no
supported merge from v14 admission history into a restored v13 database.
