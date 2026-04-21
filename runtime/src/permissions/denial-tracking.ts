/**
 * Denial-tracking primitive (I-3).
 *
 * Ports openclaude's `denialTracking.ts` with the handful of integration
 * helpers (`handleDenialLimitExceeded`) needed by classifier + prompt fallback
 * logic. Tracks two counters:
 *
 *   - `consecutiveDenials` — reset on any success
 *   - `totalDenials` — lifetime counter, never reset (openclaude correction)
 *
 * The spec's original draft reset `totalDenials` on success; openclaude's
 * live source deliberately leaves it sticky so operators can abort runaway
 * loops after a hard cap. We match openclaude.
 *
 * @module
 */

/**
 * Session-wide denial caps. openclaude's authoritative values:
 *   - 3 consecutive denials  -> CLI: soft-fallback (convert deny to ask)
 *   - 20 total denials       -> CLI: reset consecutive + fallback;
 *                               headless: abort with AbortError
 */
export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;

/** Tracking counters. Treat as immutable — the record/* helpers return new objects. */
export type DenialTrackingState = {
  readonly consecutiveDenials: number;
  readonly totalDenials: number;
};

/**
 * Fresh zeroed state for a new session or a new localDenialTracking scope.
 * openclaude's async-subagent path clones this into a request-scoped state
 * where `setAppState` is a no-op — so callers can pass in their own
 * `DenialTrackingState` instance and own its lifecycle locally.
 */
export function freshDenialTracking(): DenialTrackingState {
  return { consecutiveDenials: 0, totalDenials: 0 };
}

/**
 * Increment both counters. Always returns a new object (state is treated as
 * persistent-immutable to make the subagent clone-per-request pattern safe).
 */
export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  };
}

/**
 * Record a successful permission grant. Resets `consecutiveDenials` to zero
 * but intentionally preserves `totalDenials` — the lifetime cap is there to
 * catch runaway loops even when the agent occasionally lands a hit.
 */
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state;
  return {
    consecutiveDenials: 0,
    totalDenials: state.totalDenials,
  };
}

/**
 * True once either cap is hit. Callers use this as the trigger to swap a
 * `deny` decision for an `ask` prompt (or to abort in headless).
 */
export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  );
}

/**
 * Execution surface hint for `handleDenialLimitExceeded`. Headless (non-TTY
 * SDK runs, CI) cannot prompt the user, so hitting the lifetime cap aborts
 * the whole run. CLI sessions degrade gracefully into an ask prompt.
 */
export type DenialExecutionSurface = "cli" | "headless";

/**
 * Structured outcome of a cap-hit. Callers dispatch on `kind`:
 *
 *   - `abort`    — throw AbortError; headless lifetime cap hit
 *   - `fallback` — convert this deny into an ask prompt; CLI consecutive cap
 *   - `reset`    — CLI lifetime cap hit; reset consecutive + fallback
 *   - `continue` — state is still under both caps; no action needed
 */
export type DenialLimitOutcome =
  | { kind: "abort"; reason: string }
  | { kind: "fallback"; reason: string; nextState: DenialTrackingState }
  | { kind: "reset"; reason: string; nextState: DenialTrackingState }
  | { kind: "continue"; reason: string; nextState: DenialTrackingState };

/**
 * Decide what to do when a denial has just been recorded. The caller is
 * responsible for having already run `recordDenial` before invoking this —
 * this function reads counters and returns the policy outcome.
 *
 * Precedence (matches openclaude):
 *   1. Headless + totalDenials >= 20    -> abort
 *   2. CLI + totalDenials >= 20         -> reset consecutive, fallback
 *   3. CLI + consecutiveDenials >= 3    -> fallback (soft)
 *   4. otherwise                        -> continue
 */
export function handleDenialLimitExceeded(
  state: DenialTrackingState,
  surface: DenialExecutionSurface,
): DenialLimitOutcome {
  const { maxConsecutive, maxTotal } = DENIAL_LIMITS;
  const hitTotal = state.totalDenials >= maxTotal;
  const hitConsecutive = state.consecutiveDenials >= maxConsecutive;

  if (surface === "headless" && hitTotal) {
    return {
      kind: "abort",
      reason: `Aborting after ${state.totalDenials} total permission denials (headless cap=${maxTotal}).`,
    };
  }

  if (surface === "cli" && hitTotal) {
    // Reset consecutive AND fall back to prompting.
    return {
      kind: "reset",
      reason: `Resetting consecutive denials after ${state.totalDenials} total denials (cap=${maxTotal}); falling back to prompting.`,
      nextState: { consecutiveDenials: 0, totalDenials: state.totalDenials },
    };
  }

  if (surface === "cli" && hitConsecutive) {
    return {
      kind: "fallback",
      reason: `Falling back to prompting after ${state.consecutiveDenials} consecutive denials (cap=${maxConsecutive}).`,
      nextState: state,
    };
  }

  return {
    kind: "continue",
    reason: "Under both caps; no fallback action required.",
    nextState: state,
  };
}
