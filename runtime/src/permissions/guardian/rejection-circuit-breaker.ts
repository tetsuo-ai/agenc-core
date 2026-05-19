/**
 * GuardianRejectionCircuitBreaker — prevents runaway guardian-reject loops
 * within a single turn.
 *
 * Ported from the inspected guardian circuit-breaker source:
 *   - `struct GuardianRejectionCircuitBreaker`
 *   - `enum GuardianRejectionCircuitBreakerAction`
 *   - `const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN: u32 = 3`
 *   - `const MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN: u32 = 10`
 *
 * Semantic contract:
 *   - State is keyed by `turn_id` (string). Each turn has its own counters.
 *   - `recordDenial(turnId)` bumps both `consecutiveDenials` and
 *     `totalDenials`. If either threshold is hit AND `interruptTriggered` is
 *     still false, it flips `interruptTriggered = true` and returns
 *     `InterruptTurn { consecutiveDenials, totalDenials }`. On every
 *     subsequent denial for that same turn it returns `Continue` (the
 *     interrupt is one-shot per turn).
 *   - `recordNonDenial(turnId)` resets `consecutiveDenials` to 0 but leaves
 *     `totalDenials` and `interruptTriggered` untouched.
 *   - `clearTurn(turnId)` drops the per-turn row entirely. Upstream calls
 *     this at the top of every new turn before any denial is recorded, so
 *     a new turn starts with a fresh set of counters and no leftover
 *     `interruptTriggered` flag.
 *
 * NOTE on "window": the task spec mentioned a time-window reset. The inspected
 * source does not use a wall-clock window. The scope is exclusively per-turn
 * (turn_id), reset by `clearTurn`.
 *
 * @module
 */

/**
 * `MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN: u32 = 3`.
 */
export const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN = 3;

/**
 * `MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN: u32 = 10`.
 */
export const MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN = 10;

/**
 * Return shape of `recordDenial`.
 *
 * `Continue` — the caller should proceed normally.
 * `InterruptTurn` — the caller should interrupt the current turn. Emitted
 *   exactly once per turn (the first denial that crosses either threshold).
 */
export type GuardianRejectionCircuitBreakerAction =
  | { readonly kind: "continue" }
  | {
      readonly kind: "interrupt_turn";
      readonly consecutiveDenials: number;
      readonly totalDenials: number;
    };

interface GuardianRejectionCircuitBreakerTurn {
  consecutiveDenials: number;
  totalDenials: number;
  interruptTriggered: boolean;
}

/**
 * Construction options. Thresholds default to the inspected source constants.
 */
export interface GuardianRejectionCircuitBreakerOptions {
  /** Defaults to {@link MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN}. */
  readonly maxConsecutiveDenialsPerTurn?: number;
  /** Defaults to {@link MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN}. */
  readonly maxTotalDenialsPerTurn?: number;
}

/**
 * Per-session, turn-scoped guardian rejection circuit breaker.
 *
 * Upstream invariants preserved:
 *   - Per-turn counters keyed by `turnId`.
 *   - `InterruptTurn` is one-shot per turn; after firing once for a turn,
 *     subsequent denials in that same turn return `Continue` until
 *     `clearTurn` is called (normally at the top of the next turn).
 *   - `recordNonDenial` resets consecutive but NOT total.
 */
export class GuardianRejectionCircuitBreaker {
  private readonly turns = new Map<string, GuardianRejectionCircuitBreakerTurn>();
  private readonly maxConsecutiveDenialsPerTurn: number;
  private readonly maxTotalDenialsPerTurn: number;

  constructor(opts: GuardianRejectionCircuitBreakerOptions = {}) {
    this.maxConsecutiveDenialsPerTurn =
      opts.maxConsecutiveDenialsPerTurn ?? MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN;
    this.maxTotalDenialsPerTurn =
      opts.maxTotalDenialsPerTurn ?? MAX_TOTAL_GUARDIAN_DENIALS_PER_TURN;
  }

  /**
   * Drop per-turn state for `turnId`. Upstream calls this at the top of
   * every new turn before any denial is recorded.
   */
  clearTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  /**
   * Record a guardian denial for `turnId`. Returns `interrupt_turn` exactly
   * once per turn when the first threshold (consecutive or total) is
   * crossed; all subsequent denials in that turn return `continue`.
   */
  recordDenial(turnId: string): GuardianRejectionCircuitBreakerAction {
    const turn = this.getOrCreate(turnId);
    turn.consecutiveDenials = saturatingIncrement(turn.consecutiveDenials);
    turn.totalDenials = saturatingIncrement(turn.totalDenials);

    if (
      !turn.interruptTriggered &&
      (turn.consecutiveDenials >= this.maxConsecutiveDenialsPerTurn ||
        turn.totalDenials >= this.maxTotalDenialsPerTurn)
    ) {
      turn.interruptTriggered = true;
      return {
        kind: "interrupt_turn",
        consecutiveDenials: turn.consecutiveDenials,
        totalDenials: turn.totalDenials,
      };
    }
    return { kind: "continue" };
  }

  /**
   * Record a non-denial (approval/success) for `turnId`. Resets only the
   * consecutive-denial counter; `totalDenials` and `interruptTriggered`
   * stay put.
   */
  recordNonDenial(turnId: string): void {
    const turn = this.getOrCreate(turnId);
    turn.consecutiveDenials = 0;
  }

  /**
   * Test/diagnostic accessor for the current state of a turn. Returns
   * `undefined` if the turn has no recorded activity.
   */
  peek(turnId: string): Readonly<GuardianRejectionCircuitBreakerTurn> | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    return {
      consecutiveDenials: turn.consecutiveDenials,
      totalDenials: turn.totalDenials,
      interruptTriggered: turn.interruptTriggered,
    };
  }

  /**
   * Drop all turn state. Intended for session teardown or test resets; not
   * part of the inspected API surface (there is no `clear_all`, only
   * per-turn `clear_turn`).
   */
  resetAll(): void {
    this.turns.clear();
  }

  /**
   * Alias for {@link resetAll} that matches the high-level "reset()"
   * contract some callers expect from circuit breakers. Kept separate
   * from `clearTurn` so callers cannot accidentally wipe every turn's
   * state just by calling `reset`.
   */
  reset(): void {
    this.resetAll();
  }

  /**
   * `true` if the breaker has already fired `interrupt_turn` for this
   * `turnId` in the current turn. Corresponds to the inspected source's
   * `interrupt_triggered` flag on the per-turn row.
   */
  isOpen(turnId: string): boolean {
    const turn = this.turns.get(turnId);
    return turn?.interruptTriggered ?? false;
  }

  private getOrCreate(turnId: string): GuardianRejectionCircuitBreakerTurn {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = {
        consecutiveDenials: 0,
        totalDenials: 0,
        interruptTriggered: false,
      };
      this.turns.set(turnId, turn);
    }
    return turn;
  }
}

/**
 * Factory. Upstream's `Mutex::new(Default::default())` wiring lives at
 * the session-services layer; here we expose a plain factory so callers
 * can pick a lock strategy appropriate to their runtime (the map itself
 * is already safe under Node's single-threaded event loop — concurrent
 * calls on a single breaker instance serialize naturally).
 */
export function createGuardianRejectionCircuitBreaker(
  opts: GuardianRejectionCircuitBreakerOptions = {},
): GuardianRejectionCircuitBreaker {
  return new GuardianRejectionCircuitBreaker(opts);
}

/**
 * Saturating u32 increment — matches Rust's `saturating_add(1)` used
 * inspected source. JavaScript numbers saturate at MAX_SAFE_INTEGER for
 * practical purposes; we emulate the exact shape for clarity.
 */
function saturatingIncrement(n: number): number {
  const U32_MAX = 0xffff_ffff;
  return n >= U32_MAX ? U32_MAX : n + 1;
}
