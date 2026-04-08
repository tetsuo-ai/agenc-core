/**
 * Pure usage utilities extracted from `ChatExecutor` (Phase F
 * PR-3 of the plan in TODO.MD).
 *
 * These functions build and accumulate per-call usage records
 * without touching any class state. They are pure data
 * transformations.
 *
 * @module
 */

import type {
  ChatCallUsageRecord,
  ChatPromptShape,
} from "./chat-executor-types.js";
import type { LLMResponse, LLMUsage } from "./types.js";
import type { PromptBudgetDiagnostics } from "./prompt-budget.js";

/**
 * In-place accumulation of an `LLMUsage` delta into a running
 * cumulative total. Mutates the first argument.
 *
 * Phase F extraction (PR-3). Previously
 * `ChatExecutor.accumulateUsage`.
 */
export function accumulateUsage(
  cumulative: LLMUsage,
  usage: LLMUsage,
): void {
  cumulative.promptTokens += usage.promptTokens;
  cumulative.completionTokens += usage.completionTokens;
  cumulative.totalTokens += usage.totalTokens;
}

/**
 * Build a `ChatCallUsageRecord` from a provider call's response
 * and the budgeted prompt shapes measured before and after. Pure
 * data assembly — no class state reads, no mutations, no async.
 *
 * Phase F extraction (PR-3). Previously
 * `ChatExecutor.createCallUsageRecord`.
 */
export function createCallUsageRecord(input: {
  callIndex: number;
  phase: ChatCallUsageRecord["phase"];
  providerName: string;
  response: LLMResponse;
  beforeBudget: ChatPromptShape;
  afterBudget: ChatPromptShape;
  budgetDiagnostics?: PromptBudgetDiagnostics;
  durationMs: number;
}): ChatCallUsageRecord {
  return {
    callIndex: input.callIndex,
    phase: input.phase,
    provider: input.providerName,
    model: input.response.model,
    finishReason: input.response.finishReason,
    usage: input.response.usage,
    durationMs: input.durationMs,
    beforeBudget: input.beforeBudget,
    afterBudget: input.afterBudget,
    providerRequestMetrics: input.response.requestMetrics,
    budgetDiagnostics: input.budgetDiagnostics,
    statefulDiagnostics: input.response.stateful,
    compactionDiagnostics: input.response.compaction,
  };
}
