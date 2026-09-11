/**
 * Task dispatch subsystem for the AgenC session kernel.
 *
 * Covers the task-dispatch machinery: `spawnTask`, `startTask`,
 * `abortAllTasks`, `onTaskFinished`, task abort handling, and the
 * `SessionTask` / `AnySessionTask` contracts, plus the turn-local types
 * `ActiveTurn`, `ActiveTurnState`, `RunningTask`, `TaskKind`, and
 * `MailboxDeliveryPhase`.
 *
 * Purpose. Session holds a single `activeTurn` slot. The outer "one turn
 * in flight at a time" contract holds by taking the `activeTurn` lock at
 * every state-mutation site AND by routing task spawn/abort through
 * `spawnTask` (which calls `abortAllTasks` on re-entry). Previously,
 * gut's `runTurnKernel` never took the `activeTurn` lock; a slash
 * command calling `session.runTurn` concurrently with a rollout-replay
 * path could race on `session.state`. This module fixes that with the
 * `spawnTask` -> `abortAllTasks` -> `startTask` -> `onTaskFinished`
 * lifecycle.
 *
 * Layout choice (Option A). The task-dispatch types live here;
 * `Session.spawnTask`, `Session.onTaskFinished`, and
 * `Session.abortAllTasks` are methods on `Session` in `session.ts` so
 * they can reach private slots without friction.
 *
 * TurnState naming note. Gut already has `runtime/src/session/turn-state.ts`
 * defining a per-iteration phase-machine loop state (24 fields:
 * messages, assistantMessages, toolUseBlocks, etc.). That type is a
 * DIFFERENT concept from the turn-local, lock-guarded state kept here
 * (pending approvals, pending input, mailbox delivery phase, granted
 * permissions, tool-call counter, memory-citation flag, token usage
 * at turn start, etc.). To avoid collision with the phase-machine
 * `TurnState`, the lock-guarded struct is named `ActiveTurnState` here.
 *
 * @module
 */

import type { AsyncLock } from "../utils/async-lock.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import type { PhaseEvent } from "../phases/events.js";

/**
 * Kind of task running in a turn. String-union keeps JS switch/compare
 * semantics ergonomic without importing an enum type. Only the three
 * kinds the steer-input gate distinguishes (regular vs review vs
 * compact) exist today; more can be added when their tasks land.
 */
export type TaskKind = "regular" | "compact" | "review";

/**
 * Why a turn was aborted.
 *
 *   - `interrupted`: user-triggered cancel (Ctrl-C / interrupt event).
 *   - `replaced`: a new turn spawned while this one was in flight
 *     (`spawnTask` calls `abortAllTasks("replaced")`).
 *   - `review_ended`: review session concluded.
 */
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

/**
 * Mailbox delivery phase for the active turn.
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
 * A task registered in the active turn. Fields:
 *
 *   - `subId`: turn/sub identifier; key in the `tasks` registry.
 *   - `kind`: the `TaskKind`.
 *   - `abortController`: task-local cancellation surface. The running
 *     kernel's `mergeSignals(opts.signal, session.abortController.signal)`
 *     already covers session-level abort; this controller is the
 *     task-local layer that `abortAllTasks` triggers for `replaced`.
 *   - `done`: resolves when the task finishes, success or cancel. A
 *     Promise plus its resolve handle. `abortAllTasks` awaits `done`
 *     under a bounded timeout so callers see graceful shutdown before
 *     the new turn proceeds.
 *   - `startedAtMs`: wall clock for telemetry / `turn_complete`
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
 * Per-turn state held under its own lock inside `ActiveTurn`. Gut
 * exposes all fields up front so later waves can wire consumers
 * without schema churn. Each field below is classified per its current
 * gut status:
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
 *   SLOT-ONLY: no gut consumer today. Field reserved so future
 *     mutation sites can land without schema churn. Each SLOT-ONLY
 *     field carries a `RESERVED:` breadcrumb naming the consumer it
 *     will connect to.
 *
 * Current classification (2026-04 Part 4):
 *   WIRED-NOW:
 *     - `toolCalls` — incremented inside
 *       `tools/router.ts::dispatchModelToolCall` under the
 *       `ActiveTurnState` lock.
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
 *       routing; defer-to-next-turn and accept-for-current-turn
 *       transitions have no gut counterpart independent of the
 *       mailbox consumer above.
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
  // RESERVED: exec / apply-patch approval insert and notify-approval
  // remove. Gut approval flow uses closure-based `ApprovalRequestFn`
  // (tools/execution.ts:368) rather than a keyed registry; the slot is
  // reserved for a future approval-RPC surface.
  /** Pending approvals keyed by request id. SLOT-ONLY. */
  pendingApprovals: Map<string, (decision: unknown) => void>;
  // RESERVED: request-permissions insert, cancellation remove, and
  // permissions-response remove.
  /** Pending permission requests keyed by request id. SLOT-ONLY. */
  pendingRequestPermissions: Map<string, unknown>;
  // RESERVED: request-user-input insert and user-input-response remove.
  /** Pending user-input requests keyed by request id. SLOT-ONLY. */
  pendingUserInput: Map<string, (response: unknown) => void>;
  // RESERVED: MCP elicitation callback registry. Gut's
  // `Session.outOfBandElicitationPaused`
  // carries only the paused-state BehaviorSubject; no elicitation
  // callback is kept in a keyed registry yet.
  /** Pending elicitations keyed by request id. SLOT-ONLY. */
  pendingElicitations: Map<string, (response: unknown) => void>;
  // RESERVED: dynamic-tool-response remove. Gut has no
  // dynamic-tool-response surface yet.
  /** Pending dynamic-tool responses keyed by request id. SLOT-ONLY. */
  pendingDynamicTools: Map<string, (response: unknown) => void>;
  // WIRED-EXTERNAL: consumed via `session.ts::SimpleMailbox`
  // (`enqueueIdleInput` / `hasPendingInput` / `drainIdleInput`).
  // Lock-side sites would be: steer-input push, inject-response-items,
  // and the on-task-finished drain.
  /** Pending input items. WIRED-EXTERNAL (SimpleMailbox). */
  pendingInput: unknown[];
  // WIRED-EXTERNAL: tied to the same mailbox consumer above
  // (defer-to-next-turn and accept-for-current-turn transitions).
  /** Mailbox delivery phase. WIRED-EXTERNAL (mailbox). */
  mailboxDeliveryPhase: MailboxDeliveryPhase;
  // RESERVED: granted-turn-permissions read. Gut has no per-turn
  // permission-grant storage yet; permissions
  // are evaluated through `permissions/evaluator.ts` without a turn-scoped
  // grant cache.
  /** Permissions granted for this turn. SLOT-ONLY. */
  grantedPermissions: unknown | null;
  // RESERVED: strict-auto-review-enabled read. No review subsystem in gut.
  /** Whether strict auto review is enabled for this turn. SLOT-ONLY. */
  strictAutoReviewEnabled: boolean;
  // WIRED-NOW: incremented in `tools/router.ts::dispatchModelToolCall`
  // via `session.withActiveTurnState(...)` (saturating add before
  // dispatch). No gut reader yet; the natural reader is
  // `onTaskFinished` for turn-complete telemetry.
  /** Tool-call counter. WIRED-NOW (dispatchModelToolCall). */
  toolCalls: number;
  /** One-shot claim preventing duplicate Ledger transfers in one human turn. */
  ledgerTransferClaimed: boolean;
  // RESERVED: record-memory-citation write and on-task-finished read.
  // Gut has no memory subsystem yet.
  /** Whether this turn recorded a memory citation. SLOT-ONLY. */
  hasMemoryCitation: boolean;
  // WIRED-NOW: seeded under the lock in `Session.spawnTask`
  // (session.ts:1528-1534) when the caller supplies
  // `opts.tokenUsageAtTurnStart`. The natural reader is `onTaskFinished`
  // computing the per-turn token-usage delta; that reader is future
  // work (telemetry hook).
  /** Token usage at turn start. WIRED-NOW (seeded at spawn). */
  tokenUsageAtTurnStart: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Fresh `ActiveTurnState` with all pending maps empty and the tool-call
 * counter at zero.
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

export function pushPendingInput(state: ActiveTurnState, input: unknown): void {
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

export function deferMailboxDeliveryToNextTurn(state: ActiveTurnState): void {
  state.mailboxDeliveryPhase = "next_turn";
}

export function acceptsMailboxDeliveryForCurrentTurn(
  state: ActiveTurnState,
): boolean {
  return state.mailboxDeliveryPhase === "current_turn";
}

/**
 * Graceful interruption timeout before force-aborting.
 */
export const GRACEFUL_INTERRUPTION_TIMEOUT_MS = 100;

/**
 * Options accepted by `Session.spawnTask`.
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
  /** Token usage captured at task start. */
  readonly tokenUsageAtTurnStart?: ActiveTurnState["tokenUsageAtTurnStart"];
}

/**
 * Create a `done` promise + its resolver handle: a Promise resolved
 * from a captured handle acts as the one-shot completion signal.
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
 * Bounded wait for the task's `done` signal: races `done` against a
 * timeout. Returns true if the task signalled done within the budget, false on
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
// `steerInput` folds user-provided items into an in-flight turn;
// `SteerInputError` describes why a steer was rejected. The non-negotiable
// contract is that only `regular` turns accept steering; `compact`
// and `review` turns reject with `ActiveTurnNotSteerable` because
// mid-stream user prompts would corrupt the managed pipeline those
// tasks run (summary generation, review handoff).
// ─────────────────────────────────────────────────────────────────────

/**
 * The two task kinds that reject same-turn steering.
 *
 * Kept as a string union to match gut's `TaskKind` style and serialize
 * cleanly when surfaced through event payloads or error reporting.
 */
export type NonSteerableTurnKind = "review" | "compact";

/**
 * Returns `true` when a task of this kind can absorb mid-stream user
 * prompts via `steerInput`.
 *
 * Contract:
 *   - `regular` -> steerable.
 *   - `compact`, `review` -> NOT steerable; steer calls are rejected
 *     with an `active_turn_not_steerable` error.
 *
 * Kept as a free function (instead of a method on `TaskKind`) so it
 * stays trivially callable from `Session.steerInput`, tests, and any
 * future gate site.
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
 * Maps a non-steerable `TaskKind` onto the `NonSteerableTurnKind`
 * discriminator used in `SteerInputError` payloads.
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
 * Reasons a `steerInput` call can be rejected. Discriminated union so
 * callers can switch on `kind` and pull the variant-specific payload
 * without downcasts.
 *
 * Variants:
 *   - `no_active_turn`: carries the rejected items back to the caller
 *     so they can retry or surface them to the user without loss.
 *   - `sub_id_mismatch`: the caller targeted a different turn than the
 *     active one; carries `expected` and `actual` sub-ids.
 *   - `active_turn_not_steerable`: carries the offending `turnKind`.
 *   - `empty_input`: no payload.
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
  | {
      readonly kind: "mailbox_backpressure";
      readonly items: readonly unknown[];
    }
  | { readonly kind: "empty_input" };

/**
 * Result of a successful `steerInput` call. Returns the active turn's
 * subId so callers can correlate the steer to the turn it merged into.
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
 * used for Event emission and telemetry. Returns a `{ message }` tuple
 * instead of a full error event so callers can assemble their own
 * event envelopes without a cross-module dep on event-log here.
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
    case "mailbox_backpressure":
      return {
        message: "session mailbox is full; input was not accepted",
        code: "resource_exhausted",
      };
    case "empty_input":
      return { message: "input must not be empty", code: "bad_request" };
  }
}
