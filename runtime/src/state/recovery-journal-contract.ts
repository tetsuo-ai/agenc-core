import { createHash, type Hash } from "node:crypto";
import {
  parseRolloutLine,
  ROLLOUT_ITEM_VERSION,
  type RolloutItem,
} from "../session/rollout-item.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  isKnownEventType,
} from "../session/event-log.js";
import {
  CanonicalJournalIntegrityError,
  MAX_RECOVERY_CANONICAL_EVENTS,
  MAX_RECOVERY_CANONICAL_LINE_BYTES,
  MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
  assertRecoverySha256,
  type RecoveryIntegrityFacts,
  type RecoveryIntegrityReasonCode,
} from "./recovery-contract.js";
import {
  isCanonicalEventPayload,
  isCanonicalRolloutPayload,
} from "./recovery-journal-schema.js";
import {
  COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
  MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES,
  COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN,
  type CompactionPayloadKind,
} from "../services/compact/transaction-types.js";
import {
  canonicalizeJson,
  digestWithDomain,
} from "../services/compact/summary-v1.js";

export type CanonicalJournalFormat =
  "empty" | "sequenced_v1" | "legacy_unsequenced_v1";

export interface StrictCanonicalJournalRecord {
  readonly item: RolloutItem;
  readonly lineNumber: number;
  readonly byteOffset: number;
  readonly encodedByteLength: number;
  readonly lineSha256: string;
  readonly rollingSha256: string;
}

export interface StrictCanonicalJournal {
  readonly records: readonly StrictCanonicalJournalRecord[];
  readonly recordCount: number;
  readonly format: CanonicalJournalFormat;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly physicalLineCount: number;
  readonly eventCount: number;
  readonly terminalCount: number;
  readonly digestAnchored: boolean;
}

export interface StrictCanonicalJournalOptions {
  readonly expectedRunId?: string;
  readonly expectedEpoch?: number;
  readonly terminalPolicy?: "allow_missing" | "require_terminal";
  readonly trustedSourceSha256?: string;
  /** Retain parsed rows for small in-memory callers. E1a disables this. */
  readonly retainRecords?: boolean;
  /** Consume one bounded row as it is validated. */
  readonly onRecord?: (record: StrictCanonicalJournalRecord) => void;
  /** Disk-backed identity registry used by E1a's first pass. */
  readonly identityRegistry?: CanonicalJournalIdentityRegistry;
  /**
   * A second pass anchored to `trustedSourceSha256` may omit O(N) identity
   * state. A digest mismatch rolls its surrounding projection transaction
   * back before commit.
   */
  readonly identityPolicy?: "validate" | "trusted_replay";
  readonly maxLineBytes?: number;
  readonly maxSourceBytes?: number;
  readonly maxEvents?: number;
  /** Throws a typed operational error when an outer scan budget expires. */
  readonly checkOperationalBudget?: () => void;
}

export interface CanonicalJournalIdentityRegistry {
  claimEventId(eventId: string): boolean;
  claimTerminalKey(terminalKey: string): boolean;
}

const MAX_CANONICAL_JSON_DEPTH = 128;
const LINE_FEED_BYTE = 0x0a;
const CARRIAGE_RETURN_BYTE = 0x0d;
const KNOWN_CANONICAL_TYPES = new Set<string>([
  "session_meta",
  "session_state",
  "response_item",
  "compacted",
  "turn_context",
  "event_msg",
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
]);
const COMPACTION_CANONICAL_TYPES = new Set<string>([
  "compaction_intent",
  "compaction_payload_chunk",
  "compaction_failed",
  "compaction_committed",
  "compaction_cleanup_pending",
  "compaction_rollback_committed",
  "compaction_retention_extended",
  "compaction_source_release",
]);
const LEGACY_EVENT_TYPE_ALIASES = new Set<string>([
  "task_started",
  "task_complete",
]);

/**
 * Incremental strict validator for canonical recovery input. It owns no file
 * descriptors and imposes no aggregate resource policy; E1a supplies those
 * mechanisms around this byte-fed contract.
 */
export class StrictCanonicalJournalValidator {
  readonly #options: StrictCanonicalJournalOptions;
  readonly #sourceHash: Hash = createHash("sha256");
  readonly #rollingHash: Hash = createHash("sha256");
  readonly #records: StrictCanonicalJournalRecord[] = [];
  readonly #eventIds = new Set<string>();
  readonly #terminalKeys = new Set<string>();
  readonly #pendingChunks: Buffer[] = [];
  #pendingByteLength = 0;
  readonly #maxLineBytes: number;
  readonly #maxSourceBytes: number;
  readonly #maxEvents: number;
  #sourceByteLength = 0;
  #processedByteLength = 0;
  #physicalLineCount = 0;
  #eventCount = 0;
  #recordCount = 0;
  #terminalCount = 0;
  #matchingTerminalCount = 0;
  #format: CanonicalJournalFormat = "empty";
  #nextSequence = 1;
  #finished = false;
  readonly #compactionAttempts = new Map<string, {
    intent?: Readonly<Record<string, unknown>>;
    terminal?: "failed" | "committed";
    commitSha256?: string;
    retentionDeadlineMs?: number;
    retentionExtensionDigests?: Set<string>;
    rollback?: true;
    release?: true;
    payloadChunks?: Map<CompactionPayloadKind, {
      payloadSha256: string;
      chunkCount: number;
      nextIndex: number;
      previousChunkSha256: string;
      fragmentUtf8Bytes: number;
      complete: boolean;
    }>;
    lastPayloadKind?: CompactionPayloadKind;
  }>();

  constructor(options: StrictCanonicalJournalOptions = {}) {
    this.#options = Object.freeze({ ...options });
    if (options.trustedSourceSha256 !== undefined) {
      assertRecoverySha256(options.trustedSourceSha256, "trustedSourceSha256");
    }
    if (
      options.identityPolicy === "trusted_replay" &&
      options.trustedSourceSha256 === undefined
    ) {
      throw new TypeError(
        "trusted_replay identity policy requires trustedSourceSha256",
      );
    }
    this.#maxLineBytes = boundedCeiling(
      options.maxLineBytes,
      MAX_RECOVERY_CANONICAL_LINE_BYTES,
      "maxLineBytes",
    );
    this.#maxSourceBytes = boundedCeiling(
      options.maxSourceBytes,
      MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
      "maxSourceBytes",
    );
    this.#maxEvents = boundedCeiling(
      options.maxEvents,
      MAX_RECOVERY_CANONICAL_EVENTS,
      "maxEvents",
      0,
    );
  }

  push(chunk: Uint8Array): void {
    if (this.#finished)
      throw new Error("canonical journal validator is closed");
    this.#options.checkOperationalBudget?.();
    const bytes = Buffer.from(chunk);
    if (bytes.byteLength === 0) return;
    if (this.#sourceByteLength + bytes.byteLength > this.#maxSourceBytes) {
      this.#fail(
        "source_byte_limit",
        "canonical journal exceeds its source byte ceiling",
        {
          byteOffset: this.#sourceByteLength,
        },
      );
    }
    this.#sourceHash.update(bytes);
    this.#sourceByteLength += bytes.byteLength;
    let start = 0;
    while (start < bytes.byteLength) {
      const index = bytes.indexOf(LINE_FEED_BYTE, start);
      if (index === -1) break;
      const segment = bytes.subarray(start, index + 1);
      if (this.#pendingByteLength === 0) {
        this.#acceptPhysicalLine(segment);
      } else {
        const ownedSegment = Buffer.from(segment);
        this.#pendingChunks.push(ownedSegment);
        this.#pendingByteLength += ownedSegment.byteLength;
        const physical = Buffer.concat(
          this.#pendingChunks,
          this.#pendingByteLength,
        );
        this.#pendingChunks.length = 0;
        this.#pendingByteLength = 0;
        this.#acceptPhysicalLine(physical);
      }
      start = index + 1;
    }
    if (start < bytes.byteLength) {
      const tail = Buffer.from(bytes.subarray(start));
      this.#pendingChunks.push(tail);
      this.#pendingByteLength += tail.byteLength;
    }
    if (this.#pendingByteLength > this.#maxLineBytes + 1) {
      this.#fail(
        "line_byte_limit",
        "canonical journal record exceeds its line byte ceiling",
        {
          lineNumber: this.#physicalLineCount + 1,
          byteOffset: this.#processedByteLength,
        },
      );
    }
  }

  finish(): StrictCanonicalJournal {
    if (this.#finished)
      throw new Error("canonical journal validator is closed");
    this.#finished = true;
    if (this.#pendingByteLength > 0) {
      this.#fail(
        "unterminated_record",
        "canonical journal ends without a newline",
        {
          lineNumber: this.#physicalLineCount + 1,
          byteOffset: this.#processedByteLength,
        },
      );
    }
    const sourceSha256 = this.#sourceHash.digest("hex");
    if (
      this.#options.trustedSourceSha256 !== undefined &&
      sourceSha256 !== this.#options.trustedSourceSha256
    ) {
      this.#fail(
        "source_hash_mismatch",
        "canonical journal digest does not match its durable binding",
      );
    }
    if (
      this.#options.terminalPolicy === "require_terminal" &&
      this.#matchingTerminalCount === 0
    ) {
      this.#fail(
        "required_terminal_missing",
        "canonical journal is missing its required terminal",
      );
    }
    for (const attempt of this.#compactionAttempts.values()) {
      const sourceHistoryManifest = attempt.intent?.source_history_manifest;
      if (!isPlainRecord(sourceHistoryManifest)) continue;
      const sourceHistory = attempt.payloadChunks?.get("source_history");
      if (sourceHistory !== undefined) continue;
      if (attempt.terminal !== "committed" || attempt.release !== true) {
        this.#fail(
          "identity_conflict",
          "compaction source_history manifest has no chunk chain or durable release",
        );
      }
    }
    return Object.freeze({
      records: Object.freeze(this.#records.slice()),
      recordCount: this.#recordCount,
      format: this.#format,
      sourceSha256,
      sourceByteLength: this.#sourceByteLength,
      physicalLineCount: this.#physicalLineCount,
      eventCount: this.#eventCount,
      terminalCount: this.#terminalCount,
      digestAnchored: this.#options.trustedSourceSha256 !== undefined,
    });
  }

  #acceptPhysicalLine(physical: Buffer): void {
    this.#options.checkOperationalBudget?.();
    const lineNumber = this.#physicalLineCount + 1;
    const byteOffset = this.#processedByteLength;
    this.#physicalLineCount = lineNumber;
    this.#processedByteLength += physical.byteLength;
    this.#rollingHash.update(physical);
    let content = physical.subarray(0, physical.byteLength - 1);
    if (content.at(-1) === CARRIAGE_RETURN_BYTE) {
      content = content.subarray(0, -1);
    }
    if (content.byteLength > this.#maxLineBytes) {
      this.#fail(
        "line_byte_limit",
        "canonical journal record exceeds its line byte ceiling",
        {
          lineNumber,
          byteOffset,
        },
      );
    }
    if (content.byteLength === 0) {
      this.#fail(
        "schema_invalid",
        "canonical journal contains a blank record",
        {
          lineNumber,
          byteOffset,
        },
      );
    }
    const line = decodeCanonicalUtf8(content, lineNumber, byteOffset);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#fail(
        "malformed_json",
        "canonical journal contains malformed JSON",
        {
          lineNumber,
          byteOffset,
        },
      );
    }
    try {
      assertNoDuplicateJsonObjectKeys(line);
    } catch (error) {
      this.#fail(
        "schema_invalid",
        error instanceof Error
          ? error.message
          : "canonical JSON object contains duplicate keys",
        { lineNumber, byteOffset },
      );
    }
    const item = this.#validateRolloutItem(parsed, lineNumber, byteOffset);
    const record = Object.freeze({
      item,
      lineNumber,
      byteOffset,
      encodedByteLength: content.byteLength,
      lineSha256: createHash("sha256").update(content).digest("hex"),
      rollingSha256: this.#rollingHash.copy().digest("hex"),
    });
    this.#recordCount += 1;
    if (this.#options.retainRecords !== false) this.#records.push(record);
    this.#options.onRecord?.(record);
  }

  #validateRolloutItem(
    value: unknown,
    lineNumber: number,
    byteOffset: number,
  ): RolloutItem {
    const facts = { lineNumber, byteOffset };
    if (!isPlainRecord(value)) {
      this.#fail(
        "schema_invalid",
        "canonical journal record must be a JSON object",
        facts,
      );
    }
    const type = value.type;
    if (typeof type !== "string" || !KNOWN_CANONICAL_TYPES.has(type)) {
      this.#fail(
        "unsupported_format_version",
        "canonical journal record type is not supported by this runtime",
        facts,
      );
    }
    if (!isPlainRecord(value.payload)) {
      this.#fail(
        "schema_invalid",
        "canonical journal record payload must be an object",
        facts,
      );
    }
    if (type === "event_msg") {
      this.#rejectUnsupportedEventType(value.payload, facts);
    }
    if (!isCanonicalRolloutPayload(type, value.payload)) {
      this.#fail(
        "schema_invalid",
        `canonical ${type} payload does not match the runtime schema`,
        facts,
      );
    }
    if (!supportedItemVersion(type, value.eventVersion)) {
      this.#fail(
        "unsupported_format_version",
        "canonical journal record version is not supported by this runtime",
        facts,
      );
    }
    if (type === "session_meta")
      this.#validateSessionMeta(value.payload, facts);
    if (type === "event_msg") this.#validateEvent(value.payload, facts);
    const item = parseRolloutLine(JSON.stringify(value));
    if (item === null || item.type === "unknown") {
      this.#fail(
        "schema_invalid",
        "canonical journal record could not be normalized",
        facts,
      );
    }
    this.#validateCompactionState(item, facts);
    return item;
  }

  #validateCompactionState(
    item: RolloutItem,
    facts: RecoveryIntegrityFacts,
  ): void {
    if (!COMPACTION_CANONICAL_TYPES.has(item.type)) return;
    const payload = item.payload as Readonly<Record<string, unknown>>;
    const attemptId = payload.attempt_id;
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      this.#fail("schema_invalid", "compaction event has no attempt id", facts);
    }
    const current = this.#compactionAttempts.get(attemptId) ?? {};
    if (item.type === "compaction_intent") {
      if (current.intent !== undefined || current.terminal !== undefined) {
        this.#fail("identity_conflict", "duplicate or out-of-order compaction intent", facts);
      }
      const source = payload.source as Readonly<Record<string, unknown>>;
      if (
        (this.#options.expectedRunId !== undefined &&
          source.session_id !== this.#options.expectedRunId) ||
        (this.#options.expectedEpoch !== undefined &&
          source.epoch !== this.#options.expectedEpoch)
      ) {
        this.#fail(
          "identity_conflict",
          "compaction intent source does not match the expected run epoch",
          facts,
        );
      }
      current.intent = payload;
      current.payloadChunks = new Map();
      this.#compactionAttempts.set(attemptId, current);
      return;
    }
    if (item.type === "compaction_payload_chunk") {
      if (current.intent === undefined) {
        this.#fail(
          "identity_conflict",
          "compaction payload chunk precedes its intent",
          facts,
        );
      }
      if (current.terminal !== undefined) {
        this.#fail(
          "identity_conflict",
          "compaction payload chunk follows its terminal",
          facts,
        );
      }
      const kind = item.payload.payload_kind;
      const chunks = current.payloadChunks ?? new Map();
      const existing = chunks.get(kind);
      const previousKindState = current.lastPayloadKind === undefined
        ? undefined
        : chunks.get(current.lastPayloadKind);
      if (
        previousKindState?.complete === false ||
        current.lastPayloadKind !== undefined &&
        current.lastPayloadKind !== kind &&
        existing !== undefined
      ) {
        this.#fail(
          "identity_conflict",
          "compaction payload chunks are not contiguous by kind",
          facts,
        );
      }
      const state = existing ?? {
        payloadSha256: item.payload.payload_sha256,
        chunkCount: item.payload.chunk_count,
        nextIndex: 0,
        previousChunkSha256: "0".repeat(64),
        fragmentUtf8Bytes: 0,
        complete: false,
      };
      if (
        state.complete ||
        item.payload.payload_sha256 !== state.payloadSha256 ||
        item.payload.chunk_count !== state.chunkCount ||
        item.payload.chunk_index !== state.nextIndex ||
        item.payload.previous_chunk_sha256 !== state.previousChunkSha256
      ) {
        this.#fail(
          "identity_conflict",
          "compaction payload chunk is duplicated, missing, reordered, or mismatched",
          facts,
        );
      }
      state.nextIndex += 1;
      state.previousChunkSha256 = item.payload.chunk_sha256;
      state.fragmentUtf8Bytes += item.payload.fragment_utf8_bytes;
      state.complete = state.nextIndex === state.chunkCount;
      if (
        !Number.isSafeInteger(state.fragmentUtf8Bytes) ||
        state.fragmentUtf8Bytes > MAX_COMPACTION_PAYLOAD_CANONICAL_UTF8_BYTES
      ) {
        this.#fail(
          "source_byte_limit",
          "compaction payload chunks exceed their aggregate byte limit",
          facts,
        );
      }
      chunks.set(kind, state);
      current.payloadChunks = chunks;
      current.lastPayloadKind = kind;
      return;
    }
    if (current.intent === undefined) {
      this.#fail("identity_conflict", "compaction terminal precedes its intent", facts);
    }
    if (item.type === "compaction_failed" || item.type === "compaction_committed") {
      if (current.terminal !== undefined) {
        this.#fail("identity_conflict", "compaction attempt has conflicting terminals", facts);
      }
      if (item.type === "compaction_committed") {
        if ([...(current.payloadChunks?.values() ?? [])].some(
          (chunkState) => !chunkState.complete
        )) {
          this.#fail(
            "identity_conflict",
            "compaction commit follows an incomplete payload chunk chain",
            facts,
          );
        }
        const source = payload.source as Readonly<Record<string, unknown>>;
        const intentSource = current.intent.source as Readonly<Record<string, unknown>>;
        for (const key of [
          "attempt_id", "session_id", "epoch", "source_binding",
          "first_sequence", "last_sequence", "source_sha256",
          "source_bytes", "history_digest",
        ] as const) {
          if (source[key] !== intentSource[key]) {
            this.#fail("identity_conflict", `compaction commit source conflicts at ${key}`, facts);
          }
        }
        const persistedManifestCommit =
          source.active_history_refs_manifest !== undefined;
        const sourceAuthorityMatches = persistedManifestCommit
          ? canonicalizeJson(source.active_history_refs_manifest) ===
            canonicalizeJson(intentSource.active_history_refs_manifest)
          : canonicalizeJson(source.active_history_refs) ===
            canonicalizeJson(intentSource.active_history_refs);
        if (!sourceAuthorityMatches) {
          this.#fail(
            "identity_conflict",
            "compaction commit conflicts at active-history authority",
            facts,
          );
        }
        for (const key of ["policy_digest", "configuration_digest"] as const) {
          if (payload[key] !== current.intent[key]) {
            this.#fail("identity_conflict", `compaction commit conflicts at ${key}`, facts);
          }
        }
        if (persistedManifestCommit) {
          const intentManifest = current.intent.source_history_manifest;
          this.#assertPayloadManifestComplete(
            current,
            intentSource.active_history_refs_manifest,
            facts,
          );
          if (current.payloadChunks?.has("source_history") === true) {
            this.#assertPayloadManifestComplete(current, intentManifest, facts);
          }
          this.#assertPayloadManifestComplete(
            current,
            payload.final_summary_manifest,
            facts,
          );
          this.#assertPayloadManifestComplete(
            current,
            payload.summary_dag_manifest,
            facts,
          );
          this.#assertPayloadManifestComplete(
            current,
            payload.replacement_history_manifest,
            facts,
          );
        } else {
          const summaryDag = payload.summary_dag as Readonly<Record<string, unknown>>;
          if (
            summaryDag.planned_provider_calls !==
            current.intent.planned_provider_calls
          ) {
            this.#fail(
              "identity_conflict",
              "compaction commit provider-call plan conflicts with its intent",
              facts,
            );
          }
        }
      } else if (
        payload.source_sha256 !==
          (current.intent.source as Readonly<Record<string, unknown>>).source_sha256 ||
        payload.history_digest !==
          (current.intent.source as Readonly<Record<string, unknown>>).history_digest
      ) {
        this.#fail("identity_conflict", "compaction failure conflicts with its intent", facts);
      }
      current.terminal = item.type === "compaction_failed" ? "failed" : "committed";
      if (item.type === "compaction_committed") {
        if (payload.final_summary_manifest === undefined) {
          current.commitSha256 = digestWithDomain(
            COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
            payload,
          );
        }
        current.retentionDeadlineMs = payload.rollback_retention_deadline_ms as number;
        current.retentionExtensionDigests = new Set();
      }
      return;
    }
    if (current.terminal !== "committed") {
      this.#fail("identity_conflict", "compaction post-commit event has no commit", facts);
    }
    if (current.commitSha256 !== undefined &&
        payload.commit_sha256 !== current.commitSha256) {
      this.#fail(
        "identity_conflict",
        "compaction post-commit event is not bound to its canonical commit",
        facts,
      );
    }
    const intentSource = current.intent.source as Readonly<Record<string, unknown>>;
    if (
      (item.type === "compaction_rollback_committed" ||
        item.type === "compaction_retention_extended" ||
        item.type === "compaction_source_release") &&
      (payload.source_sha256 !== intentSource.source_sha256 ||
        payload.source_session_id !== intentSource.session_id ||
        payload.source_epoch !== intentSource.epoch)
    ) {
      this.#fail(
        "identity_conflict",
        "compaction post-commit event conflicts with its source authority",
        facts,
      );
    }
    if (
      item.type === "compaction_rollback_committed" &&
      payload.history_digest !== intentSource.history_digest
    ) {
      this.#fail(
        "identity_conflict",
        "compaction rollback history digest conflicts with its source authority",
        facts,
      );
    }
    if (item.type === "compaction_rollback_committed") {
      const rollbackManifest = payload.source_history_manifest;
      if (
        rollbackManifest !== undefined &&
        canonicalizeJson(rollbackManifest) !==
          canonicalizeJson(current.intent.source_history_manifest)
      ) {
        this.#fail(
          "identity_conflict",
          "compaction rollback source-history manifest conflicts with its intent",
          facts,
        );
      }
      if (current.rollback === true) {
        this.#fail("identity_conflict", "duplicate compaction rollback", facts);
      }
      const sameSession = payload.rollback_mode === "same_session";
      if (
        (sameSession && payload.target_session_id !== intentSource.session_id) ||
        (!sameSession && payload.target_session_id === intentSource.session_id)
      ) {
        this.#fail(
          "identity_conflict",
          "compaction rollback mode conflicts with its target session",
          facts,
        );
      }
      current.rollback = true;
    }
    if (item.type === "compaction_retention_extended") {
      if (current.release === true) {
        this.#fail(
          "identity_conflict",
          "compaction retention extension follows source release",
          facts,
        );
      }
      if (
        payload.previous_retention_deadline_ms !== current.retentionDeadlineMs ||
        typeof payload.effective_retention_deadline_ms !== "number" ||
        payload.effective_retention_deadline_ms <=
          (current.retentionDeadlineMs ?? Number.MAX_SAFE_INTEGER)
      ) {
        this.#fail(
          "identity_conflict",
          "compaction retention extension does not continue its durable deadline",
          facts,
        );
      }
      const extensionSha256 = payload.extension_sha256;
      const extensionMaterial = { ...payload };
      delete extensionMaterial.extension_sha256;
      if (
        typeof extensionSha256 !== "string" ||
        extensionSha256 !== digestWithDomain(
          COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN,
          extensionMaterial,
        ) ||
        current.retentionExtensionDigests?.has(extensionSha256) === true
      ) {
        this.#fail(
          "identity_conflict",
          "compaction retention extension digest is invalid or duplicated",
          facts,
        );
      }
      current.retentionExtensionDigests?.add(extensionSha256);
      current.retentionDeadlineMs = payload.effective_retention_deadline_ms;
    }
    if (item.type === "compaction_source_release") {
      if (current.release === true) {
        this.#fail("identity_conflict", "duplicate compaction source release", facts);
      }
      if (payload.retention_deadline_ms !== current.retentionDeadlineMs) {
        this.#fail(
          "identity_conflict",
          "compaction source release does not bind the effective retention deadline",
          facts,
        );
      }
      current.release = true;
    }
  }

  #assertPayloadManifestComplete(
    current: {
      readonly payloadChunks?: Map<CompactionPayloadKind, {
        readonly payloadSha256: string;
        readonly chunkCount: number;
        readonly previousChunkSha256: string;
        readonly fragmentUtf8Bytes: number;
        readonly complete: boolean;
      }>;
    },
    value: unknown,
    facts: RecoveryIntegrityFacts,
  ): void {
    if (!isPlainRecord(value) ||
        typeof value.payload_kind !== "string") {
      this.#fail(
        "schema_invalid",
        "compaction payload manifest is missing",
        facts,
      );
    }
    const kind = value.payload_kind as CompactionPayloadKind;
    const chunks = current.payloadChunks?.get(kind);
    if (
      chunks === undefined ||
      !chunks.complete ||
      chunks.payloadSha256 !== value.payload_sha256 ||
      chunks.chunkCount !== value.chunk_count ||
      chunks.previousChunkSha256 !== value.final_chunk_sha256 ||
      chunks.fragmentUtf8Bytes !== value.canonical_utf8_bytes
    ) {
      this.#fail(
        "identity_conflict",
        `compaction ${kind} manifest has a missing or mismatched chunk chain`,
        facts,
      );
    }
  }

  #rejectUnsupportedEventType(
    payload: Record<string, unknown>,
    facts: RecoveryIntegrityFacts,
  ): void {
    if (
      !isPlainRecord(payload.msg) ||
      typeof payload.msg.type !== "string" ||
      payload.msg.type.length === 0
    ) {
      return;
    }
    if (
      !isKnownEventType(payload.msg.type) &&
      !LEGACY_EVENT_TYPE_ALIASES.has(payload.msg.type)
    ) {
      this.#fail(
        "unsupported_format_version",
        "canonical event message type is not supported by this runtime",
        facts,
      );
    }
  }

  #validateSessionMeta(
    payload: Record<string, unknown>,
    facts: RecoveryIntegrityFacts,
  ): void {
    for (const key of [
      "sessionId",
      "timestamp",
      "cwd",
      "originator",
      "agencVersion",
    ] as const) {
      if (typeof payload[key] !== "string" || payload[key].length === 0) {
        this.#fail(
          "schema_invalid",
          `canonical session metadata has an invalid ${key}`,
          facts,
        );
      }
    }
    if (
      !Number.isSafeInteger(payload.rolloutSchemaVersion) ||
      (payload.rolloutSchemaVersion as number) < 2 ||
      (payload.rolloutSchemaVersion as number) > ROLLOUT_SCHEMA_VERSION
    ) {
      this.#fail(
        "unsupported_format_version",
        "canonical rollout schema version is not supported by this runtime",
        facts,
      );
    }
  }

  #validateEvent(
    payload: Record<string, unknown>,
    facts: RecoveryIntegrityFacts,
  ): void {
    this.#eventCount += 1;
    if (this.#eventCount > this.#maxEvents) {
      this.#fail(
        "event_limit",
        "canonical journal exceeds its event ceiling",
        facts,
      );
    }
    if (typeof payload.id !== "string" || payload.id.length === 0) {
      this.#fail(
        "schema_invalid",
        "canonical event has an invalid envelope id",
        facts,
      );
    }
    if (
      !isPlainRecord(payload.msg) ||
      typeof payload.msg.type !== "string" ||
      payload.msg.type.length === 0
    ) {
      this.#fail(
        "schema_invalid",
        "canonical event has an invalid message envelope",
        facts,
      );
    }
    if (!isCanonicalEventPayload(payload.msg.type, payload.msg.payload)) {
      this.#fail(
        "schema_invalid",
        `canonical ${payload.msg.type} event payload does not match the runtime schema`,
        facts,
      );
    }
    const sequence = payload.seq;
    if (sequence === undefined) {
      if (payload.eventId !== undefined) {
        this.#fail(
          "legacy_format_violation",
          "legacy event cannot carry a canonical event id without a sequence",
          facts,
        );
      }
      if (this.#format === "sequenced_v1") {
        this.#fail(
          "legacy_format_violation",
          "canonical journal mixes sequenced and legacy events",
          facts,
        );
      }
      this.#format = "legacy_unsequenced_v1";
    } else {
      if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0) {
        this.#fail(
          "schema_invalid",
          "canonical event sequence must be a positive safe integer",
          facts,
        );
      }
      if (typeof payload.eventId !== "string" || payload.eventId.length === 0) {
        this.#fail(
          "schema_invalid",
          "sequenced canonical event is missing its event id",
          facts,
        );
      }
      if (this.#format === "legacy_unsequenced_v1") {
        this.#fail(
          "legacy_format_violation",
          "canonical journal mixes legacy and sequenced events",
          facts,
        );
      }
      this.#format = "sequenced_v1";
      this.#validateSequence(
        sequence as number,
        payload.eventId as string,
        facts,
      );
    }
    if (payload.msg.type === "run_terminal") {
      this.#validateTerminal(payload.msg.payload, facts);
    }
  }

  #validateSequence(
    sequence: number,
    eventId: string,
    facts: RecoveryIntegrityFacts,
  ): void {
    const sequenceFacts = {
      ...facts,
      expectedSequence: this.#nextSequence,
      observedSequence: sequence,
    };
    if (sequence < this.#nextSequence) {
      this.#fail(
        sequence === this.#nextSequence - 1
          ? "sequence_duplicate"
          : "sequence_rewind",
        sequence === this.#nextSequence - 1
          ? "canonical journal repeats its preceding event sequence"
          : "canonical journal event sequence rewinds behind its preceding event",
        sequenceFacts,
      );
    }
    if (sequence > this.#nextSequence) {
      this.#fail(
        "sequence_gap",
        "canonical journal event sequence is not contiguous",
        sequenceFacts,
      );
    }
    const reserved = /^event:([1-9]\d*)$/u.exec(eventId)?.[1];
    if (reserved !== undefined && Number(reserved) !== sequence) {
      this.#fail(
        "identity_conflict",
        "canonical event id conflicts with its sequence",
        sequenceFacts,
      );
    }
    if (
      (reserved === undefined || this.#options.identityRegistry !== undefined) &&
      this.#options.identityPolicy !== "trusted_replay" &&
      !this.#claimEventId(eventId)
    ) {
      this.#fail(
        "identity_conflict",
        "canonical journal reuses an event id",
        sequenceFacts,
      );
    }
    this.#nextSequence = sequence + 1;
  }

  #validateTerminal(payload: unknown, facts: RecoveryIntegrityFacts): void {
    if (!isPlainRecord(payload)) {
      this.#fail(
        "schema_invalid",
        "run terminal payload must be an object",
        facts,
      );
    }
    if (
      typeof payload.runId !== "string" ||
      payload.runId.length === 0 ||
      !Number.isSafeInteger(payload.epoch) ||
      (payload.epoch as number) <= 0
    ) {
      this.#fail("schema_invalid", "run terminal binding is invalid", facts);
    }
    if (
      this.#options.expectedRunId !== undefined &&
      payload.runId !== this.#options.expectedRunId
    ) {
      this.#fail(
        "terminal_binding_mismatch",
        "run terminal belongs to another run",
        facts,
      );
    }
    if (
      this.#options.expectedEpoch !== undefined &&
      payload.epoch !== this.#options.expectedEpoch
    ) {
      this.#fail(
        "terminal_binding_mismatch",
        "run terminal belongs to another epoch",
        facts,
      );
    }
    const key = `${payload.runId}\u0000${String(payload.epoch)}`;
    if (
      this.#options.identityPolicy !== "trusted_replay" &&
      !this.#claimTerminalKey(key)
    ) {
      this.#fail(
        "duplicate_terminal",
        "canonical journal contains duplicate run terminals",
        facts,
      );
    }
    this.#terminalCount += 1;
    this.#matchingTerminalCount += 1;
  }

  #fail(
    reasonCode: RecoveryIntegrityReasonCode,
    message: string,
    facts: RecoveryIntegrityFacts = {},
  ): never {
    throw new CanonicalJournalIntegrityError(reasonCode, message, facts);
  }

  #claimEventId(eventId: string): boolean {
    if (this.#options.identityRegistry !== undefined) {
      return this.#options.identityRegistry.claimEventId(eventId);
    }
    if (this.#eventIds.has(eventId)) return false;
    this.#eventIds.add(eventId);
    return true;
  }

  #claimTerminalKey(terminalKey: string): boolean {
    if (this.#options.identityRegistry !== undefined) {
      return this.#options.identityRegistry.claimTerminalKey(terminalKey);
    }
    if (this.#terminalKeys.has(terminalKey)) return false;
    this.#terminalKeys.add(terminalKey);
    return true;
  }
}

export function validateCanonicalJournalBytes(
  bytes: Uint8Array,
  options: StrictCanonicalJournalOptions = {},
): StrictCanonicalJournal {
  const validator = new StrictCanonicalJournalValidator(options);
  validator.push(bytes);
  return validator.finish();
}

export function validateCanonicalJournalText(
  text: string,
  options: StrictCanonicalJournalOptions = {},
): StrictCanonicalJournal {
  return validateCanonicalJournalBytes(Buffer.from(text, "utf8"), options);
}

function decodeCanonicalUtf8(
  bytes: Uint8Array,
  lineNumber: number,
  byteOffset: number,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalJournalIntegrityError(
      "malformed_json",
      "canonical journal record is not valid UTF-8",
      {
        lineNumber,
        byteOffset,
      },
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedItemVersion(type: string, version: unknown): boolean {
  if (COMPACTION_CANONICAL_TYPES.has(type)) {
    return version === ROLLOUT_ITEM_VERSION;
  }
  if (version === undefined) return true;
  return (
    Number.isSafeInteger(version) &&
    (version as number) >= 1 &&
    (version as number) <= ROLLOUT_ITEM_VERSION
  );
}

function boundedCeiling(
  requested: number | undefined,
  maximum: number,
  label: string,
  minimum = 1,
): number {
  const value = requested ?? maximum;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const lowerBound = minimum === 0 ? "a non-negative" : "a positive";
    throw new TypeError(
      `${label} must be ${lowerBound} integer no greater than ${maximum}`,
    );
  }
  return value;
}

/** JSON is parsed first; this bounded walk exists solely to reject duplicate keys. */
function assertNoDuplicateJsonObjectKeys(input: string): void {
  const parser = new DuplicateKeyScanner(input);
  parser.scan();
}

class DuplicateKeyScanner {
  #offset = 0;

  constructor(private readonly input: string) {}

  scan(): void {
    this.#skipWhitespace();
    this.#value(0);
    this.#skipWhitespace();
    if (this.#offset !== this.input.length)
      throw new Error("canonical JSON has trailing content");
  }

  #value(depth: number): void {
    if (depth > MAX_CANONICAL_JSON_DEPTH)
      throw new Error("canonical JSON nesting exceeds its limit");
    const token = this.input[this.#offset];
    if (token === "{") return this.#object(depth + 1);
    if (token === "[") return this.#array(depth + 1);
    if (token === '"') {
      this.#string();
      return;
    }
    while (
      this.#offset < this.input.length &&
      !/[\s,}\]]/u.test(this.input[this.#offset]!)
    ) {
      this.#offset += 1;
    }
  }

  #object(depth: number): void {
    this.#offset += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.input[this.#offset] === "}") {
      this.#offset += 1;
      return;
    }
    while (this.#offset < this.input.length) {
      const key = this.#string();
      if (keys.has(key))
        throw new Error(
          `canonical JSON object contains duplicate key ${JSON.stringify(key)}`,
        );
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      this.#value(depth);
      this.#skipWhitespace();
      if (this.input[this.#offset] === "}") {
        this.#offset += 1;
        return;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #array(depth: number): void {
    this.#offset += 1;
    this.#skipWhitespace();
    if (this.input[this.#offset] === "]") {
      this.#offset += 1;
      return;
    }
    while (this.#offset < this.input.length) {
      this.#value(depth);
      this.#skipWhitespace();
      if (this.input[this.#offset] === "]") {
        this.#offset += 1;
        return;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#expect('"');
    while (this.#offset < this.input.length) {
      const token = this.input[this.#offset++]!;
      if (token === "\\") {
        this.#offset += 1;
        continue;
      }
      if (token === '"')
        return JSON.parse(this.input.slice(start, this.#offset)) as string;
    }
    throw new Error("canonical JSON contains an unterminated string");
  }

  #expect(token: string): void {
    if (this.input[this.#offset] !== token)
      throw new Error(`canonical JSON expected ${token}`);
    this.#offset += 1;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.input[this.#offset] ?? "")) this.#offset += 1;
  }
}
