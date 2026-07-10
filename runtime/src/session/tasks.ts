/**
 * Task dispatch subsystem for the AgenC session kernel.
 *
 * Port of the upstream agenc runtime task-dispatch machinery:
 *   - `agenc-rs/core/src/tasks/mod.rs` — `spawn_task`, `start_task`,
 *     `abort_all_tasks`, `on_task_finished`, `handle_task_abort`, and
 *     the `SessionTask` / `AnySessionTask` traits.
 *   - `agenc-rs/core/src/state/turn.rs` — `ActiveTurn`, `TurnState`,
 *     `RunningTask`, `TaskKind`, `MailboxDeliveryPhase`.
 *
 * Purpose. Session holds a single `active_turn` slot. agenc runtime guarantees
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
 * they can reach private slots without friction. This mirrors agenc runtime's
 * own layout (types in `state/turn.rs`, impls on `Session` in
 * `tasks/mod.rs` via `impl Session { ... }`).
 *
 * TurnState naming note. Gut already has `runtime/src/session/turn-state.ts`
 * defining a per-iteration phase-machine loop state (24 fields:
 * messages, assistantMessages, toolUseBlocks, etc.). That type is a
 * DIFFERENT concept from upstream agenc runtime `state/turn.rs::TurnState`,
 * which carries 11 fields of turn-local, lock-guarded state (pending
 * approvals, pending input, mailbox delivery phase, granted
 * permissions, tool-call counter, memory-citation flag, token usage
 * at turn start, etc.). To avoid collision with the phase-machine
 * `TurnState`, the AgenC-style struct is named `ActiveTurnState` here.
 *
 * @module
 */

import type { AsyncLock } from "../utils/async-lock.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import type { PhaseEvent } from "../phases/events.js";

/**
 * Upstream agenc runtime `tasks/mod.rs::TaskKind`. String-union keeps JS
 * switch/compare semantics ergonomic without importing an enum type.
 * The full set from agenc runtime includes Regular, Compact, Review, plus
 * Ghost/Undo/UserShell; we port the three referenced by forthcoming
 * work (steer-input gate needs Regular vs Review vs Compact) and
 * leave room to add more when their tasks land.
 */
export type TaskKind = "regular" | "compact" | "review";

/**
 * Upstream agenc runtime `protocol/src/protocol.rs::TurnAbortReason`. String
 * union mirroring the three enum arms.
 *
 *   - `interrupted` — user-triggered cancel (Ctrl-C / interrupt event).
 *   - `replaced` — a new turn spawned while this one was in flight
 *     (agenc runtime `spawn_task` calls `abort_all_tasks(TurnAbortReason::Replaced)`).
 *   - `review_ended` — review session concluded.
 */
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

/**
 * Upstream agenc runtime `state/turn.rs::MailboxDeliveryPhase`.
 *
 *   - `current_turn` — late mailbox mail may still fold into this turn.
 *   - `next_turn` — this turn already emitted visible final text; mail
 *     remains queued for a later turn.
 */
export type MailboxDeliveryPhase = "current_turn" | "next_turn";

export interface SessionTaskContext {
  readonly session: Session;
  cloneSession(): Session;
}

export function createSessionTaskContext(session: Session): SessionTaskContext {
  return {
    session,
    cloneSession: () => session,
  };
}

export interface SessionTaskRunContext {
  readonly session: SessionTaskContext;
  readonly turnContext: TurnContext;
  readonly input: readonly unknown[];
  readonly signal: AbortSignal;
  readonly emit?: (event: PhaseEvent) => void;
}

export interface SessionTaskAbortContext {
  readonly session: SessionTaskContext;
  readonly turnContext: TurnContext;
}

export interface SessionTask {
  kind(): TaskKind;
  spanName(): string;
  run(ctx: SessionTaskRunContext): Promise<unknown>;
  abort(ctx: SessionTaskAbortContext): Promise<void>;
}

export type AnySessionTask = SessionTask;

/**
 * Upstream agenc runtime `state/turn.rs::RunningTask`. Fields:
 *
 *   - `subId` — turn/sub identifier; key in the `tasks` registry.
 *   - `kind` — upstream agenc runtime `TaskKind`.
 *   - `abortController` — upstream agenc runtime `CancellationToken` translated
 *     per `docs/plan/translation-conventions.md`. Firing this aborts
 *     the task's own cancellation surface. The running kernel's
 *     `mergeSignals(opts.signal, session.abortController.signal)`
 *     already covers session-level abort; this controller is the
 *     task-local layer that `abort_all_tasks` triggers for `Replaced`.
 *   - `done` — resolves when the task finishes, success or cancel.
 *     Upstream uses `Arc<Notify>`; JS equivalent is a Promise + its
 *     resolve handle. `abortAllTasks` awaits `done` under a bounded
 *     timeout so callers see graceful shutdown before the new turn
 *     proceeds, matching upstream agenc runtime `tasks/mod.rs::handle_task_abort`.
 *   - `startedAtMs` — wall clock for telemetry / `turn_complete`
 *     duration math.
 */
export interface RunningTask {
  readonly subId: string;
  readonly kind: TaskKind;
  readonly task?: AnySessionTask;
  readonly turnContext?: TurnContext;
  handle?: Promise<unknown>;
  readonly abortController: AbortController;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  readonly startedAtMs: number;
}

/**
 * Upstream agenc runtime `state/turn.rs::TurnState`. Per-turn state held under
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
 *     agenc runtime mutation sites can be ported without schema churn. Each
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
  // RESERVED: upstream agenc runtime session/mod.rs:1812 (exec approval insert),
  // mod.rs:1880 (apply-patch approval insert), mod.rs:2299 (notify_approval
  // remove). Gut approval flow uses closure-based `ApprovalRequestFn`
  // (tools/execution.ts:368) rather than a keyed registry; the slot is
  // reserved for the T11 approval-RPC port.
  /** Upstream `pending_approvals`. SLOT-ONLY. */
  pendingApprovals: Map<string, (decision: unknown) => void>;
  // RESERVED: upstream agenc runtime session/mod.rs:2036 (request_permissions
  // insert), mod.rs:2067 (cancellation remove), mod.rs:2153
  // (notify_request_permissions_response remove).
  /** Upstream `pending_request_permissions`. SLOT-ONLY. */
  pendingRequestPermissions: Map<string, unknown>;
  // RESERVED: upstream agenc runtime session/mod.rs:2092 (request_user_input
  // insert), mod.rs:2124 (notify_user_input_response remove).
  /** Upstream `pending_user_input`. SLOT-ONLY. */
  pendingUserInput: Map<string, (response: unknown) => void>;
  // RESERVED: upstream agenc runtime elicitation surface (MCP elicitation
  // callback registry). Gut's `Session.outOfBandElicitationPaused`
  // carries only the paused-state BehaviorSubject; no elicitation
  // callback is kept in a keyed registry yet.
  /** Upstream `pending_elicitations`. SLOT-ONLY. */
  pendingElicitations: Map<string, (response: unknown) => void>;
  // RESERVED: upstream agenc runtime session/mod.rs:2274 (notify_dynamic_tool_response
  // remove). Gut has no dynamic-tool-response surface yet.
  /** Upstream `pending_dynamic_tools`. SLOT-ONLY. */
  pendingDynamicTools: Map<string, (response: unknown) => void>;
  // WIRED-EXTERNAL: consumed via `session.ts::SimpleMailbox`
  // (`enqueueIdleInput` / `hasPendingInput` / `drainIdleInput`).
  // Upstream agenc runtime sites: session/mod.rs:2948 (steer_input push),
  // mod.rs:3001 (inject_response_items), tasks/mod.rs:484
  // (on_task_finished drain).
  /** Upstream `pending_input`. WIRED-EXTERNAL (SimpleMailbox). */
  pendingInput: unknown[];
  // WIRED-EXTERNAL: tied to the same mailbox consumer above. Upstream
  // agenc runtime sites: session/mod.rs:3018 (defer_mailbox_delivery_to_next_turn),
  // mod.rs:3030 (accept_mailbox_delivery_for_current_turn).
  /** Upstream `mailbox_delivery_phase`. WIRED-EXTERNAL (mailbox). */
  mailboxDeliveryPhase: MailboxDeliveryPhase;
  // RESERVED: upstream agenc runtime session/mod.rs:2244 (granted_turn_permissions
  // read). Gut has no per-turn permission-grant storage yet; permissions
  // are evaluated through `permissions/evaluator.ts` without a turn-scoped
  // grant cache.
  /** Upstream `granted_permissions`. SLOT-ONLY. */
  grantedPermissions: unknown | null;
  // RESERVED: upstream agenc runtime session/mod.rs:2255
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
  /** One-shot claim preventing duplicate Ledger transfers in one human turn. */
  ledgerTransferClaimed: boolean;
  // RESERVED: upstream agenc runtime session/mod.rs:3046
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
    ledgerTransferClaimed: false,
    hasMemoryCitation: false,
    tokenUsageAtTurnStart: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

export function pushPendingInput(
  state: ActiveTurnState,
  input: unknown,
): void {
  state.pendingInput.push(input);
}

export function prependPendingInput(
  state: ActiveTurnState,
  input: readonly unknown[],
): void {
  if (input.length === 0) return;
  state.pendingInput = [...input, ...state.pendingInput];
}

export function takePendingInput(state: ActiveTurnState): unknown[] {
  if (state.pendingInput.length === 0) return [];
  const pending = state.pendingInput;
  state.pendingInput = [];
  return pending;
}

export function acceptMailboxDeliveryForCurrentTurn(
  state: ActiveTurnState,
): void {
  state.mailboxDeliveryPhase = "current_turn";
}

export function deferMailboxDeliveryToNextTurn(
  state: ActiveTurnState,
): void {
  state.mailboxDeliveryPhase = "next_turn";
}

export function acceptsMailboxDeliveryForCurrentTurn(
  state: ActiveTurnState,
): boolean {
  return state.mailboxDeliveryPhase === "current_turn";
}

/**
 * Upstream agenc runtime `tasks/mod.rs:62` — graceful interruption timeout
 * before force-aborting. Keep the same ms budget so behavior matches.
 */
export const GRACEFUL_INTERRUPTION_TIMEOUT_MS = 100;

/**
 * Options accepted by `Session.spawnTask`. Mirrors upstream agenc runtime
 * `spawn_task` signature modulo the TS-native AbortController.
 */
export interface SpawnTaskOptions {
  readonly subId: string;
  readonly kind: TaskKind;
  readonly task?: AnySessionTask;
  readonly turnContext?: TurnContext;
  readonly input?: readonly unknown[];
  readonly autoStart?: boolean;
  readonly startedAtMs?: number;
  /**
   * Exact user-visible text for the root human input that created this turn.
   * Kept on ActiveTurn (rather than inferred from history) because tools can
   * execute before the current seed message is committed to session history.
   */
  readonly rootHumanTurnText?: string;
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

// ─────────────────────────────────────────────────────────────────────
// Steer-input surface
//
// Port of upstream agenc runtime `session/mod.rs::steer_input` +
// `SteerInputError` (`session/mod.rs:213`). `steer_input` folds
// user-provided items into an in-flight turn. The non-negotiable
// contract is that only `regular` turns accept steering; `compact`
// and `review` turns reject with `ActiveTurnNotSteerable` because
// mid-stream user prompts would corrupt the managed pipeline those
// tasks run (summary generation, review handoff).
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `protocol/src/protocol.rs::NonSteerableTurnKind`
 * (`protocol.rs:1964`). The two kinds that reject same-turn steering.
 *
 * Kept as a string union to mirror gut's `TaskKind` style and serialize
 * cleanly when surfaced through event payloads or error reporting.
 */
export type NonSteerableTurnKind = "review" | "compact";

/**
 * Upstream agenc runtime `TaskKind::is_steerable`-equivalent predicate. Returns
 * `true` when a task of this kind can absorb mid-stream user prompts
 * via `steer_input`.
 *
 * Contract mirrors `session/mod.rs:2966-2979`:
 *   - `regular` → steerable.
 *   - `compact`, `review` → NOT steerable; steer calls are rejected
 *     with `SteerInputError::ActiveTurnNotSteerable`.
 *
 * Keeping this as a free function (instead of a method on `TaskKind`)
 * matches how upstream agenc runtime distinguishes the cases via a `match` arm
 * rather than a trait method; both are direct port styles and the free
 * function stays trivially callable from `Session.steerInput`, tests,
 * and any future gate site.
 */
export function isSteerable(kind: TaskKind): boolean {
  switch (kind) {
    case "regular":
      return true;
    case "compact":
    case "review":
      return false;
  }
}

/**
 * Maps a non-steerable `TaskKind` back onto the upstream
 * `NonSteerableTurnKind` discriminator so `SteerInputError` payloads
 * use the same label surface agenc runtime emits.
 *
 * Returns `null` when the kind is steerable (caller should not raise
 * `ActiveTurnNotSteerable` in that case).
 */
export function nonSteerableTurnKindFrom(
  kind: TaskKind,
): NonSteerableTurnKind | null {
  switch (kind) {
    case "regular":
      return null;
    case "compact":
      return "compact";
    case "review":
      return "review";
  }
}

/**
 * Upstream agenc runtime `session/mod.rs::SteerInputError` (`session/mod.rs:213`).
 * Discriminated union so callers can switch on `kind` and pull the
 * variant-specific payload without downcasts.
 *
 * Variant mapping vs upstream:
 *   - `no_active_turn` ↔ upstream `NoActiveTurn(Vec<UserInput>)`. Gut
 *     carries the rejected items back to the caller so they can retry
 *     or surface them to the user without loss.
 *   - `sub_id_mismatch` ↔ upstream `ExpectedTurnMismatch { expected,
 *     actual }`. Renamed to `sub_id_mismatch` to match gut's `subId`
 *     naming on `RunningTask` / `spawnTask`; the payload is identical
 *     modulo field names.
 *   - `active_turn_not_steerable` ↔ upstream
 *     `ActiveTurnNotSteerable { turn_kind }`. Same shape.
 *   - `empty_input` ↔ upstream `EmptyInput`. No payload.
 */
export type SteerInputError =
  | { readonly kind: "no_active_turn"; readonly items: readonly unknown[] }
  | {
      readonly kind: "sub_id_mismatch";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: "active_turn_not_steerable";
      readonly turnKind: NonSteerableTurnKind;
    }
  | { readonly kind: "empty_input" };

/**
 * Result of a successful `steerInput` call. Mirrors upstream's
 * `Result<String, SteerInputError>` success arm which returns the
 * active turn id; gut returns the same subId so callers can correlate
 * the steer to the turn it merged into.
 */
export interface SteerInputAccepted {
  readonly ok: true;
  readonly subId: string;
  readonly accepted: number;
}

export interface SteerInputRejected {
  readonly ok: false;
  readonly error: SteerInputError;
}

export type SteerInputResult = SteerInputAccepted | SteerInputRejected;

/**
 * Build a `SteerInputError` with a friendly human-readable message,
 * used for Event emission and telemetry. Mirrors upstream
 * `SteerInputError::to_error_event` (`session/mod.rs:220-248`) — gut
 * returns a `{ message }` tuple instead of the upstream
 * `ErrorEvent` so callers can assemble their own event envelopes
 * without a cross-module dep on event-log here.
 */
export function describeSteerInputError(err: SteerInputError): {
  readonly message: string;
  readonly code: string;
} {
  switch (err.kind) {
    case "no_active_turn":
      return { message: "no active turn to steer", code: "bad_request" };
    case "sub_id_mismatch":
      return {
        message: `expected active turn id \`${err.expected}\` but found \`${err.actual}\``,
        code: "bad_request",
      };
    case "active_turn_not_steerable":
      return {
        message: `cannot steer a ${err.turnKind} turn`,
        code: "active_turn_not_steerable",
      };
    case "empty_input":
      return { message: "input must not be empty", code: "bad_request" };
  }
}
