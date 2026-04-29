/**
 * Usage-notice sidecar.
 *
 * Tracks provider-neutral token/cost state from the session event log
 * and exposes a compact snapshot for prompt attachments and TUI status
 * rendering. This is intentionally not an account/rate-limit surface:
 * it reports local context usage, output token budget, session cost,
 * and the configured operator budget.
 *
 * @module
 */

import type { BudgetTracker } from "../llm/token-budget.js";
import type { Event, TokenCountEvent } from "./event-log.js";
import type { CostSidecar } from "./cost.js";
import type { Sidecar } from "./sidecar.js";

export interface TokenUsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface ContextUsageNoticeSnapshot {
  readonly usedTokens: number;
  readonly totalTokens: number;
  readonly remainingTokens: number;
  readonly percentUsed: number;
}

export interface OutputTokenUsageNoticeSnapshot {
  readonly turnTokens: number;
  readonly sessionTokens: number;
  readonly budgetTokens: number | null;
}

export interface CostBudgetNoticeSnapshot {
  readonly usedUsd: number;
  readonly totalUsd: number;
  readonly remainingUsd: number;
  readonly percentUsed: number;
}

export interface CompactionNoticeSnapshot {
  readonly usedTokens: number;
  readonly thresholdTokens: number;
  readonly remainingTokens: number;
  readonly percentUsed: number;
}

export interface UsageNoticeSnapshot {
  readonly context?: ContextUsageNoticeSnapshot;
  readonly output?: OutputTokenUsageNoticeSnapshot;
  readonly costBudget?: CostBudgetNoticeSnapshot;
  readonly compaction?: CompactionNoticeSnapshot;
}

export interface UsageNoticeSnapshotOptions {
  /** Current model-visible prompt estimate, when the caller has it. */
  readonly contextTokenEstimate?: number;
  /** Full context window for the active model. */
  readonly contextWindowTokens?: number;
  /** Token threshold at which auto-compaction is expected to run. */
  readonly autoCompactTokenLimit?: number;
  readonly budgetTracker?: BudgetTracker | null;
  readonly costSidecar?: CostSidecar | null;
  readonly maxBudgetUsd?: number;
}

const EMPTY_TOTALS: TokenUsageTotals = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
});

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function addTokenUsage(
  current: TokenUsageTotals,
  next: TokenCountEvent,
): TokenUsageTotals {
  return {
    promptTokens: current.promptTokens + (next.promptTokens ?? 0),
    completionTokens: current.completionTokens + (next.completionTokens ?? 0),
    totalTokens: current.totalTokens + (next.totalTokens ?? 0),
    cachedInputTokens:
      current.cachedInputTokens + (next.cachedInputTokens ?? 0),
    reasoningOutputTokens:
      current.reasoningOutputTokens + (next.reasoningOutputTokens ?? 0),
  };
}

function percentUsed(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function outputBudgetFromTracker(
  tracker: BudgetTracker | null | undefined,
): number | null {
  if (!tracker) return null;
  const budget = tracker.budget;
  return budget !== null && Number.isFinite(budget) && budget > 0
    ? budget
    : null;
}

export class UsageNoticeSidecar implements Sidecar {
  readonly name = "usage-notices";
  private totalUsage: TokenUsageTotals = EMPTY_TOTALS;
  private lastUsage: TokenUsageTotals = EMPTY_TOTALS;
  private modelContextWindowTokens: number | undefined;

  onEvent(event: Event): void {
    const msg = event.msg;
    switch (msg.type) {
      case "turn_started": {
        const window = finiteNonNegative(msg.payload.modelContextWindow);
        if (window !== undefined && window > 0) {
          this.modelContextWindowTokens = window;
        }
        break;
      }
      case "token_count": {
        this.lastUsage = {
          promptTokens: msg.payload.promptTokens ?? 0,
          completionTokens: msg.payload.completionTokens ?? 0,
          totalTokens: msg.payload.totalTokens ?? 0,
          cachedInputTokens: msg.payload.cachedInputTokens ?? 0,
          reasoningOutputTokens: msg.payload.reasoningOutputTokens ?? 0,
        };
        this.totalUsage = addTokenUsage(this.totalUsage, msg.payload);
        break;
      }
      default:
        break;
    }
  }

  reset(): void {
    this.totalUsage = EMPTY_TOTALS;
    this.lastUsage = EMPTY_TOTALS;
  }

  getTotalUsage(): TokenUsageTotals {
    return this.totalUsage;
  }

  getLastUsage(): TokenUsageTotals {
    return this.lastUsage;
  }

  snapshot(opts: UsageNoticeSnapshotOptions = {}): UsageNoticeSnapshot {
    const contextWindow =
      finiteNonNegative(opts.contextWindowTokens) ??
      this.modelContextWindowTokens;
    const contextEstimate =
      finiteNonNegative(opts.contextTokenEstimate) ??
      this.totalUsage.totalTokens;

    const context =
      contextWindow !== undefined && contextWindow > 0
        ? {
            usedTokens: contextEstimate,
            totalTokens: contextWindow,
            remainingTokens: Math.max(0, contextWindow - contextEstimate),
            percentUsed: percentUsed(contextEstimate, contextWindow),
          }
        : undefined;

    const outputBudget = outputBudgetFromTracker(opts.budgetTracker);
    const turnOutput = finiteNonNegative(opts.budgetTracker?.emitted) ?? 0;
    const sessionOutput =
      this.totalUsage.completionTokens + this.totalUsage.reasoningOutputTokens;
    const output =
      outputBudget !== null || turnOutput > 0 || sessionOutput > 0
        ? {
            turnTokens: turnOutput,
            sessionTokens: sessionOutput,
            budgetTokens: outputBudget,
          }
        : undefined;

    const usedCost = opts.costSidecar?.getTotalCostUsd();
    const totalBudget = finiteNonNegative(opts.maxBudgetUsd);
    const costBudget =
      usedCost !== undefined && totalBudget !== undefined && totalBudget > 0
        ? {
            usedUsd: usedCost,
            totalUsd: totalBudget,
            remainingUsd: totalBudget - usedCost,
            percentUsed: percentUsed(usedCost, totalBudget),
          }
        : undefined;

    const compactLimit = finiteNonNegative(opts.autoCompactTokenLimit);
    const compaction =
      compactLimit !== undefined && compactLimit > 0
        ? {
            usedTokens: contextEstimate,
            thresholdTokens: compactLimit,
            remainingTokens: Math.max(0, compactLimit - contextEstimate),
            percentUsed: percentUsed(contextEstimate, compactLimit),
          }
        : undefined;

    return {
      ...(context !== undefined ? { context } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(costBudget !== undefined ? { costBudget } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
    };
  }
}
