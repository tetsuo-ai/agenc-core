import {
  MAX_COMPACTION_OUTPUT_NODES_TOTAL,
  MAX_COMPACTION_OUTPUT_UTF8_BYTES_TOTAL,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SCHEMA_WORK_UNITS_PER_OUTPUT,
  MAX_COMPACTION_WALL_MS,
  CompactionTransactionError,
} from "./transaction-types.js";

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
 * A tokenizer can emit at most one token per UTF-8 byte. Provider usage is
 * authoritative when present; the greater value is a fail-closed upper bound.
 */
export function compactionOutputTokenUpperBound(
  content: string,
  reportedCompletionTokens: number | undefined,
): number {
  const utf8UpperBound = Buffer.byteLength(content, "utf8");
  if (
    reportedCompletionTokens !== undefined &&
    Number.isSafeInteger(reportedCompletionTokens) &&
    reportedCompletionTokens >= 0
  ) {
    return Math.max(reportedCompletionTokens, utf8UpperBound);
  }
  return utf8UpperBound;
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
