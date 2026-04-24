/**
 * Task dispatch subsystem for the AgenC session kernel.
 *
 * Port of the upstream codex task-dispatch machinery:
 *   - `codex-rs/core/src/tasks/mod.rs` — `spawn_task`, `start_task`,
 *     `abort_all_tasks`, `on_task_finished`, `handle_task_abort`, and
 *     the `SessionTask` / `AnySessionTask` traits.
 *   - `codex-rs/core/src/state/turn.rs` — `ActiveTurn`, `TurnState`,
 *     `RunningTask`, `TaskKind`, `MailboxDeliveryPhase`.
 *
 * Purpose. Session holds a single `active_turn` slot. Codex guarantees
 * the outer "one turn in flight at a time" contract by taking the
 * `active_turn` mutex at every state-mutation site AND by routing task
 * spawn/abort through `spawn_task` (which calls `abort_all_tasks` on
 * re-entry). Before this port, gut's `runTurnKernel` never took the
 * `activeTurn` lock; a slash command calling `session.runTurn`
 * concurrently with a rollout-replay path could race on `session.state`.
 * This module fixes that by porting the `spawn_task` → `abort_all_tasks`
 * → `start_task` → `on_task_finished` lifecycle faithfully.
 *
 * Layout choice (Option A). The task-dispatch types live here;
 * `Session.spawnTask`, `Session.onTaskFinished`, and
 * `Session.abortAllTasks` are methods on `Session` in `session.ts` so
 * they can reach private slots without friction. This mirrors codex's
 * own layout (types in `state/turn.rs`, impls on `Session` in
 * `tasks/mod.rs` via `impl Session { ... }`).
 *
 * TurnState naming note. Gut already has `runtime/src/session/turn-state.ts`
 * defining a per-iteration phase-machine loop state (24 fields:
 * messages, assistantMessages, toolUseBlocks, etc.). That type is a
 * DIFFERENT concept from upstream codex `state/turn.rs::TurnState`,
 * which carries 11 fields of turn-local, lock-guarded state (pending
 * approvals, pending input, mailbox delivery phase, granted
 * permissions, tool-call counter, memory-citation flag, token usage
 * at turn start, etc.). To avoid collision with the phase-machine
 * `TurnState`, the codex-style struct is named `ActiveTurnState` here.
 *
 * @module
 */

import type { AsyncLock } from "../utils/async-lock.js";

/**
 * Upstream codex `tasks/mod.rs::TaskKind`. String-union keeps JS
 * switch/compare semantics ergonomic without importing an enum type.
 * The full set from codex includes Regular, Compact, Review, plus
 * Ghost/Undo/UserShell; we port the three referenced by forthcoming
 * work (steer-input gate needs Regular vs Review vs Compact) and
 * leave room to add more when their tasks land.
 */
export type TaskKind = "regular" | "compact" | "review";

/**
 * Upstream codex `protocol/src/protocol.rs::TurnAbortReason`. String
 * union mirroring the three enum arms.
 *
 *   - `interrupted` — user-triggered cancel (Ctrl-C / interrupt event).
 *   - `replaced` — a new turn spawned while this one was in flight
 *     (codex `spawn_task` calls `abort_all_tasks(TurnAbortReason::Replaced)`).
 *   - `review_ended` — review session concluded.
 */
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

/**
 * Upstream codex `state/turn.rs::MailboxDeliveryPhase`.
 *
 *   - `current_turn` — late mailbox mail may still fold into this turn.
 *   - `next_turn` — this turn already emitted visible final text; mail
 *     remains queued for a later turn.
 */
export type MailboxDeliveryPhase = "current_turn" | "next_turn";

/**
 * Upstream codex `state/turn.rs::RunningTask`. Fields:
 *
 *   - `subId` — turn/sub identifier; key in the `tasks` registry.
 *   - `kind` — upstream codex `TaskKind`.
 *   - `abortController` — upstream codex `CancellationToken` translated
 *     per `docs/plan/translation-conventions.md`. Firing this aborts
 *     the task's own cancellation surface. The running kernel's
 *     `mergeSignals(opts.signal, session.abortController.signal)`
 *     already covers session-level abort; this controller is the
 *     task-local layer that `abort_all_tasks` triggers for `Replaced`.
 *   - `done` — resolves when the task finishes, success or cancel.
 *     Upstream uses `Arc<Notify>`; JS equivalent is a Promise + its
 *     resolve handle. `abortAllTasks` awaits `done` under a bounded
 *     timeout so callers see graceful shutdown before the new turn
 *     proceeds, matching upstream codex `tasks/mod.rs::handle_task_abort`.
 *   - `startedAtMs` — wall clock for telemetry / `turn_complete`
 *     duration math.
 */
export interface RunningTask {
  readonly subId: string;
  readonly kind: TaskKind;
  readonly abortController: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly startedAtMs: number;
}

/**
 * Upstream codex `state/turn.rs::TurnState`. Per-turn state held under
 * its own lock inside `ActiveTurn`. Gut exposes the 11 fields so later
 * waves can wire consumers without schema churn. Each field below is
 * classified per its current gut status:
 *
 *   WIRED-NOW — has a live gut producer/consumer that goes through
 *     `session.withActiveTurnState(...)` (or is seeded under the lock
 *     at `spawnTask` entry).
 *
 *   WIRED-EXTERNAL — has a gut consumer, but that consumer owns its
 *     own serialization surface (e.g. `SimpleMailbox` for input
 *     routing) and cannot be migrated to the `ActiveTurnState` lock
 *     without reshaping the consumer's protocol. The field stays
 *     present so a future refactor can bridge into the lock.
 *
 *   SLOT-ONLY — no gut consumer today. Field reserved so upstream
 *     codex mutation sites can be ported without schema churn. Each
 *     SLOT-ONLY field carries a `RESERVED:` breadcrumb citing the
 *     upstream `session/mod.rs` lock site(s) it will connect to.
 *
 * Current classification (2026-04 Part 4):
 *   WIRED-NOW:
 *     - `toolCalls` — incremented inside
 *       `tools/router.ts::dispatchModelToolCall` under the
 *       `ActiveTurnState` lock; mirrors upstream
 *       `tools/registry.rs:303-309`.
 *     - `tokenUsageAtTurnStart` — seeded under the lock in
 *       `Session.spawnTask`.
 *
 *   WIRED-EXTERNAL:
 *     - `pendingInput` — gut routes pending input through
 *       `SimpleMailbox` (see `session.ts::enqueueIdleInput` /
 *       `hasPendingInput` / `drainIdleInput`). Migration would
 *       require reshaping the mailbox envelope protocol and is out of
 *       scope here.
 *     - `mailboxDeliveryPhase` — tied to the same mailbox external
 *       routing; upstream mutates it through
 *       `session/mod.rs::defer_mailbox_delivery_to_next_turn` and
 *       `accept_mailbox_delivery_for_current_turn`, which have no gut
 *       counterpart independent of the mailbox consumer above.
 *
 *   SLOT-ONLY:
 *     - `pendingApprovals`, `pendingRequestPermissions`,
 *       `pendingUserInput`, `pendingElicitations`,
 *       `pendingDynamicTools`, `grantedPermissions`,
 *       `strictAutoReviewEnabled`, `hasMemoryCitation`.
 *
 * Abort-path cleanup still runs in `Session.abortAllTasksLocked`,
 * clearing all pending-* maps under the same lock. That keeps the
 * invariant "a replaced turn never surfaces stale responses" even
 * for SLOT-ONLY fields, so a future consumer inheriting the slot does
 * not need to re-implement the clear contract.
 */
export interface ActiveTurnState {
  // RESERVED: upstream codex session/mod.rs:1812 (exec approval insert),
  // mod.rs:1880 (apply-patch approval insert), mod.rs:2299 (notify_approval
  // remove). Gut approval flow uses closure-based `ApprovalRequestFn`
  // (tools/execution.ts:368) rather than a keyed registry; the slot is
  // reserved for the T11 approval-RPC port.
  /** Upstream `pending_approvals`. SLOT-ONLY. */
  pendingApprovals: Map<string, (decision: unknown) => void>;
  // RESERVED: upstream codex session/mod.rs:2036 (request_permissions
  // insert), mod.rs:2067 (cancellation remove), mod.rs:2153
  // (notify_request_permissions_response remove).
  /** Upstream `pending_request_permissions`. SLOT-ONLY. */
  pendingRequestPermissions: Map<string, unknown>;
  // RESERVED: upstream codex session/mod.rs:2092 (request_user_input
  // insert), mod.rs:2124 (notify_user_input_response remove).
  /** Upstream `pending_user_input`. SLOT-ONLY. */
  pendingUserInput: Map<string, (response: unknown) => void>;
  // RESERVED: upstream codex elicitation surface (MCP elicitation
  // callback registry). Gut's `Session.outOfBandElicitationPaused`
  // carries only the paused-state BehaviorSubject; no elicitation
  // callback is kept in a keyed registry yet.
  /** Upstream `pending_elicitations`. SLOT-ONLY. */
  pendingElicitations: Map<string, (response: unknown) => void>;
  // RESERVED: upstream codex session/mod.rs:2274 (notify_dynamic_tool_response
  // remove). Gut has no dynamic-tool-response surface yet.
  /** Upstream `pending_dynamic_tools`. SLOT-ONLY. */
  pendingDynamicTools: Map<string, (response: unknown) => void>;
  // WIRED-EXTERNAL: consumed via `session.ts::SimpleMailbox`
  // (`enqueueIdleInput` / `hasPendingInput` / `drainIdleInput`).
  // Upstream codex sites: session/mod.rs:2948 (steer_input push),
  // mod.rs:3001 (inject_response_items), tasks/mod.rs:484
  // (on_task_finished drain).
  /** Upstream `pending_input`. WIRED-EXTERNAL (SimpleMailbox). */
  pendingInput: unknown[];
  // WIRED-EXTERNAL: tied to the same mailbox consumer above. Upstream
  // codex sites: session/mod.rs:3018 (defer_mailbox_delivery_to_next_turn),
  // mod.rs:3030 (accept_mailbox_delivery_for_current_turn).
  /** Upstream `mailbox_delivery_phase`. WIRED-EXTERNAL (mailbox). */
  mailboxDeliveryPhase: MailboxDeliveryPhase;
  // RESERVED: upstream codex session/mod.rs:2244 (granted_turn_permissions
  // read). Gut has no per-turn permission-grant storage yet; permissions
  // are evaluated through `permissions/evaluator.ts` without a turn-scoped
  // grant cache.
  /** Upstream `granted_permissions`. SLOT-ONLY. */
  grantedPermissions: unknown | null;
  // RESERVED: upstream codex session/mod.rs:2255
  // (strict_auto_review_enabled_for_turn read). No review subsystem in gut.
  /** Upstream `strict_auto_review_enabled`. SLOT-ONLY. */
  strictAutoReviewEnabled: boolean;
  // WIRED-NOW: incremented in `tools/router.ts::dispatchModelToolCall`
  // via `session.withActiveTurnState(...)`. Mirrors upstream
  // `tools/registry.rs:303-309` (saturating add before dispatch). No
  // gut reader yet; upstream reads in `tasks/mod.rs:486` at
  // `on_task_finished` for turn-complete telemetry.
  /** Upstream `tool_calls` counter. WIRED-NOW (dispatchModelToolCall). */
  toolCalls: number;
  // RESERVED: upstream codex session/mod.rs:3046
  // (record_memory_citation_for_turn write), tasks/mod.rs:485
  // (on_task_finished read). Gut has no memory subsystem yet.
  /** Upstream `has_memory_citation`. SLOT-ONLY. */
  hasMemoryCitation: boolean;
  // WIRED-NOW: seeded under the lock in `Session.spawnTask`
  // (session.ts:1528-1534) when the caller supplies
  // `opts.tokenUsageAtTurnStart`. Upstream reads in `tasks/mod.rs:487`
  // at `on_task_finished` to compute per-turn token-usage delta; the
  // matching gut reader is future work (telemetry hook).
  /** Upstream `token_usage_at_turn_start`. WIRED-NOW (seeded at spawn). */
  tokenUsageAtTurnStart: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Fresh `ActiveTurnState` with all pending maps empty and the tool-call
 * counter at zero. Matches upstream `#[derive(Default)] struct TurnState`.
 */
export function createActiveTurnState(): ActiveTurnState {
  return {
    pendingApprovals: new Map(),
    pendingRequestPermissions: new Map(),
    pendingUserInput: new Map(),
    pendingElicitations: new Map(),
    pendingDynamicTools: new Map(),
    pendingInput: [],
    mailboxDeliveryPhase: "current_turn",
    grantedPermissions: null,
    strictAutoReviewEnabled: false,
    toolCalls: 0,
    hasMemoryCitation: false,
    tokenUsageAtTurnStart: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

/**
 * Upstream codex `tasks/mod.rs:62` — graceful interruption timeout
 * before force-aborting. Keep the same ms budget so behavior matches.
 */
export const GRACEFUL_INTERRUPTION_TIMEOUT_MS = 100;

/**
 * Options accepted by `Session.spawnTask`. Mirrors upstream codex
 * `spawn_task` signature modulo the TS-native AbortController.
 */
export interface SpawnTaskOptions {
  readonly subId: string;
  readonly kind: TaskKind;
  readonly startedAtMs?: number;
  /**
   * Optional externally-supplied controller. When omitted, spawnTask
   * allocates a fresh one so the caller can pull `.signal` for the
   * kernel loop (matches existing bin/agenc.ts flow).
   */
  readonly abortController?: AbortController;
  /** Upstream `token_usage_at_turn_start`. Captured at task start. */
  readonly tokenUsageAtTurnStart?: ActiveTurnState["tokenUsageAtTurnStart"];
}

/**
 * Create a `done` promise + its resolver handle. Upstream uses
 * `Arc<Notify>` + `done.notified()`; a JS Promise resolved from a
 * captured handle is the idiomatic equivalent.
 */
export function createDoneHandle(): {
  done: Promise<void>;
  resolveDone: () => void;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { done, resolveDone };
}

/**
 * Bounded wait for the task's `done` signal, mirroring upstream
 * `tokio::select!` between `done.notified()` and a `sleep(timeout)`.
 * Returns true if the task signalled done within the budget, false on
 * timeout so callers can note the non-graceful case in telemetry.
 */
export async function waitForDoneWithin(
  done: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<boolean>([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Session-facing contract for the active-turn lock. The concrete
 * `AsyncLock<ActiveTurn | null>` stored on `Session` implements this
 * shape; exporting the type lets tests and adapters typecheck without
 * a circular dep on `session.ts`.
 */
export interface ActiveTurnLike {
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly abortController: AbortController;
  readonly tasks: Map<string, RunningTask>;
  readonly turnState: AsyncLock<ActiveTurnState>;
}
