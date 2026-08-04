import { CompactionReconstructionRequiredError } from "./transaction-types.js";

export interface CompactionTransactionFinalizerStore {
  markProjectionComplete(attemptId: string): void;
  markProjectionFailed(attemptId: string, reason: unknown): never;
  markCleanupComplete(attemptId: string): void;
  markCleanupPending(attemptId: string, reason: unknown): void;
}

/** The committed projection is usable, but process-local cleanup must retry. */
export class CompactionCleanupPendingError extends Error {
  constructor(
    readonly attemptId: string,
    options?: ErrorOptions,
  ) {
    super(
      `compaction ${attemptId} committed with cleanup pending`,
      options,
    );
    this.name = "CompactionCleanupPendingError";
  }
}

/**
 * Finish a durable compaction in the only valid order: project the committed
 * history, acknowledge that projection, run every caller cleanup, then mark
 * cleanup complete. A committed history is never retried after either local
 * phase fails; restart reconstruction is the recovery path.
 */
export async function finalizeCompactionTransaction(params: {
  readonly store: CompactionTransactionFinalizerStore;
  readonly attemptId: string;
  readonly applyProjection: () => void | Promise<void>;
  readonly cleanup: () => void | Promise<void>;
}): Promise<void> {
  try {
    await params.applyProjection();
    params.store.markProjectionComplete(params.attemptId);
  } catch (error) {
    params.store.markProjectionFailed(params.attemptId, error);
  }

  try {
    await params.cleanup();
    params.store.markCleanupComplete(params.attemptId);
  } catch (error) {
    try {
      params.store.markCleanupPending(params.attemptId, error);
    } catch (markError) {
      throw new CompactionReconstructionRequiredError(params.attemptId, {
        cause: new AggregateError([error, markError]),
      });
    }
    throw new CompactionCleanupPendingError(params.attemptId, {
      cause: error,
    });
  }
}
