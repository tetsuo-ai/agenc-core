/** Authenticated metadata carried only by durable compaction projections. */
export const COMPACTION_HISTORY_MARKER_VERSION = 1 as const;
const COMPACTION_HISTORY_MARKER_KEYS = Object.freeze([
  "attempt_id",
  "kind",
  "summary_sha256",
  "version",
]);
const COMPACTION_HISTORY_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_COMPACTION_HISTORY_ATTEMPT_ID_BYTES = 4_096;

export interface CompactionHistoryMarkerV1 {
  readonly version: typeof COMPACTION_HISTORY_MARKER_VERSION;
  readonly kind: "boundary" | "summary";
  readonly attempt_id: string;
  readonly summary_sha256: string;
}

/**
 * Fail closed on any marker that is not the exact v1 durable shape.
 * Checkpoint prefix hashing and compaction-event reads share this gate so a
 * writer-emitted `compactionHistory` field cannot be treated as unversioned.
 */
export function assertCompactionHistoryMarkerV1(
  value: unknown,
): asserts value is CompactionHistoryMarkerV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("compaction-history marker must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== COMPACTION_HISTORY_MARKER_KEYS.length ||
    COMPACTION_HISTORY_MARKER_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    )
  ) {
    throw new Error("compaction-history marker has unknown or missing fields");
  }
  if (record.version !== COMPACTION_HISTORY_MARKER_VERSION) {
    throw new Error("unsupported compaction-history marker version");
  }
  if (record.kind !== "boundary" && record.kind !== "summary") {
    throw new Error("unsupported compaction-history marker kind");
  }
  if (
    typeof record.attempt_id !== "string" ||
    record.attempt_id.length === 0 ||
    Buffer.byteLength(record.attempt_id, "utf8") >
      MAX_COMPACTION_HISTORY_ATTEMPT_ID_BYTES
  ) {
    throw new Error("compaction-history attempt_id must be a bounded nonempty string");
  }
  if (
    typeof record.summary_sha256 !== "string" ||
    !COMPACTION_HISTORY_SHA256_PATTERN.test(record.summary_sha256)
  ) {
    throw new Error("compaction-history summary_sha256 must be lowercase SHA-256");
  }
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
