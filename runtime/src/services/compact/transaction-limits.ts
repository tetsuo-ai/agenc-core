import {
  MAX_COMPACTION_OUTPUT_NODES_TOTAL,
  MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT,
  MAX_COMPACTION_WALL_MS,
  CompactionTransactionError,
} from "./transaction-types.js";
import { roughTokenCountEstimation } from "../../llm/token-estimation.js";

interface CompactionOutputTotals {
  readonly bytes: number;
  readonly nodes: number;
  readonly workUnits: number;
}

interface CompactionOutputBudgetDelta {
  readonly bytes: number;
  readonly nodes: number;
  readonly workUnits: number;
}

export function accumulateCompactionOutputBudget(
  totals: CompactionOutputTotals,
  delta: CompactionOutputBudgetDelta,
): CompactionOutputTotals {
  const next = {
    bytes: safeBudgetSum(totals.bytes, delta.bytes),
    nodes: safeBudgetSum(totals.nodes, delta.nodes),
    workUnits: safeBudgetSum(totals.workUnits, delta.workUnits),
  };
  if (
    next.bytes > MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL ||
    next.nodes > MAX_COMPACTION_OUTPUT_NODES_TOTAL ||
    next.workUnits >
      MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT * MAX_COMPACTION_PROVIDER_CALLS
  ) {
    throw new CompactionTransactionError(
      "output_limit_exceeded",
      "compaction provider outputs exceeded an aggregate limit",
    );
  }
  return next;
}

/**
 * Bytes per token assumed for compaction output when no tokenizer and no
 * provider usage is available: half the runtime's default of four, so the
 * estimate errs high without pretending every byte is a token. The old
 * one-token-per-byte bound rejected any summary over 8 KB, which is every
 * summary of a session long enough to need compacting.
 */
export const CONSERVATIVE_OUTPUT_BYTES_PER_TOKEN = 2;

export function conservativeOutputTokenEstimate(content: string): number {
  return roughTokenCountEstimation(content, CONSERVATIVE_OUTPUT_BYTES_PER_TOKEN);
}

/**
 * Provider usage is authoritative when present: the provider counted the
 * tokens it produced. Without it, a conservative estimate stands in.
 */
export function compactionOutputTokenUpperBound(
  content: string,
  reportedCompletionTokens: number | undefined,
): number {
  if (
    reportedCompletionTokens !== undefined &&
    Number.isSafeInteger(reportedCompletionTokens) &&
    reportedCompletionTokens >= 0
  ) {
    return reportedCompletionTokens;
  }
  return conservativeOutputTokenEstimate(content);
}

export function compactionWallTimeExceeded(elapsedMs: number): boolean {
  return elapsedMs > MAX_COMPACTION_WALL_MS;
}

function safeBudgetSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < left) {
    throw new CompactionTransactionError(
      "output_limit_exceeded",
      "compaction aggregate budget overflow",
    );
  }
  return sum;
}
