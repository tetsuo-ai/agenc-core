import type {
  CompactionProjectionMessageV1,
  CompactionRollbackCommittedV1,
} from "./transaction-types.js";

const MAX_SESSION_ID_LENGTH = 128;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const CANONICAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export interface CompactionOperatorStore {
  rollbackCompaction(params: {
    readonly attemptId: string;
    readonly nowMs: number;
    readonly reviewedBranchTargetSessionId?: string;
  }): CompactionRollbackCommittedV1;
  extendCompactionRollbackRetention(
    attemptId: string,
    extendedUntilMs: number,
  ): void;
  recordProjectionFailure(attemptId: string, reason: unknown): void;
}

export interface CompactionRollbackOperatorResult {
  readonly attemptId: string;
  readonly mode: "same_session" | "reviewed_branch";
  readonly targetSessionId: string;
  readonly sourceHistory: readonly CompactionProjectionMessageV1[];
}

export function formatCompactionOperatorDisplay(
  displayText: string,
  attemptId: string | undefined,
): string {
  return attemptId === undefined
    ? displayText
    : `${displayText}\nRollback attempt ID: ${attemptId}`;
}

export function rollbackCompactionForOperator(params: {
  readonly store: CompactionOperatorStore;
  readonly attemptId: string;
  readonly nowMs: number;
  readonly reviewedBranchTargetSessionId?: string;
}): CompactionRollbackOperatorResult {
  const attemptId = requireIdentifier(params.attemptId, "compaction attempt id");
  const reviewedBranchTargetSessionId = params.reviewedBranchTargetSessionId === undefined
    ? undefined
    : requireSessionId(params.reviewedBranchTargetSessionId);
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error("compaction rollback time must be a non-negative integer");
  }
  const rollback = params.store.rollbackCompaction({
    attemptId,
    nowMs: params.nowMs,
    ...(reviewedBranchTargetSessionId !== undefined
      ? { reviewedBranchTargetSessionId }
      : {}),
  });
  return {
    attemptId: rollback.attempt_id,
    mode: rollback.rollback_mode,
    targetSessionId: rollback.target_session_id,
    sourceHistory: rollback.source_history,
  };
}

export function extendCompactionRetentionForOperator(params: {
  readonly store: CompactionOperatorStore;
  readonly attemptId: string;
  readonly extendedUntilMs: number;
  readonly nowMs: number;
}): void {
  const attemptId = requireIdentifier(params.attemptId, "compaction attempt id");
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error("current time must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(params.extendedUntilMs) ||
    params.extendedUntilMs <= params.nowMs
  ) {
    throw new Error("compaction retention deadline must be a future timestamp");
  }
  if (params.extendedUntilMs > MAX_JAVASCRIPT_DATE_MS) {
    throw new Error(
      "compaction retention deadline must be a valid JavaScript date",
    );
  }
  params.store.extendCompactionRollbackRetention(
    attemptId,
    params.extendedUntilMs,
  );
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required`);
  return normalized;
}

function requireSessionId(value: string): string {
  const normalized = requireIdentifier(value, "reviewed branch session id");
  if (
    normalized.length > MAX_SESSION_ID_LENGTH ||
    !CANONICAL_SESSION_ID.test(normalized)
  ) {
    throw new Error("reviewed branch session id is not canonical or path-safe");
  }
  return normalized;
}
