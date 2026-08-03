import { createHash } from "node:crypto";
import { redactSecretsInValue } from "../secrets/index.js";

export const RECOVERY_MINIMUM_READER_RUNTIME = "0.13.0";

export const RECOVERY_INTEGRITY_REASON_CODES = Object.freeze([
  "malformed_json",
  "unterminated_record",
  "schema_invalid",
  "unsupported_format_version",
  "sequence_gap",
  "sequence_duplicate",
  "sequence_rewind",
  "legacy_format_violation",
  "identity_conflict",
  "required_terminal_missing",
  "duplicate_terminal",
  "terminal_binding_mismatch",
  "source_hash_mismatch",
  "source_changed",
  "line_byte_limit",
  "source_byte_limit",
  "event_limit",
] as const);

export type RecoveryIntegrityReasonCode =
  (typeof RECOVERY_INTEGRITY_REASON_CODES)[number];

export const RECOVERY_DEFERRED_REASON_CODES = Object.freeze([
  "source_not_quiescent",
  "recovery_lock_unavailable",
  "database_busy",
  "database_io",
  "database_unavailable",
  "recovery_storage_unavailable",
  "projection_failure",
  "startup_byte_budget",
  "startup_time_budget",
  "descriptor_limit",
  "concurrency_limit",
  "recovery_history_storage_limit",
] as const);

export type RecoveryDeferredReasonCode =
  (typeof RECOVERY_DEFERRED_REASON_CODES)[number];

export type RecoveryIncidentState = "active" | "repaired" | "abandoned";
export type RecoveryDeferredState = "active" | "resolved" | "abandoned";
export type RecoverySourceKind = "rollout" | "run_journal";

export const MAX_RECOVERY_HISTORY_PAGE_SIZE = 100;
export const MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN = 128;
export const MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT = 64;
export const MAX_RECOVERY_QUARANTINE_INCIDENTS_TOTAL = 100_000;
export const MAX_RECOVERY_BLOCK_HISTORY_PER_RUN = 128;
export const MAX_RECOVERY_BLOCK_HISTORY_TOTAL = 100_000;
export const MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES = 4_096;
export const MAX_RECOVERY_OPERATOR_NOTE_UTF8_BYTES = 2_048;
export const MAX_RECOVERY_CURSOR_UTF8_BYTES = 1_024;
export const MAX_RECOVERY_ID_UTF8_BYTES = 512;
export const MAX_RECOVERY_SOURCE_PATH_UTF8_BYTES = 16_384;

/** Frozen E1a production defaults. Callers may lower these per recovery run. */
export const DEFAULT_MAX_RECOVERY_LINE_BYTES = 4_194_304;
export const DEFAULT_MAX_RECOVERY_SOURCE_BYTES = 67_108_864;
export const DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN = 1_000_000;
export const DEFAULT_MAX_STARTUP_RECOVERY_BYTES = 1_073_741_824;
export const DEFAULT_MAX_STARTUP_RECOVERY_MS = 30_000;

/** Hard override ceilings. No caller or test may raise a run above these. */
export const HARD_MAX_RECOVERY_LINE_BYTES = 4_194_304;
export const HARD_MAX_RECOVERY_SOURCE_BYTES = 1_073_741_824;
export const HARD_MAX_RECOVERY_EVENTS = 2_000_000;
export const HARD_MAX_RECOVERY_SCAN_MILLISECONDS = 300_000;
export const HARD_MAX_RECOVERY_STARTUP_READ_BYTES =
  HARD_MAX_RECOVERY_SOURCE_BYTES * 2;
/** Compatibility names used by the strict parser contract. */
export const MAX_RECOVERY_CANONICAL_LINE_BYTES = HARD_MAX_RECOVERY_LINE_BYTES;
export const MAX_RECOVERY_CANONICAL_SOURCE_BYTES =
  HARD_MAX_RECOVERY_SOURCE_BYTES;
export const MAX_RECOVERY_CANONICAL_EVENTS = HARD_MAX_RECOVERY_EVENTS;
export const MAX_RECOVERY_SCAN_MILLISECONDS =
  HARD_MAX_RECOVERY_SCAN_MILLISECONDS;
export const MAX_RECOVERY_STARTUP_READ_BYTES =
  HARD_MAX_RECOVERY_STARTUP_READ_BYTES;
export const MAX_RECOVERY_SOURCES_PER_RUN = 32;
export const RECOVERY_SCAN_CHUNK_BYTES = 65_536;
export const RECOVERY_PINNED_DESCRIPTOR_COST = 4;
export const RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST = 1;
export const MAX_RECOVERY_PINNED_DESCRIPTORS =
  MAX_RECOVERY_SOURCES_PER_RUN * RECOVERY_PINNED_DESCRIPTOR_COST +
  RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface RecoveryIntegrityFacts {
  readonly lineNumber?: number;
  readonly byteOffset?: number;
  readonly expectedSequence?: number;
  readonly observedSequence?: number;
}

export class CanonicalJournalIntegrityError extends Error {
  readonly reasonCode: RecoveryIntegrityReasonCode;
  readonly facts: Readonly<RecoveryIntegrityFacts>;

  constructor(
    reasonCode: RecoveryIntegrityReasonCode,
    message: string,
    facts: RecoveryIntegrityFacts = {},
  ) {
    super(message);
    this.name = "CanonicalJournalIntegrityError";
    this.reasonCode = reasonCode;
    this.facts = Object.freeze({ ...facts });
  }
}

/**
 * Operational recovery failures are retryable evidence, not proof that the
 * canonical bytes are corrupt.
 */
export class RecoveryOperationalError extends Error {
  readonly reasonCode: RecoveryDeferredReasonCode;
  readonly errorClass: string;

  constructor(
    reasonCode: RecoveryDeferredReasonCode,
    message: string,
    errorClass = "RECOVERY_OPERATIONAL",
  ) {
    super(message);
    this.name = "RecoveryOperationalError";
    this.reasonCode = reasonCode;
    this.errorClass = errorClass;
  }
}

export function assertRecoverySha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function recoveryIncidentFingerprint(parts: {
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryIntegrityReasonCode;
  readonly sourceSha256: string;
  readonly facts?: RecoveryIntegrityFacts;
}): string {
  return domainSeparatedDigest("agenc.run-recovery-quarantine.v1", [
    parts.runId,
    parts.sourceKind,
    parts.sourcePath,
    parts.reasonCode,
    parts.sourceSha256,
    integerFact(parts.facts?.lineNumber),
    integerFact(parts.facts?.byteOffset),
    integerFact(parts.facts?.expectedSequence),
    integerFact(parts.facts?.observedSequence),
  ]);
}

export function recoveryDeferredKey(parts: {
  readonly runId: string;
  readonly sourceKind: RecoverySourceKind;
  readonly sourcePath: string;
  readonly reasonCode: RecoveryDeferredReasonCode;
  readonly errorClass: string;
}): string {
  return domainSeparatedDigest("agenc.run-recovery-deferred.v1", [
    parts.runId,
    parts.sourceKind,
    parts.sourcePath,
    parts.reasonCode,
    parts.errorClass,
  ]);
}

export function boundedRecoveryDetail(value: unknown): string {
  const redacted = redactSecretsInValue(value);
  const serialized =
    typeof redacted === "string"
      ? redacted
      : (JSON.stringify(redacted) ?? "[unavailable]");
  return truncateUtf8(serialized, MAX_RECOVERY_SAFE_DETAIL_UTF8_BYTES);
}

export function boundedRecoveryNote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError("operator note is required");
  return truncateUtf8(trimmed, MAX_RECOVERY_OPERATOR_NOTE_UTF8_BYTES);
}

export function requiredRecoveryText(
  value: string,
  label: string,
  byteLimit = MAX_RECOVERY_ID_UTF8_BYTES,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(value, "utf8") > byteLimit) {
    throw new TypeError(`${label} is empty or exceeds its byte limit`);
  }
  return value;
}

function domainSeparatedDigest(
  domain: string,
  parts: readonly string[],
): string {
  const hash = createHash("sha256");
  appendLengthPrefixed(hash, domain);
  for (const part of parts) appendLengthPrefixed(hash, part);
  return hash.digest("hex");
}

function appendLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function integerFact(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function truncateUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= byteLimit) return value;
  const suffix = "...[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let prefix = bytes
    .subarray(0, Math.max(0, byteLimit - suffixBytes))
    .toString("utf8");
  while (Buffer.byteLength(prefix + suffix, "utf8") > byteLimit) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + suffix;
}
