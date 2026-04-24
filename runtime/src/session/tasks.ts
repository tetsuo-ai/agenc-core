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
 * waves can wire consumers without schema churn. Fields currently
 * consumed by gut code paths are noted inline; slot-only fields are
 * preserved for forward wiring.
 *
 * Currently consumed by gut:
 *   - `toolCalls` — incremented by tool-execute sites (future wiring;
 *     today the gut executor tracks this through a different path).
 *   - `tokenUsageAtTurnStart` — captured at `spawnTask` so
 *     `onTaskFinished` can compute per-turn delta telemetry (gut
 *     equivalent of codex `TurnTokenUsageFact`).
 *   - `hasMemoryCitation` — set by the memory-citation wiring when
 *     the first citation lands in a turn.
 *   - `pendingInput` — mirrors `session.mailbox` routing; the full
 *     wiring lands with T9's mailbox refactor.
 *
 * Slot-only (schema present; no live consumer yet):
 *   - `pendingApprovals`, `pendingRequestPermissions`, `pendingUserInput`,
 *     `pendingElicitations`, `pendingDynamicTools`, `grantedPermissions`,
 *     `mailboxDeliveryPhase`, `strictAutoReviewEnabled`.
 */
export interface ActiveTurnState {
  /** Upstream `pending_approvals`. Slot-only pending T11 wiring. */
  pendingApprovals: Map<string, (decision: unknown) => void>;
  /** Upstream `pending_request_permissions`. Slot-only pending T11 wiring. */
  pendingRequestPermissions: Map<string, unknown>;
  /** Upstream `pending_user_input`. Slot-only pending request-user-input wiring. */
  pendingUserInput: Map<string, (response: unknown) => void>;
  /** Upstream `pending_elicitations`. Slot-only pending MCP elicitation wiring. */
  pendingElicitations: Map<string, (response: unknown) => void>;
  /** Upstream `pending_dynamic_tools`. Slot-only pending dynamic-tool wiring. */
  pendingDynamicTools: Map<string, (response: unknown) => void>;
  /** Upstream `pending_input`. Currently consumed via session.mailbox. */
  pendingInput: unknown[];
  /** Upstream `mailbox_delivery_phase`. Slot-only pending mailbox phase wiring. */
  mailboxDeliveryPhase: MailboxDeliveryPhase;
  /** Upstream `granted_permissions`. Slot-only pending permission-profile wiring. */
  grantedPermissions: unknown | null;
  /** Upstream `strict_auto_review_enabled`. Slot-only pending review wiring. */
  strictAutoReviewEnabled: boolean;
  /** Upstream `tool_calls` counter. Incremented at tool-dispatch sites. */
  toolCalls: number;
  /** Upstream `has_memory_citation`. Set when the turn records a citation. */
  hasMemoryCitation: boolean;
  /** Upstream `token_usage_at_turn_start`. Captured at `spawnTask` entry. */
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
