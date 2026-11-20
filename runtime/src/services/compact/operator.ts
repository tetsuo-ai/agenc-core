import type {
  CompactionProjectionMessageV1,
  CompactionRollbackCommittedV1,
} from "./transaction-types.js";
import { CompactionCannotReduceError } from "./transaction-types.js";

const MAX_SESSION_ID_LENGTH = 128;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
const CANONICAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * The attempt each declined compaction wrote its durable failure record
 * under. It is kept beside the error as data, for the daemon log and a
 * client's diagnostics, never in a sentence a person reads.
 */
const declinedAttempts = new WeakMap<Error, string>();

/** Records the attempt a declined compaction's failure record was written under. */
export function recordDeclinedCompactionAttempt(error: Error, attemptId: string): void {
  declinedAttempts.set(error, attemptId);
}

/** The attempt recorded for a declined compaction, on the error or one of its causes. */
export function declinedCompactionAttemptId(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const attemptId = declinedAttempts.get(current);
    if (attemptId !== undefined) return attemptId;
    current = current.cause;
  }
  return undefined;
}

/**
 * A manual compaction Core declined because a summary would not shrink the
 * conversation. The message is the plain sentence; the attempt id is data.
 */
export class CompactionDeclinedError extends Error {
  readonly code = "NOTHING_TO_COMPACT";

  constructor(
    message: string,
    readonly attemptId: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompactionDeclinedError";
  }
}

/** Keep accounting diagnostics on the underlying error, with plain operator text. */
export function compactionCannotShrinkDisplay(error: unknown): string | undefined {
  if (!(error instanceof CompactionCannotReduceError) || error.code !== "no_shrink") {
    return undefined;
  }
  return "Nothing to compact yet. A summary would not reduce this conversation enough; history was not changed.";
}

/**
 * What a manual compaction answers when Core declined it: the plain
 * sentence, with the declined attempt's id as data. Undefined for any other
 * failure.
 */
export function compactionDeclinedError(error: unknown): CompactionDeclinedError | undefined {
  const message = compactionCannotShrinkDisplay(error);
  return message === undefined
    ? undefined
    : new CompactionDeclinedError(message, declinedCompactionAttemptId(error), { cause: error });
}

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
