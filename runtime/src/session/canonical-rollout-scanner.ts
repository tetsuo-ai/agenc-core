import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import {
  COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
  MAX_COMPACTION_PIN_HISTORY_TOTAL,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  type CompactionActiveHistoryEntryV1,
  type CompactionCommittedV1,
  type CompactionIntentV1,
  type CompactionPayloadChunkV1,
  type CompactionPayloadManifestV1,
  type CompactionPersistedCommittedV1,
  type CompactionPersistedIntentV1,
  type CompactionPersistedRollbackCommittedV1,
  type CompactionRollbackCommittedV1,
} from "../services/compact/transaction-types.js";
import { digestWithDomain } from "../services/compact/summary-v1.js";
import { DiskCanonicalIdentityRegistry } from "../state/recovery-file.js";
import {
  StrictCanonicalJournalValidator,
  type StrictCanonicalJournal,
  type StrictCanonicalJournalOptions,
  type StrictCanonicalJournalRecord,
} from "../state/recovery-journal-contract.js";
import {
  MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
  RECOVERY_SCAN_CHUNK_BYTES,
  RecoveryOperationalError,
} from "../state/recovery-contract.js";
import type { RolloutItem } from "./rollout-item.js";
import type { ResponseItem } from "./rollout-item.js";
import {
  emptyReducedState,
  reduce,
  type ReducedSessionState,
} from "./event-log-reducer.js";
import {
  hydrateActiveHistoryRefs,
  reconstructCompactionPayloadV1,
} from "../services/compact/payload-manifest.js";
import {
  readCompactionPersistedCommittedV1,
  readCompactionPersistedIntentV1,
  readCompactionPersistedRollbackCommittedV1,
  readCompactionRolloutPayload,
} from "./compaction-event-reader.js";

const MAX_COMPACTION_LIFECYCLE_RECORDS = MAX_COMPACTION_PIN_HISTORY_TOTAL * 6;
const COMPACTION_PAYLOAD_REGISTRY_CACHE_KIB = 1_024;

/** Disk-backed payload spool keeps manifest replay bounded by one payload. */
class DiskCompactionPayloadRegistry {
  readonly #directory: string;
  readonly #database: BetterSqlite3.Database;
  readonly #insert: BetterSqlite3.Statement<[string, string, number, string]>;
  readonly #select: BetterSqlite3.Statement<[string, string]>;
  readonly #count: BetterSqlite3.Statement<[string, string]>;
  #closed = false;

  constructor(temporaryRoot: string) {
    const directory = mkdtempSync(join(temporaryRoot, "agenc-c2-payloads-"));
    let database: BetterSqlite3.Database | undefined;
    try {
      database = new Database(join(directory, "payloads.sqlite"));
      database.pragma("journal_mode = OFF");
      database.pragma("synchronous = OFF");
      database.pragma(
        `cache_size = -${COMPACTION_PAYLOAD_REGISTRY_CACHE_KIB}`,
      );
      database.exec(
        `CREATE TABLE payload_chunks (
           attempt_id TEXT NOT NULL,
           payload_kind TEXT NOT NULL,
           chunk_index INTEGER NOT NULL,
           payload_json TEXT NOT NULL,
           PRIMARY KEY (attempt_id, payload_kind, chunk_index)
         ) WITHOUT ROWID;
         BEGIN`,
      );
      const insert = database.prepare<[string, string, number, string]>(
        `INSERT INTO payload_chunks
           (attempt_id, payload_kind, chunk_index, payload_json)
         VALUES (?, ?, ?, ?)`,
      );
      const select = database.prepare<[string, string]>(
        `SELECT payload_json
           FROM payload_chunks
          WHERE attempt_id = ? AND payload_kind = ?
          ORDER BY chunk_index`,
      );
      const count = database.prepare<[string, string]>(
        `SELECT COUNT(*) AS chunk_count
           FROM payload_chunks
          WHERE attempt_id = ? AND payload_kind = ?`,
      );
      this.#directory = directory;
      this.#database = database;
      this.#insert = insert;
      this.#select = select;
      this.#count = count;
    } catch (initializationError) {
      const cleanupFailures: unknown[] = [];
      if (database !== undefined) {
        try {
          database.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [initializationError, ...cleanupFailures],
          "compaction payload registry initialization cleanup failed",
        );
      }
      throw initializationError;
    }
  }

  add(chunk: CompactionPayloadChunkV1): void {
    this.#assertOpen();
    this.#insert.run(
      chunk.attempt_id,
      chunk.payload_kind,
      chunk.chunk_index,
      JSON.stringify(chunk),
    );
  }

  reconstruct(manifest: CompactionPayloadManifestV1): unknown {
    this.#assertOpen();
    const chunks = this.#select
      .all(manifest.attempt_id, manifest.payload_kind)
      .map((row) => {
        const payloadJson = (row as { readonly payload_json: string })
          .payload_json;
        const payload = JSON.parse(payloadJson) as unknown;
        const parsed = readCompactionRolloutPayload(
          "compaction_payload_chunk",
          payload,
        );
        if (!("payload_kind" in parsed)) {
          throw new Error("payload registry row did not decode as a chunk");
        }
        return parsed;
      });
    return reconstructCompactionPayloadV1(manifest, chunks);
  }

  hasComplete(manifest: CompactionPayloadManifestV1): boolean {
    this.#assertOpen();
    const row = this.#count.get(manifest.attempt_id, manifest.payload_kind) as {
      readonly chunk_count: number;
    };
    return row.chunk_count === manifest.chunk_count;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.exec("COMMIT");
    } finally {
      try {
        this.#database.close();
      } finally {
        rmSync(this.#directory, { recursive: true, force: true });
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("compaction payload registry is closed");
  }
}

interface MutableAdmissionState {
  queued: boolean;
  allowed: boolean;
  dispatched: boolean;
  reconciled: boolean;
  heldUnknown: boolean;
  reservationId?: string;
}

interface MutableAttemptScan {
  intent?: CompactionIntentV1;
  persistedIntent?: CompactionPersistedIntentV1;
  intentRecord?: StrictCanonicalJournalRecord;
  sourceHistoryManifest?: CompactionPayloadManifestV1;
  sourceHistoryValidated?: boolean;
  commitSha256?: string;
  readonly records: StrictCanonicalJournalRecord[];
  readonly calls: Map<number, MutableAdmissionState>;
  readonly eventIds: Set<string>;
  readonly reservationIds: Set<string>;
  latestCall: number;
  latestAdmissionSequence: number;
  admissionRunId?: string;
  contaminated: boolean;
  terminal: boolean;
  laterWork: boolean;
}

export interface CanonicalCompactionAttemptScan {
  readonly intent: CompactionIntentV1;
  readonly records: readonly StrictCanonicalJournalRecord[];
  readonly admissionValid: boolean;
  readonly hasLaterCanonicalWork: boolean;
  readonly sourceHistoryManifest?: CompactionPayloadManifestV1;
  readonly sourceHistoryRetained: boolean;
}

export interface CanonicalRolloutSourceRecord {
  readonly lineNumber: number;
  readonly encodedByteLength: number;
  readonly itemType: RolloutItem["type"];
  readonly compactionSourceSha256: string;
  readonly committedAttemptId?: string;
}

export interface CanonicalRolloutPayloadRecord {
  readonly lineNumber: number;
  readonly encodedByteLength: number;
  readonly payloadKind: CompactionPayloadChunkV1["payload_kind"];
  readonly compactionSourceSha256: string;
}

export interface CanonicalActiveHistoryPosition {
  readonly lineNumber: number;
  readonly recordMessageIndex: number;
}

export interface CanonicalActiveHistoryScan {
  readonly messages: readonly ResponseItem[];
  readonly positions: readonly CanonicalActiveHistoryPosition[];
}

export interface CanonicalRolloutScan {
  readonly proof: Omit<StrictCanonicalJournal, "records">;
  readonly attempts: ReadonlyMap<string, CanonicalCompactionAttemptScan>;
  readonly sourceRecords: ReadonlyMap<number, CanonicalRolloutSourceRecord>;
  readonly payloadRecordsAtAttempts: ReadonlyMap<
    string,
    readonly CanonicalRolloutPayloadRecord[]
  >;
  readonly activeHistory?: CanonicalActiveHistoryScan;
  readonly historyAtAttempts: ReadonlyMap<string, readonly ResponseItem[]>;
}

export interface CanonicalRolloutScanOptions extends Pick<
  StrictCanonicalJournalOptions,
  "expectedRunId" | "expectedEpoch" | "terminalPolicy"
> {
  /** Captured owner for every disk-backed registry created by this scan. */
  readonly sessionTempRoot: string;
  readonly nowMilliseconds?: () => number;
  readonly maximumScanMilliseconds: number;
  readonly additionalSourceLines?: readonly number[];
  readonly compactionSourceDigestDomain: string;
  readonly captureActiveHistory?: boolean;
  readonly captureHistoryAtAttemptIds?: readonly string[];
  readonly capturePayloadRecordsAtAttemptIds?: readonly string[];
}

/**
 * Scan a live rollout without retaining ordinary canonical rows. The first
 * pass validates identities with a disk-backed registry and retains only the
 * bounded compaction lifecycle. A digest-anchored second pass selects the
 * exact source rows named by those lifecycles and existing retention pins.
 */
export function scanCanonicalRollout(
  rolloutPath: string,
  options: CanonicalRolloutScanOptions,
): CanonicalRolloutScan {
  const nowMilliseconds = options.nowMilliseconds ?? Date.now;
  const startedAt = nowMilliseconds();
  const checkOperationalBudget = (): void => {
    if (nowMilliseconds() - startedAt >= options.maximumScanMilliseconds) {
      throw new RecoveryOperationalError(
        "startup_time_budget",
        "canonical compaction reconciliation exceeded its scan deadline",
      );
    }
  };
  checkOperationalBudget();
  const fd = openSync(rolloutPath, fsConstants.O_RDONLY);
  try {
    const snapshot = fstatSync(fd, { bigint: true });
    if (!snapshot.isFile()) {
      throw new Error("canonical rollout source is not a regular file");
    }
    checkOperationalBudget();
    const attempts = new Map<string, MutableAttemptScan>();
    const capturedAttemptIds = new Set(
      options.captureHistoryAtAttemptIds ?? [],
    );
    const capturedPayloadAttemptIds = new Set(
      options.capturePayloadRecordsAtAttemptIds ?? [],
    );
    const payloadLineAttempts = new Map<number, string>();
    const trackHistory =
      options.captureActiveHistory === true || capturedAttemptIds.size > 0;
    let reducedState = emptyReducedState();
    let activePositions: CanonicalActiveHistoryPosition[] = [];
    const activeLineBytes = new Map<number, number>();
    let activeSourceBytes = 0;
    const historyAtAttempts = new Map<string, readonly ResponseItem[]>();
    let retainedLifecycleRecords = 0;
    let activeAdmissionAttempt: MutableAttemptScan | undefined;
    let latestCommittedAttempt: MutableAttemptScan | undefined;
    let postCommitBookkeeping:
      "await_context" | "await_meta" | "complete" | undefined;
    checkOperationalBudget();
    let identityRegistry: DiskCanonicalIdentityRegistry | undefined;
    let payloadRegistry: DiskCompactionPayloadRegistry | undefined;
    let first: StrictCanonicalJournal;
    try {
      identityRegistry = new DiskCanonicalIdentityRegistry(
        options.sessionTempRoot,
      );
      payloadRegistry = new DiskCompactionPayloadRegistry(
        options.sessionTempRoot,
      );
      const activeIdentityRegistry = identityRegistry;
      const activePayloadRegistry = payloadRegistry;
      first = scanPass(fd, snapshot.size, {
        ...strictOptions(options, checkOperationalBudget),
        retainRecords: false,
        identityRegistry: activeIdentityRegistry,
        onRecord: (physicalRecord) => {
          let record = physicalRecord;
          let item = record.item;
          const persistedIntent = persistedIntentPayload(item);
          const attemptId =
            item.type.startsWith("compaction_") && "attempt_id" in item.payload
              ? item.payload.attempt_id
              : undefined;

          if (latestCommittedAttempt !== undefined) {
            const committedAttemptId =
              latestCommittedAttempt.intent?.attempt_id;
            if (
              item.type === "compaction_cleanup_pending" &&
              item.payload.attempt_id === committedAttemptId
            ) {
              // Cleanup evidence is part of the commit transaction itself.
            } else if (
              postCommitBookkeeping === "await_context" &&
              latestCommittedAttempt.intent?.automatic === true &&
              isCausalAutoCompactionBoundary(item)
            ) {
              postCommitBookkeeping = "await_meta";
            } else if (
              postCommitBookkeeping === "await_meta" &&
              item.type === "session_meta" &&
              item.payload.sessionId === options.expectedRunId
            ) {
              postCommitBookkeeping = "complete";
            } else {
              latestCommittedAttempt.laterWork = true;
              latestCommittedAttempt = undefined;
              postCommitBookkeeping = undefined;
            }
          }
          if (
            trackHistory &&
            item.type === "compaction_intent" &&
            attemptId !== undefined &&
            capturedAttemptIds.has(attemptId)
          ) {
            checkOperationalBudget();
            historyAtAttempts.set(
              attemptId,
              Object.freeze(reducedState.history.slice()),
            );
          }

          if (item.type === "compaction_payload_chunk") {
            if (activeAdmissionAttempt !== undefined) {
              observeAdmission(record, activeAdmissionAttempt);
            }
            activePayloadRegistry.add(item.payload);
            if (
              item.payload.payload_kind === "source_history" &&
              capturedPayloadAttemptIds.has(item.payload.attempt_id)
            ) {
              payloadLineAttempts.set(
                record.lineNumber,
                item.payload.attempt_id,
              );
            }
            retainedLifecycleRecords += 1;
            if (retainedLifecycleRecords > MAX_COMPACTION_LIFECYCLE_RECORDS) {
              throw new RecoveryOperationalError(
                "recovery_history_storage_limit",
                "canonical compaction lifecycle exceeds its bounded retention budget",
              );
            }
            const pending = attempts.get(item.payload.attempt_id);
            const pendingIntent = pending?.persistedIntent;
            if (
              pending !== undefined &&
              pendingIntent !== undefined &&
              activePayloadRegistry.hasComplete(
                pendingIntent.source.active_history_refs_manifest,
              ) &&
              pending.intent === undefined
            ) {
              const hydrated = hydratePersistedIntentRecord(
                pending.intentRecord!,
                pendingIntent,
                activePayloadRegistry,
              );
              pending.intent = hydrated.intent;
              pending.records.push(hydrated.record);
              pending.sourceHistoryManifest =
                pendingIntent.source_history_manifest;
              activeAdmissionAttempt = pending;
            }
            if (
              pending !== undefined &&
              pendingIntent !== undefined &&
              item.payload.payload_kind === "source_history" &&
              activePayloadRegistry.hasComplete(
                pendingIntent.source_history_manifest,
              )
            ) {
              validatePersistedSourceHistory(
                pendingIntent,
                activePayloadRegistry,
              );
              pending.sourceHistoryValidated = true;
            }
            return;
          }

          if (persistedIntent !== undefined) {
            attempts.set(persistedIntent.attempt_id, {
              persistedIntent,
              intentRecord: record,
              sourceHistoryManifest: persistedIntent.source_history_manifest,
              records: [],
              calls: new Map(),
              eventIds: new Set(),
              reservationIds: new Set(),
              latestCall: 0,
              latestAdmissionSequence: 0,
              contaminated: false,
              terminal: false,
              laterWork: false,
            });
            retainedLifecycleRecords += 1;
            if (retainedLifecycleRecords > MAX_COMPACTION_LIFECYCLE_RECORDS) {
              throw new RecoveryOperationalError(
                "recovery_history_storage_limit",
                "canonical compaction lifecycle exceeds its bounded retention budget",
              );
            }
            return;
          }

          const incompleteAttempt = [...attempts.values()].find(
            (attempt) =>
              attempt.persistedIntent !== undefined &&
              attempt.intent === undefined &&
              !attempt.terminal,
          );
          if (incompleteAttempt !== undefined) {
            throw new Error(
              "canonical compaction intent is missing its required source payload bundle",
            );
          }

          const persistedCommit = persistedCommitPayload(item);
          if (persistedCommit !== undefined) {
            const attempt = attempts.get(persistedCommit.attempt_id);
            if (attempt?.intent === undefined) {
              throw new Error(
                "persisted compaction commit has no hydrated intent",
              );
            }
            record = hydratePersistedCommitRecord(
              record,
              persistedCommit,
              attempt.intent,
              activePayloadRegistry,
            );
            item = record.item;
            if (
              item.type !== "compaction_committed" ||
              item.payload.summary_dag.planned_provider_calls !==
                attempt.intent.planned_provider_calls
            ) {
              throw new Error(
                "canonical compaction commit provider-call plan conflicts with its intent",
              );
            }
          }
          const persistedRollback = persistedRollbackPayload(item);
          if (persistedRollback !== undefined) {
            if (
              activePayloadRegistry.hasComplete(
                persistedRollback.source_history_manifest,
              )
            ) {
              record = hydratePersistedRollbackRecord(
                record,
                persistedRollback,
                activePayloadRegistry,
              );
              item = record.item;
            }
          }
          if (activeAdmissionAttempt !== undefined) {
            observeAdmission(record, activeAdmissionAttempt);
          }
          if (trackHistory) {
            checkOperationalBudget();
            const next = reduceStreamingHistory(reducedState, item);
            if (item.type === "response_item") {
              activePositions.push({
                lineNumber: record.lineNumber,
                recordMessageIndex: 0,
              });
              if (!activeLineBytes.has(record.lineNumber)) {
                activeLineBytes.set(
                  record.lineNumber,
                  record.encodedByteLength + 1,
                );
                activeSourceBytes += record.encodedByteLength + 1;
              }
            } else if (
              (item.type === "compacted" &&
                item.payload.replacementHistory !== undefined) ||
              item.type === "compaction_committed" ||
              (item.type === "compaction_rollback_committed" &&
                Array.isArray(item.payload.source_history) &&
                item.payload.target_session_id === options.expectedRunId)
            ) {
              checkOperationalBudget();
              activePositions = next.history.map((_, recordMessageIndex) => ({
                lineNumber: record.lineNumber,
                recordMessageIndex,
              }));
              activeLineBytes.clear();
              activeLineBytes.set(
                record.lineNumber,
                record.encodedByteLength + 1,
              );
              activeSourceBytes = record.encodedByteLength + 1;
            } else if (next.history.length < activePositions.length) {
              activePositions = activePositions.slice(0, next.history.length);
              const retainedLines = new Set(
                activePositions.map((position) => position.lineNumber),
              );
              for (const lineNumber of activeLineBytes.keys()) {
                if (!retainedLines.has(lineNumber))
                  activeLineBytes.delete(lineNumber);
              }
              activeSourceBytes = [...activeLineBytes.values()].reduce(
                (total, bytes) => total + bytes,
                0,
              );
            }
            reducedState = next;
            if (
              reducedState.history.length > MAX_COMPACTION_SOURCE_MESSAGES ||
              activeSourceBytes > MAX_COMPACTION_SOURCE_BYTES
            ) {
              throw new RecoveryOperationalError(
                "recovery_history_storage_limit",
                "canonical active history exceeds its bounded compaction scan budget",
              );
            }
          }
          if (
            !item.type.startsWith("compaction_") ||
            !("attempt_id" in item.payload)
          )
            return;
          retainedLifecycleRecords += 1;
          if (retainedLifecycleRecords > MAX_COMPACTION_LIFECYCLE_RECORDS) {
            throw new RecoveryOperationalError(
              "recovery_history_storage_limit",
              "canonical compaction lifecycle exceeds its bounded retention budget",
            );
          }
          const lifecycleAttemptId = item.payload.attempt_id;
          if (item.type === "compaction_intent") {
            attempts.set(lifecycleAttemptId, {
              intent: item.payload,
              records: [record],
              calls: new Map(),
              eventIds: new Set(),
              reservationIds: new Set(),
              latestCall: 0,
              latestAdmissionSequence: 0,
              contaminated: false,
              terminal: false,
              laterWork: false,
            });
            activeAdmissionAttempt = attempts.get(lifecycleAttemptId);
            return;
          }
          const attempt = attempts.get(lifecycleAttemptId);
          if (attempt === undefined) return;
          if (
            attempt.commitSha256 !== undefined &&
            "commit_sha256" in item.payload &&
            item.payload.commit_sha256 !== attempt.commitSha256
          ) {
            throw new Error(
              "canonical compaction post-commit event is not bound to its hydrated commit",
            );
          }
          attempt.records.push(record);
          if (
            item.type === "compaction_committed" ||
            item.type === "compaction_failed"
          ) {
            attempt.terminal = true;
            if (item.type === "compaction_committed") {
              attempt.commitSha256 = digestWithDomain(
                COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
                item.payload,
              );
              latestCommittedAttempt = attempt;
              postCommitBookkeeping = "await_context";
            }
            if (activeAdmissionAttempt === attempt) {
              activeAdmissionAttempt = undefined;
            }
          }
        },
      });
    } finally {
      try {
        identityRegistry?.close();
      } finally {
        payloadRegistry?.close();
      }
    }

    if (
      latestCommittedAttempt !== undefined &&
      postCommitBookkeeping === "await_meta"
    ) {
      latestCommittedAttempt.laterWork = true;
    }
    for (const attempt of attempts.values()) {
      if (attempt.intent === undefined) {
        throw new Error(
          "canonical compaction intent did not reconstruct its source manifests",
        );
      }
      if (
        attempt.persistedIntent !== undefined &&
        attempt.sourceHistoryValidated !== true &&
        !attempt.records.some(
          (record) => record.item.type === "compaction_source_release",
        )
      ) {
        throw new Error(
          "canonical compaction source history is missing without a durable release",
        );
      }
    }

    checkOperationalBudget();
    const sourceLines = new Set(options.additionalSourceLines ?? []);
    for (const attempt of attempts.values()) {
      for (const ref of attempt.intent!.source.active_history_refs) {
        sourceLines.add(ref.first_sequence);
      }
    }
    if (options.captureActiveHistory === true) {
      for (const position of activePositions) {
        sourceLines.add(position.lineNumber);
      }
    }
    const sourceRecords = new Map<number, CanonicalRolloutSourceRecord>();
    const payloadRecordsAtAttempts = new Map<
      string,
      CanonicalRolloutPayloadRecord[]
    >();
    for (const attemptId of capturedPayloadAttemptIds) {
      payloadRecordsAtAttempts.set(attemptId, []);
    }
    const second = scanPass(fd, snapshot.size, {
      ...strictOptions(options, checkOperationalBudget),
      trustedSourceSha256: first.sourceSha256,
      retainRecords: false,
      identityPolicy: "trusted_replay",
      onRecord: (record) => {
        const payloadAttemptId = payloadLineAttempts.get(record.lineNumber);
        if (
          !sourceLines.has(record.lineNumber) &&
          payloadAttemptId === undefined
        )
          return;
        checkOperationalBudget();
        const physical = readPhysicalRecord(fd, record);
        const item = record.item;
        const physicalSha256 = createHash("sha256")
          .update(options.compactionSourceDigestDomain, "utf8")
          .update(physical)
          .digest("hex");
        if (sourceLines.has(record.lineNumber)) {
          sourceRecords.set(record.lineNumber, {
            lineNumber: record.lineNumber,
            encodedByteLength: physical.byteLength,
            itemType: item.type,
            compactionSourceSha256: physicalSha256,
            ...(item.type === "compaction_committed"
              ? { committedAttemptId: item.payload.attempt_id }
              : {}),
          });
        }
        if (payloadAttemptId !== undefined) {
          if (
            item.type !== "compaction_payload_chunk" ||
            item.payload.attempt_id !== payloadAttemptId ||
            item.payload.payload_kind !== "source_history"
          ) {
            throw new Error(
              "captured compaction source-history row changed during canonical scan",
            );
          }
          const records = payloadRecordsAtAttempts.get(payloadAttemptId) ?? [];
          records.push({
            lineNumber: record.lineNumber,
            encodedByteLength: physical.byteLength,
            payloadKind: item.payload.payload_kind,
            compactionSourceSha256: physicalSha256,
          });
          payloadRecordsAtAttempts.set(payloadAttemptId, records);
        }
      },
    });
    assertMatchingProof(first, second);
    assertPinnedSnapshot(fd, snapshot);
    checkOperationalBudget();
    return {
      proof: withoutRecords(first),
      attempts: new Map(
        [...attempts].map(([attemptId, attempt]) => [
          attemptId,
          {
            intent: attempt.intent!,
            records: Object.freeze(attempt.records.slice()),
            admissionValid: validAdmission(attempt),
            hasLaterCanonicalWork: attempt.laterWork,
            sourceHistoryRetained: attempt.sourceHistoryValidated === true,
            ...(attempt.sourceHistoryManifest !== undefined
              ? { sourceHistoryManifest: attempt.sourceHistoryManifest }
              : {}),
          },
        ]),
      ),
      sourceRecords,
      payloadRecordsAtAttempts: new Map(
        [...payloadRecordsAtAttempts].map(([attemptId, records]) => [
          attemptId,
          Object.freeze(records.slice()),
        ]),
      ),
      ...(options.captureActiveHistory === true
        ? {
            activeHistory: {
              messages: Object.freeze(reducedState.history.slice()),
              positions: Object.freeze(activePositions.slice()),
            },
          }
        : {}),
      historyAtAttempts,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Preserve the shared replay semantics while avoiding the reducer's immutable
 * O(n) history copy for every ordinary response row. This scanner exclusively
 * owns the state, so appending that one row in place makes a large uncompacted
 * history linear without changing any externally observable reducer value.
 */
function reduceStreamingHistory(
  state: ReducedSessionState,
  item: RolloutItem,
): ReducedSessionState {
  if (item.type === "response_item") {
    state.history.push(item.payload);
    return state;
  }
  return reduce(state, item).state;
}

function hydratePersistedIntentRecord(
  record: StrictCanonicalJournalRecord,
  persisted: CompactionPersistedIntentV1,
  payloadRegistry: DiskCompactionPayloadRegistry,
): {
  readonly record: StrictCanonicalJournalRecord;
  readonly intent: CompactionIntentV1;
} {
  const activeEntries = payloadRegistry.reconstruct(
    persisted.source.active_history_refs_manifest,
  );
  if (!Array.isArray(activeEntries)) {
    throw new Error(
      "active-history payload manifest did not reconstruct an array",
    );
  }
  const { active_history_refs_manifest: _manifest, ...sourceBase } =
    persisted.source;
  const activeHistoryRefs = hydrateActiveHistoryRefs(
    sourceBase,
    activeEntries as readonly CompactionActiveHistoryEntryV1[],
  );
  const hydrated = readCompactionRolloutPayload("compaction_intent", {
    format_version: persisted.format_version,
    minimum_reader_runtime: persisted.minimum_reader_runtime,
    attempt_id: persisted.attempt_id,
    recorded_at_ms: persisted.recorded_at_ms,
    source: { ...sourceBase, active_history_refs: activeHistoryRefs },
    policy_digest: persisted.policy_digest,
    configuration_digest: persisted.configuration_digest,
    accounting_ref: persisted.accounting_ref,
    automatic: persisted.automatic,
    selected_history_indexes: persisted.selected_history_indexes,
    admission_required: persisted.admission_required,
    planned_provider_calls: persisted.planned_provider_calls,
  });
  if (!("source" in hydrated) || !("active_history_refs" in hydrated.source)) {
    throw new Error("persisted compaction intent did not hydrate inline");
  }
  const intent = hydrated as CompactionIntentV1;
  return {
    record: {
      ...record,
      item: {
        type: "compaction_intent",
        payload: intent,
        eventVersion: record.item.eventVersion,
      },
    },
    intent,
  };
}

function validatePersistedSourceHistory(
  persisted: CompactionPersistedIntentV1,
  payloadRegistry: DiskCompactionPayloadRegistry,
): void {
  const sourceHistory = payloadRegistry.reconstruct(
    persisted.source_history_manifest,
  );
  // The inline rollback reader strictly validates projection messages and the
  // source-history digest before the value can participate in reconstruction.
  readCompactionRolloutPayload("compaction_rollback_committed", {
    format_version: persisted.format_version,
    minimum_reader_runtime: persisted.minimum_reader_runtime,
    attempt_id: persisted.attempt_id,
    recorded_at_ms: persisted.recorded_at_ms,
    commit_sha256: "0".repeat(64),
    source_sha256: persisted.source.source_sha256,
    history_digest: persisted.source.history_digest,
    source_session_id: persisted.source.session_id,
    source_epoch: persisted.source.epoch,
    rollback_mode: "same_session",
    target_session_id: persisted.source.session_id,
    source_history: sourceHistory,
  });
}

function hydratePersistedCommitRecord(
  record: StrictCanonicalJournalRecord,
  persisted: CompactionPersistedCommittedV1,
  intent: CompactionIntentV1,
  payloadRegistry: DiskCompactionPayloadRegistry,
): StrictCanonicalJournalRecord {
  const hydrated = readCompactionRolloutPayload("compaction_committed", {
    format_version: persisted.format_version,
    minimum_reader_runtime: persisted.minimum_reader_runtime,
    attempt_id: persisted.attempt_id,
    recorded_at_ms: persisted.recorded_at_ms,
    committed_at_ms: persisted.committed_at_ms,
    rollback_retention_deadline_ms: persisted.rollback_retention_deadline_ms,
    source: intent.source,
    selected_history_indexes: persisted.selected_history_indexes,
    policy_digest: persisted.policy_digest,
    configuration_digest: persisted.configuration_digest,
    summary: payloadRegistry.reconstruct(persisted.final_summary_manifest),
    summary_dag: payloadRegistry.reconstruct(persisted.summary_dag_manifest),
    accounting: persisted.accounting,
    replacement_history: payloadRegistry.reconstruct(
      persisted.replacement_history_manifest,
    ),
    cleanup_state: persisted.cleanup_state,
  });
  if (!("replacement_history" in hydrated)) {
    throw new Error("persisted compaction commit did not hydrate inline");
  }
  return {
    ...record,
    item: {
      type: "compaction_committed",
      payload: hydrated as CompactionCommittedV1,
      eventVersion: record.item.eventVersion,
    },
  };
}

function hydratePersistedRollbackRecord(
  record: StrictCanonicalJournalRecord,
  persisted: CompactionPersistedRollbackCommittedV1,
  payloadRegistry: DiskCompactionPayloadRegistry,
): StrictCanonicalJournalRecord {
  const hydrated = readCompactionRolloutPayload(
    "compaction_rollback_committed",
    {
      format_version: persisted.format_version,
      minimum_reader_runtime: persisted.minimum_reader_runtime,
      attempt_id: persisted.attempt_id,
      recorded_at_ms: persisted.recorded_at_ms,
      commit_sha256: persisted.commit_sha256,
      source_sha256: persisted.source_sha256,
      history_digest: persisted.history_digest,
      source_session_id: persisted.source_session_id,
      source_epoch: persisted.source_epoch,
      rollback_mode: persisted.rollback_mode,
      target_session_id: persisted.target_session_id,
      source_history: payloadRegistry.reconstruct(
        persisted.source_history_manifest,
      ),
    },
  );
  if (!("source_history" in hydrated)) {
    throw new Error("persisted compaction rollback did not hydrate inline");
  }
  return {
    ...record,
    item: {
      type: "compaction_rollback_committed",
      payload: hydrated as CompactionRollbackCommittedV1,
      eventVersion: record.item.eventVersion,
    },
  };
}

function persistedIntentPayload(
  item: RolloutItem,
): CompactionPersistedIntentV1 | undefined {
  if (item.type !== "compaction_intent") return undefined;
  const payload = item.payload as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("source_history_manifest" in payload)
  )
    return undefined;
  return readCompactionPersistedIntentV1(payload);
}

function persistedCommitPayload(
  item: RolloutItem,
): CompactionPersistedCommittedV1 | undefined {
  if (item.type !== "compaction_committed") return undefined;
  const payload = item.payload as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("final_summary_manifest" in payload)
  )
    return undefined;
  return readCompactionPersistedCommittedV1(payload);
}

function persistedRollbackPayload(
  item: RolloutItem,
): CompactionPersistedRollbackCommittedV1 | undefined {
  if (item.type !== "compaction_rollback_committed") return undefined;
  const payload = item.payload as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("source_history_manifest" in payload)
  )
    return undefined;
  return readCompactionPersistedRollbackCommittedV1(payload);
}

function isCausalAutoCompactionBoundary(item: RolloutItem): boolean {
  return (
    item.type === "event_msg" &&
    item.payload.msg.type === "context_compacted" &&
    typeof item.payload.msg.payload.summary === "string" &&
    /^auto-compact boundary \(turnId=[^)]+\)$/u.test(
      item.payload.msg.payload.summary,
    )
  );
}

function strictOptions(
  options: CanonicalRolloutScanOptions,
  checkOperationalBudget: () => void,
): StrictCanonicalJournalOptions {
  return {
    ...(options.expectedRunId !== undefined
      ? { expectedRunId: options.expectedRunId }
      : {}),
    ...(options.expectedEpoch !== undefined
      ? { expectedEpoch: options.expectedEpoch }
      : {}),
    ...(options.terminalPolicy !== undefined
      ? { terminalPolicy: options.terminalPolicy }
      : {}),
    maxSourceBytes: MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
    checkOperationalBudget,
  };
}

function scanPass(
  fd: number,
  size: bigint,
  options: StrictCanonicalJournalOptions,
): StrictCanonicalJournal {
  options.checkOperationalBudget?.();
  const validator = new StrictCanonicalJournalValidator(options);
  options.checkOperationalBudget?.();
  const chunk = Buffer.allocUnsafe(RECOVERY_SCAN_CHUNK_BYTES);
  let offset = 0;
  while (BigInt(offset) < size) {
    options.checkOperationalBudget?.();
    const remaining = size - BigInt(offset);
    const requested = Number(
      remaining < BigInt(chunk.byteLength)
        ? remaining
        : BigInt(chunk.byteLength),
    );
    const bytesRead = readSync(fd, chunk, 0, requested, offset);
    if (bytesRead <= 0) {
      throw new Error("canonical rollout ended before its pinned size");
    }
    validator.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return validator.finish();
}

function observeAdmission(
  record: StrictCanonicalJournalRecord,
  attempt: MutableAttemptScan,
): void {
  if (attempt.terminal) return;
  const item = record.item;
  if (
    (item.type === "compaction_committed" ||
      item.type === "compaction_failed") &&
    item.payload.attempt_id === attempt.intent?.attempt_id
  ) {
    return;
  }
  if (
    item.type === "compaction_payload_chunk" &&
    item.payload.attempt_id === attempt.intent?.attempt_id
  ) {
    return;
  }
  if (
    item.type !== "event_msg" ||
    item.payload.msg.type !== "execution_admission"
  ) {
    attempt.contaminated = true;
    return;
  }
  if (!advanceAdmission(attempt, item.payload.msg.payload, item.payload)) {
    attempt.contaminated = true;
  }
}

function advanceAdmission(
  attempt: MutableAttemptScan,
  admission: AdmissionJournalEvent,
  envelope: Extract<RolloutItem, { type: "event_msg" }>["payload"],
): boolean {
  const intent = attempt.intent;
  if (intent === undefined) return false;
  if (
    admission.sequence <= attempt.latestAdmissionSequence ||
    admission.eventId.length === 0 ||
    attempt.eventIds.has(admission.eventId) ||
    envelope.eventId !== admission.eventId ||
    envelope.id !== admission.eventId
  )
    return false;
  const callNumber = admissionCallNumber(admission, intent);
  if (callNumber === undefined || callNumber < attempt.latestCall) return false;
  attempt.latestAdmissionSequence = admission.sequence;
  attempt.eventIds.add(admission.eventId);
  attempt.admissionRunId ??= admission.runId;
  const scoped = admission as AdmissionJournalEvent & {
    readonly parentRunId?: string;
    readonly sessionId?: string;
  };
  if (
    admission.runId !== attempt.admissionRunId ||
    admission.runId !== intent.attempt_id ||
    (scoped.parentRunId !== undefined &&
      scoped.parentRunId !== intent.source.session_id) ||
    (scoped.sessionId !== undefined &&
      scoped.sessionId !== intent.source.session_id)
  )
    return false;
  const state = attempt.calls.get(callNumber) ?? {
    queued: false,
    allowed: false,
    dispatched: false,
    reconciled: false,
    heldUnknown: false,
  };
  if (!advanceAdmissionState(state, admission, attempt.reservationIds))
    return false;
  attempt.calls.set(callNumber, state);
  attempt.latestCall = callNumber;
  return true;
}

function admissionCallNumber(
  admission: AdmissionJournalEvent,
  intent: CompactionIntentV1,
): number | undefined {
  if (admission.kind !== "model_turn") return undefined;
  const prefix = `compact:${intent.attempt_id}:`;
  if (!admission.stepId.startsWith(prefix)) return undefined;
  const suffix = admission.stepId.slice(prefix.length);
  if (!/^[1-9][0-9]*$/u.test(suffix)) return undefined;
  const callNumber = Number(suffix);
  return Number.isSafeInteger(callNumber) &&
    callNumber <= MAX_COMPACTION_PROVIDER_CALLS
    ? callNumber
    : undefined;
}

function advanceAdmissionState(
  state: MutableAdmissionState,
  admission: AdmissionJournalEvent,
  reservationIds: Set<string>,
): boolean {
  switch (admission.event) {
    case "queued":
      if (
        state.queued ||
        state.allowed ||
        state.dispatched ||
        state.reconciled ||
        state.heldUnknown
      )
        return false;
      state.queued = true;
      return true;
    case "allowed":
      if (
        !state.queued ||
        state.allowed ||
        state.dispatched ||
        state.reconciled ||
        state.heldUnknown ||
        admission.reservationId === undefined ||
        admission.reservationId.length === 0 ||
        reservationIds.has(admission.reservationId)
      )
        return false;
      state.reservationId = admission.reservationId;
      reservationIds.add(admission.reservationId);
      state.allowed = true;
      return true;
    case "fallback":
      return (
        state.allowed &&
        !state.reconciled &&
        !state.heldUnknown &&
        admission.reservationId === state.reservationId
      );
    case "dispatched":
      if (
        !state.allowed ||
        state.dispatched ||
        state.reconciled ||
        state.heldUnknown ||
        admission.reservationId !== state.reservationId
      )
        return false;
      state.dispatched = true;
      return true;
    case "reconciled":
      if (
        !state.dispatched ||
        state.reconciled ||
        admission.reservationId !== state.reservationId
      )
        return false;
      state.reconciled = true;
      return true;
    case "held_unknown":
      if (
        !state.dispatched ||
        state.reconciled ||
        state.heldUnknown ||
        admission.reservationId !== state.reservationId
      )
        return false;
      state.heldUnknown = true;
      return true;
    default:
      return false;
  }
}

function validAdmission(attempt: MutableAttemptScan): boolean {
  const intent = attempt.intent;
  if (intent === undefined) return false;
  if (attempt.contaminated) return false;
  if (attempt.calls.size === 0) return !intent.admission_required;
  if (
    !intent.admission_required ||
    attempt.calls.size !== intent.planned_provider_calls ||
    attempt.latestCall !== attempt.calls.size
  )
    return false;
  for (let call = 1; call <= attempt.latestCall; call += 1) {
    const state = attempt.calls.get(call);
    if (
      state === undefined ||
      !state.queued ||
      !state.allowed ||
      !state.dispatched ||
      (!state.reconciled && !state.heldUnknown)
    )
      return false;
  }
  return true;
}

function readPhysicalRecord(
  fd: number,
  record: StrictCanonicalJournalRecord,
): Buffer {
  const length = record.encodedByteLength + 1;
  const physical = Buffer.allocUnsafe(length);
  const bytesRead = readSync(fd, physical, 0, length, record.byteOffset);
  if (bytesRead !== length || physical.at(-1) !== 0x0a) {
    throw new Error("canonical rollout record changed beneath its scan");
  }
  return physical;
}

function assertMatchingProof(
  first: StrictCanonicalJournal,
  second: StrictCanonicalJournal,
): void {
  if (
    first.sourceSha256 !== second.sourceSha256 ||
    first.sourceByteLength !== second.sourceByteLength ||
    first.recordCount !== second.recordCount ||
    first.eventCount !== second.eventCount ||
    first.activeEpoch !== second.activeEpoch ||
    first.activeLifecycleState !== second.activeLifecycleState ||
    first.activeTerminalStatus !== second.activeTerminalStatus ||
    first.activeSuspensionEventId !== second.activeSuspensionEventId ||
    first.activeCancellationRequestEventId !==
      second.activeCancellationRequestEventId ||
    first.activeStartupActivationResumeEventId !==
      second.activeStartupActivationResumeEventId ||
    first.activeRuntimeSettingsEventId !==
      second.activeRuntimeSettingsEventId ||
    first.legacyPermissionMode !== second.legacyPermissionMode ||
    JSON.stringify(first.activeRuntimeSettings) !==
      JSON.stringify(second.activeRuntimeSettings)
  ) {
    throw new Error("canonical rollout proof changed between scan passes");
  }
}

function assertPinnedSnapshot(fd: number, before: BigIntStats): void {
  const after = fstatSync(fd, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(
      "canonical rollout changed during compaction reconciliation",
    );
  }
}

function withoutRecords(
  journal: StrictCanonicalJournal,
): Omit<StrictCanonicalJournal, "records"> {
  const { records: _records, ...proof } = journal;
  return proof;
}
