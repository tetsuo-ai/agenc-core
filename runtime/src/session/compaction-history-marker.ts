/** Authenticated metadata carried only by durable compaction projections. */
export const COMPACTION_HISTORY_MARKER_VERSION = 1 as const;

export interface CompactionHistoryMarkerV1 {
  readonly version: typeof COMPACTION_HISTORY_MARKER_VERSION;
  readonly kind: "boundary" | "summary";
  readonly attempt_id: string;
  readonly summary_sha256: string;
}

export function isAuthenticatedCompactionBoundary(message: {
  readonly role?: string;
  readonly runtimeOnly?: {
    readonly compactionHistory?: CompactionHistoryMarkerV1;
  };
} | undefined): boolean {
  const marker = message?.runtimeOnly?.compactionHistory;
  return message?.role === "developer" &&
    marker?.version === COMPACTION_HISTORY_MARKER_VERSION &&
    marker.kind === "boundary";
}
