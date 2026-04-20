/**
 * Token budget tracker — I-22.
 *
 * Hand-port of openclaude `query.ts:1346, 1375` (`budgetTracker` +
 * `token_budget_continuation` transition) extended with the AgenC
 * mid-stream check mandated by I-22.
 *
 * Scope:
 *   - openclaude checks only at turn boundaries; AgenC adds a
 *     per-N-token sampling check during streaming.
 *   - Default N = 1000 emitted tokens between checks (matches I-22
 *     rule text). Override via `AGENC_TOKEN_BUDGET_CHECK_INTERVAL`.
 *   - The tracker is carried on Session so it survives continue-site
 *     recoveries across phase iterations.
 *
 * T8 (recovery ladder) consumes `BudgetExceededDecision` from state
 * and routes to the `token_budget_continuation` phase. For T5 we
 * expose the tracker + sampling hook; the recovery wiring lands in
 * T8.
 *
 * @module
 */

export const DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL = 1_000;

export function resolveTokenBudgetCheckInterval(): number {
  const raw = process.env.AGENC_TOKEN_BUDGET_CHECK_INTERVAL;
  if (!raw) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  return n;
}

export type BudgetDecision =
  | { readonly kind: "within_budget"; readonly remaining: number }
  | { readonly kind: "exceeded"; readonly overshoot: number };

/**
 * Running token-budget tracker. Mirrors openclaude's shape (see
 * `query/tokenBudget.ts::createBudgetTracker`) — an accumulator with a
 * total budget plus per-turn output tally and a sampling gate.
 *
 * The tracker uses monotonic counters only; no wall-clock arithmetic.
 */
export class BudgetTracker {
  private readonly totalBudget: number | null;
  private totalEmitted = 0;
  private lastCheckedEmitted = 0;
  private readonly checkInterval: number;

  /**
   * @param totalBudget — max total tokens across the whole turn
   *   (null = unbounded). openclaude computes from env + config;
   *   T10 wires the real resolver.
   * @param checkInterval — emit-token threshold between checks.
   */
  constructor(totalBudget: number | null, checkInterval?: number) {
    this.totalBudget = totalBudget;
    this.checkInterval = checkInterval ?? resolveTokenBudgetCheckInterval();
  }

  /**
   * Total tokens emitted in this turn so far.
   */
  get emitted(): number {
    return this.totalEmitted;
  }

  /**
   * Remaining budget (null when unbounded).
   */
  get remaining(): number | null {
    if (this.totalBudget === null) return null;
    return Math.max(0, this.totalBudget - this.totalEmitted);
  }

  /**
   * Record N emitted tokens from this iteration's stream. Safe to call
   * every chunk; cheap arithmetic only.
   */
  addEmitted(n: number): void {
    if (n <= 0) return;
    this.totalEmitted += n;
  }

  /**
   * I-22: mid-stream check. Returns `exceeded` only when
   *   (a) budget is set AND
   *   (b) at least `checkInterval` tokens have elapsed since the last
   *       check AND
   *   (c) cumulative tokens exceed the budget.
   *
   * The sampling gate avoids per-chunk allocation churn on a fast
   * provider stream — matches the I-22 rule text "after every N
   * (default 1000) output tokens, check remaining".
   */
  sampleMidStream(): BudgetDecision {
    if (this.totalBudget === null) {
      return { kind: "within_budget", remaining: Number.POSITIVE_INFINITY };
    }
    const elapsedSinceLastCheck = this.totalEmitted - this.lastCheckedEmitted;
    if (elapsedSinceLastCheck < this.checkInterval) {
      return { kind: "within_budget", remaining: this.totalBudget - this.totalEmitted };
    }
    this.lastCheckedEmitted = this.totalEmitted;
    if (this.totalEmitted > this.totalBudget) {
      return { kind: "exceeded", overshoot: this.totalEmitted - this.totalBudget };
    }
    return { kind: "within_budget", remaining: this.totalBudget - this.totalEmitted };
  }

  /**
   * Boundary check (turn start / end). No sampling gate — always
   * compares cumulative tokens vs budget. Openclaude's classic
   * `checkTokenBudget` maps to this.
   */
  checkBoundary(): BudgetDecision {
    if (this.totalBudget === null) {
      return { kind: "within_budget", remaining: Number.POSITIVE_INFINITY };
    }
    if (this.totalEmitted > this.totalBudget) {
      return { kind: "exceeded", overshoot: this.totalEmitted - this.totalBudget };
    }
    return { kind: "within_budget", remaining: this.totalBudget - this.totalEmitted };
  }

  /**
   * Reset the sampling gate (e.g. after a continuation nudge injects
   * a follow-up turn that counts against a fresh window). The
   * cumulative emitted counter is preserved.
   */
  resetSamplingGate(): void {
    this.lastCheckedEmitted = this.totalEmitted;
  }
}

/**
 * Factory — creates a tracker with the configured budget. Returns
 * null to signal "budgeting disabled" so callers can cheaply opt out
 * (e.g. a feature-flag off path) without a branch at every call site.
 */
export function createBudgetTracker(totalBudget: number | null): BudgetTracker | null {
  if (totalBudget === null) return null;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return null;
  return new BudgetTracker(totalBudget);
}
