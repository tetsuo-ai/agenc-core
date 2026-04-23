/**
 * Recovery ladder — orchestrates the 7 strategies in priority order.
 *
 * Wires:
 *   - I-10 (trigger priority) via `triggers.ts` ordered array
 *   - I-42 (recovery re-entry cap, MAX_RECOVERY_REENTRIES=5)
 *   - I-62 (recovery-trigger evaluation exclusive, AsyncLock<void>)
 *   - I-7  (abort cascade — routes to `recovery` destination)
 *   - I-8  (error emission — every exhausted path emits typed event)
 *
 * Entry point is `RecoveryLadder.run(ctx)`. The ladder acquires the
 * `session.recoveryInFlight` lock (I-62) so concurrent triggers
 * queue + re-evaluate priority on dequeue, increments
 * `state.recoveryReentryCount` on each entry (I-42 cap), and walks
 * the ordered trigger array (I-10) to dispatch the first match.
 *
 * @module
 */

import { AsyncLock } from "./_deps/async-lock.js";
import { emitError, emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import {
  buildDefaultTriggerOrder,
  type RecoveryTrigger,
  type TriggerActions,
  type TriggerContext,
  type TriggerOutcome,
} from "./triggers.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const MAX_RECOVERY_REENTRIES = 5;

// ─────────────────────────────────────────────────────────────────────
// Per-session exclusive lock (I-62)
// ─────────────────────────────────────────────────────────────────────

/**
 * AgenC-wide registry of `recoveryInFlight` locks — keyed on
 * conversationId. Session doesn't carry a native lock today; this
 * module lazily creates one per session so concurrent recovery
 * entries queue cleanly.
 */
const recoveryLocks = new WeakMap<Session, AsyncLock<void>>();

export function getRecoveryLock(session: Session): AsyncLock<void> {
  let lock = recoveryLocks.get(session);
  if (!lock) {
    lock = new AsyncLock<void>(undefined);
    recoveryLocks.set(session, lock);
  }
  return lock;
}

// ─────────────────────────────────────────────────────────────────────
// RecoveryLadder
// ─────────────────────────────────────────────────────────────────────

export type LadderOutcome =
  | { readonly kind: "applied"; readonly trigger: string; readonly reason: string }
  | { readonly kind: "surface"; readonly trigger: string; readonly reason: string }
  | { readonly kind: "no_match" }
  | { readonly kind: "reentry_cap_exhausted"; readonly cap: number };

export interface RecoveryLadderOpts {
  readonly session: Session;
  readonly actions: TriggerActions;
  /** Optional override — used by tests to inject a custom trigger set. */
  readonly triggerOrder?: ReadonlyArray<RecoveryTrigger>;
  /** Optional override for MAX_RECOVERY_REENTRIES (tests only). */
  readonly maxReentries?: number;
}

export class RecoveryLadder {
  private readonly session: Session;
  private readonly triggers: ReadonlyArray<RecoveryTrigger>;
  private readonly maxReentries: number;

  constructor(opts: RecoveryLadderOpts) {
    this.session = opts.session;
    this.triggers =
      opts.triggerOrder ?? buildDefaultTriggerOrder(opts.actions);
    this.maxReentries = opts.maxReentries ?? MAX_RECOVERY_REENTRIES;
  }

  /**
   * Evaluate triggers + dispatch the first match under the
   * recovery-in-flight lock (I-62). Returns the outcome the
   * post-sample-recovery phase translates into a run-turn
   * transition.
   */
  async run(
    state: TurnState,
    lastMessage: AssistantMessage | undefined,
    streamError: unknown | undefined,
  ): Promise<LadderOutcome> {
    const lock = getRecoveryLock(this.session);

    return lock.with(async () => {
      // I-42: enforce the re-entry cap at ladder entry. If the
      // counter is already at MAX_RECOVERY_REENTRIES the ladder
      // refuses to walk triggers — even if no trigger would match —
      // and emits the typed `recovery_loop` error so the surrounding
      // phase can transition to a terminal failure.
      if (state.recoveryReentryCount >= this.maxReentries) {
        emitError(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          {
            cause: "recovery_loop",
            message: `recovery ladder exceeded MAX_RECOVERY_REENTRIES=${this.maxReentries}`,
          },
        );
        return {
          kind: "reentry_cap_exhausted",
          cap: this.maxReentries,
        } satisfies LadderOutcome;
      }

      const ctx: TriggerContext = {
        session: this.session,
        state,
        lastMessage,
        streamError,
      };

      // I-10: ordered priority walk. First match wins.
      for (const trigger of this.triggers) {
        if (!trigger.match(ctx)) continue;

        const reservation = reserveRecoveryReentryLocked(
          this.session,
          state,
          this.maxReentries,
          trigger.name,
        );
        if (reservation.kind === "exhausted") {
          return {
            kind: "reentry_cap_exhausted",
            cap: reservation.cap,
          } satisfies LadderOutcome;
        }

        let outcome: TriggerOutcome;
        try {
          outcome = await trigger.apply(ctx);
        } catch (err) {
          emitError(this.session.eventLog, this.session.nextInternalSubId(), {
            cause: "recovery_trigger_threw",
            message: `trigger ${trigger.name} threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          return {
            kind: "surface",
            trigger: trigger.name,
            reason: "trigger_threw",
          };
        }

        switch (outcome.kind) {
          case "applied":
            return {
              kind: "applied",
              trigger: trigger.name,
              reason: outcome.reason,
            };
          case "surface":
            return {
              kind: "surface",
              trigger: trigger.name,
              reason: outcome.reason,
            };
          case "pass":
            // Continue walking — the trigger declined to apply
            // despite matching (e.g. gate-conflict). Let the next
            // trigger in the order try.
            continue;
        }
      }

      return { kind: "no_match" };
    });
  }
}

/**
 * Convenience: reset the per-turn recovery counter. Called by the
 * phase machine when a fresh user input arrives.
 */
export function resetRecoveryReentries(state: TurnState): void {
  state.recoveryReentryCount = 0;
}

export type RecoveryReentryReservation =
  | { readonly kind: "reserved"; readonly count: number }
  | { readonly kind: "exhausted"; readonly cap: number };

function reserveRecoveryReentryLocked(
  session: Session,
  state: TurnState,
  maxReentries: number,
  triggerName?: string,
): RecoveryReentryReservation {
  if (state.recoveryReentryCount >= maxReentries) {
    emitError(session.eventLog, session.nextInternalSubId(), {
      cause: "recovery_loop",
      message: `recovery ladder exceeded MAX_RECOVERY_REENTRIES=${maxReentries}`,
    });
    return {
      kind: "exhausted",
      cap: maxReentries,
    };
  }

  state.recoveryReentryCount += 1;
  if (triggerName) {
    emitWarning(
      session.eventLog,
      session.nextInternalSubId(),
      "recovery_triggered",
      `trigger=${triggerName}, reentryCount=${state.recoveryReentryCount}/${maxReentries}`,
    );
  }
  return {
    kind: "reserved",
    count: state.recoveryReentryCount,
  };
}

export async function reserveRecoveryReentry(
  session: Session,
  state: TurnState,
  opts: {
    readonly triggerName?: string;
    readonly maxReentries?: number;
  } = {},
): Promise<RecoveryReentryReservation> {
  const lock = getRecoveryLock(session);
  return lock.with(async () =>
    reserveRecoveryReentryLocked(
      session,
      state,
      opts.maxReentries ?? MAX_RECOVERY_REENTRIES,
      opts.triggerName,
    ),
  );
}
