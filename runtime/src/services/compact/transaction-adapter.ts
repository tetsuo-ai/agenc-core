import type { CompactContext } from "./types.js";
import type { CompactionTransactionAdapter } from "./transaction-types.js";

export function readCompactionTransactionAdapter(
  context: CompactContext,
): CompactionTransactionAdapter | undefined {
  const direct = context.compactionTransaction;
  if (direct !== undefined) return direct;
  const candidate = (context as CompactContext & {
    readonly rolloutStore?: unknown;
  }).rolloutStore;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const adapter = candidate as Partial<CompactionTransactionAdapter>;
  const methods: ReadonlyArray<keyof CompactionTransactionAdapter> = [
    "acquireCompactionLease",
    "prepareSource",
    "failureCount",
    "pinAndRecordIntent",
    "recordFailure",
    "commit",
    "markProjectionComplete",
    "markProjectionFailed",
    "markCleanupComplete",
    "markCleanupPending",
  ];
  if (methods.some((name) => typeof adapter[name] !== "function")) return undefined;
  if (typeof adapter.sessionId !== "string" || !Number.isSafeInteger(adapter.epoch)) {
    return undefined;
  }
  return adapter as CompactionTransactionAdapter;
}

