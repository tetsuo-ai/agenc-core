/**
 * Token budget tracker — I-22.
 *
 * Ports AgenC `query/tokenBudget.ts` semantics into the live
 * request path while keeping AgenC's mid-stream sampling as a thin
 * estimation layer only. The continuation / diminishing-returns
 * decision itself is boundary-only and uses provider-reported output
 * tokens for the current iteration.
 *
 * @module
 */

import { getBudgetContinuationMessage } from "./_deps/token-budget.js";

export const DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL = 1_000;
const COMPLETION_THRESHOLD = 0.9;
const DIMINISHING_THRESHOLD = 500;

export function resolveTokenBudgetCheckInterval(): number {
  const raw = process.env.AGENC_TOKEN_BUDGET_CHECK_INTERVAL;
  if (!raw) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOKEN_BUDGET_CHECK_INTERVAL;
  return n;
}

export type TokenBudgetDecision =
  | {
      readonly action: "continue";
      readonly nudgeMessage: string;
      readonly continuationCount: number;
      readonly pct: number;
      readonly turnTokens: number;
      readonly budget: number;
    }
  | {
      readonly action: "stop";
      readonly completionEvent: {
        readonly continuationCount: number;
        readonly pct: number;
        readonly turnTokens: number;
        readonly budget: number;
        readonly diminishingReturns: boolean;
        readonly durationMs: number;
      } | null;
    };

export interface MidStreamBudgetSample {
  readonly thresholdReached: boolean;
  readonly estimatedTurnTokens: number;
  readonly budget: number | null;
}

export class BudgetTracker {
  private readonly totalBudget: number | null;
  private readonly checkInterval: number;
  private confirmedOutputTokens = 0;
  private estimatedInFlightTokens = 0;
  private lastCheckedEstimatedTurnTokens = 0;
  continuationCount = 0;
  lastDeltaTokens = 0;
  lastGlobalTurnTokens = 0;
  startedAt = Date.now();

  constructor(totalBudget: number | null, checkInterval?: number) {
    this.totalBudget = totalBudget;
    this.checkInterval = checkInterval ?? resolveTokenBudgetCheckInterval();
  }

  get emitted(): number {
    return this.confirmedOutputTokens + this.estimatedInFlightTokens;
  }

  get remaining(): number | null {
    if (this.totalBudget === null) return null;
    return Math.max(0, this.totalBudget - this.emitted);
  }

  get budget(): number | null {
    return this.totalBudget;
  }

  get confirmedTokens(): number {
    return this.confirmedOutputTokens;
  }

  addEmitted(
    n: number,
    source: "confirmed" | "estimate" = "confirmed",
  ): void {
    if (!Number.isFinite(n) || n <= 0) return;
    if (source === "estimate") {
      this.estimatedInFlightTokens += n;
      return;
    }
    this.confirmedOutputTokens += n;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
  }

  sampleMidStream(): MidStreamBudgetSample {
    const estimatedTurnTokens = this.confirmedOutputTokens + this.estimatedInFlightTokens;
    const elapsedSinceLastCheck =
      estimatedTurnTokens - this.lastCheckedEstimatedTurnTokens;
    if (elapsedSinceLastCheck < this.checkInterval) {
      return {
        thresholdReached: false,
        estimatedTurnTokens,
        budget: this.totalBudget,
      };
    }
    this.lastCheckedEstimatedTurnTokens = estimatedTurnTokens;
    return {
      thresholdReached:
        this.totalBudget !== null &&
        estimatedTurnTokens >= this.totalBudget * COMPLETION_THRESHOLD,
      estimatedTurnTokens,
      budget: this.totalBudget,
    };
  }

  resolveBoundaryTokens(currentIterationOutputTokens: number): number {
    const bounded =
      Number.isFinite(currentIterationOutputTokens) && currentIterationOutputTokens > 0
        ? currentIterationOutputTokens
        : 0;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
    return this.confirmedOutputTokens + bounded;
  }

  checkBoundary(globalTurnTokens: number): TokenBudgetDecision {
    if (this.totalBudget === null || this.totalBudget <= 0) {
      return { action: "stop", completionEvent: null };
    }

    const turnTokens = Math.max(0, globalTurnTokens);
    const pct = Math.round((turnTokens / this.totalBudget) * 100);
    const deltaSinceLastCheck = turnTokens - this.lastGlobalTurnTokens;

    const isDiminishing =
      this.continuationCount >= 3 &&
      deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
      this.lastDeltaTokens < DIMINISHING_THRESHOLD;

    if (!isDiminishing && turnTokens < this.totalBudget * COMPLETION_THRESHOLD) {
      this.continuationCount += 1;
      this.lastDeltaTokens = deltaSinceLastCheck;
      this.lastGlobalTurnTokens = turnTokens;
      return {
        action: "continue",
        nudgeMessage: getBudgetContinuationMessage(
          pct,
          turnTokens,
          this.totalBudget,
        ),
        continuationCount: this.continuationCount,
        pct,
        turnTokens,
        budget: this.totalBudget,
      };
    }

    if (isDiminishing || this.continuationCount > 0) {
      return {
        action: "stop",
        completionEvent: {
          continuationCount: this.continuationCount,
          pct,
          turnTokens,
          budget: this.totalBudget,
          diminishingReturns: isDiminishing,
          durationMs: Date.now() - this.startedAt,
        },
      };
    }

    return { action: "stop", completionEvent: null };
  }

  resetSamplingGate(): void {
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = this.confirmedOutputTokens;
  }

  resetForTurn(): void {
    this.confirmedOutputTokens = 0;
    this.estimatedInFlightTokens = 0;
    this.lastCheckedEstimatedTurnTokens = 0;
    this.continuationCount = 0;
    this.lastDeltaTokens = 0;
    this.lastGlobalTurnTokens = 0;
    this.startedAt = Date.now();
  }
}

export function createBudgetTracker(
  totalBudget: number | null = null,
): BudgetTracker | null {
  if (totalBudget === null) return null;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return null;
  return new BudgetTracker(totalBudget);
}
