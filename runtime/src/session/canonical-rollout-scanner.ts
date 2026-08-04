import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";

import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import {
  MAX_COMPACTION_PIN_HISTORY_TOTAL,
  MAX_COMPACTION_PROVIDER_CALLS,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  type CompactionIntentV1,
} from "../services/compact/transaction-types.js";
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

const MAX_COMPACTION_LIFECYCLE_RECORDS =
  MAX_COMPACTION_PIN_HISTORY_TOTAL * 6;

interface MutableAdmissionState {
  queued: boolean;
  allowed: boolean;
  dispatched: boolean;
  reconciled: boolean;
  heldUnknown: boolean;
  reservationId?: string;
}

interface MutableAttemptScan {
  readonly intent: CompactionIntentV1;
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
}

export interface CanonicalRolloutSourceRecord {
  readonly lineNumber: number;
  readonly encodedByteLength: number;
  readonly itemType: RolloutItem["type"];
  readonly compactionSourceSha256: string;
  readonly committedAttemptId?: string;
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
  readonly activeHistory?: CanonicalActiveHistoryScan;
  readonly historyAtAttempts: ReadonlyMap<string, readonly ResponseItem[]>;
}

export interface CanonicalRolloutScanOptions
  extends Pick<
    StrictCanonicalJournalOptions,
    "expectedRunId" | "expectedEpoch" | "terminalPolicy"
  > {
  readonly nowMilliseconds?: () => number;
  readonly maximumScanMilliseconds: number;
  readonly additionalSourceLines?: readonly number[];
  readonly compactionSourceDigestDomain: string;
  readonly captureActiveHistory?: boolean;
  readonly captureHistoryAtAttemptIds?: readonly string[];
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
    const capturedAttemptIds = new Set(options.captureHistoryAtAttemptIds ?? []);
    const trackHistory = options.captureActiveHistory === true ||
      capturedAttemptIds.size > 0;
    let reducedState = emptyReducedState();
    let activePositions: CanonicalActiveHistoryPosition[] = [];
    const activeLineBytes = new Map<number, number>();
    let activeSourceBytes = 0;
    const historyAtAttempts = new Map<string, readonly ResponseItem[]>();
    let retainedLifecycleRecords = 0;
    let activeAdmissionAttempt: MutableAttemptScan | undefined;
    let latestCommittedAttempt: MutableAttemptScan | undefined;
    checkOperationalBudget();
    const identityRegistry = new DiskCanonicalIdentityRegistry();
    let first: StrictCanonicalJournal;
    try {
      first = scanPass(fd, snapshot.size, {
        ...strictOptions(options, checkOperationalBudget),
        retainRecords: false,
        identityRegistry,
        onRecord: (record) => {
          if (latestCommittedAttempt !== undefined &&
              !(record.item.type === "compaction_cleanup_pending" &&
                record.item.payload.attempt_id ===
                  latestCommittedAttempt.intent.attempt_id)) {
            latestCommittedAttempt.laterWork = true;
            latestCommittedAttempt = undefined;
          }
          if (trackHistory && record.item.type === "compaction_intent" &&
              capturedAttemptIds.has(record.item.payload.attempt_id)) {
            checkOperationalBudget();
            historyAtAttempts.set(
              record.item.payload.attempt_id,
              Object.freeze(reducedState.history.slice()),
            );
          }
          if (activeAdmissionAttempt !== undefined) {
            observeAdmission(record, activeAdmissionAttempt);
          }
          const item = record.item;
          if (trackHistory) {
            checkOperationalBudget();
            const next = reduceStreamingHistory(reducedState, item);
            if (item.type === "response_item") {
              activePositions.push({
                lineNumber: record.lineNumber,
                recordMessageIndex: 0,
              });
              if (!activeLineBytes.has(record.lineNumber)) {
                activeLineBytes.set(record.lineNumber, record.encodedByteLength + 1);
                activeSourceBytes += record.encodedByteLength + 1;
              }
            } else if (
              (item.type === "compacted" &&
                item.payload.replacementHistory !== undefined) ||
              item.type === "compaction_committed" ||
              (item.type === "compaction_rollback_committed" &&
                item.payload.target_session_id === options.expectedRunId)
            ) {
              checkOperationalBudget();
              activePositions = next.history.map((_, recordMessageIndex) => ({
                lineNumber: record.lineNumber,
                recordMessageIndex,
              }));
              activeLineBytes.clear();
              activeLineBytes.set(record.lineNumber, record.encodedByteLength + 1);
              activeSourceBytes = record.encodedByteLength + 1;
            } else if (next.history.length < activePositions.length) {
              activePositions = activePositions.slice(0, next.history.length);
              const retainedLines = new Set(
                activePositions.map((position) => position.lineNumber),
              );
              for (const lineNumber of activeLineBytes.keys()) {
                if (!retainedLines.has(lineNumber)) activeLineBytes.delete(lineNumber);
              }
              activeSourceBytes = [...activeLineBytes.values()].reduce(
                (total, bytes) => total + bytes,
                0,
              );
            }
            reducedState = next;
            if (reducedState.history.length > MAX_COMPACTION_SOURCE_MESSAGES ||
                activeSourceBytes > MAX_COMPACTION_SOURCE_BYTES) {
              throw new RecoveryOperationalError(
                "recovery_history_storage_limit",
                "canonical active history exceeds its bounded compaction scan budget",
              );
            }
          }
          if (!item.type.startsWith("compaction_") ||
              !("attempt_id" in item.payload)) return;
          retainedLifecycleRecords += 1;
          if (retainedLifecycleRecords > MAX_COMPACTION_LIFECYCLE_RECORDS) {
            throw new RecoveryOperationalError(
              "recovery_history_storage_limit",
              "canonical compaction lifecycle exceeds its bounded retention budget",
            );
          }
          const attemptId = item.payload.attempt_id;
          if (item.type === "compaction_intent") {
            attempts.set(attemptId, {
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
            activeAdmissionAttempt = attempts.get(attemptId);
            return;
          }
          const attempt = attempts.get(attemptId);
          if (attempt === undefined) return;
          attempt.records.push(record);
          if (item.type === "compaction_committed" ||
              item.type === "compaction_failed") {
            attempt.terminal = true;
            if (item.type === "compaction_committed") {
              latestCommittedAttempt = attempt;
            }
            if (activeAdmissionAttempt === attempt) {
              activeAdmissionAttempt = undefined;
            }
          }
        },
      });
    } finally {
      identityRegistry.close();
    }

    checkOperationalBudget();
    const sourceLines = new Set(options.additionalSourceLines ?? []);
    for (const attempt of attempts.values()) {
      for (const ref of attempt.intent.source.active_history_refs) {
        sourceLines.add(ref.first_sequence);
      }
    }
    if (options.captureActiveHistory === true) {
      for (const position of activePositions) {
        sourceLines.add(position.lineNumber);
      }
    }
    const sourceRecords = new Map<number, CanonicalRolloutSourceRecord>();
    const second = scanPass(fd, snapshot.size, {
      ...strictOptions(options, checkOperationalBudget),
      trustedSourceSha256: first.sourceSha256,
      retainRecords: false,
      identityPolicy: "trusted_replay",
      onRecord: (record) => {
        if (!sourceLines.has(record.lineNumber)) return;
        checkOperationalBudget();
        const physical = readPhysicalRecord(fd, record);
        const item = record.item;
        sourceRecords.set(record.lineNumber, {
          lineNumber: record.lineNumber,
          encodedByteLength: physical.byteLength,
          itemType: item.type,
          compactionSourceSha256: createHash("sha256")
            .update(options.compactionSourceDigestDomain, "utf8")
            .update(physical)
            .digest("hex"),
          ...(item.type === "compaction_committed"
            ? { committedAttemptId: item.payload.attempt_id }
            : {}),
        });
      },
    });
    assertMatchingProof(first, second);
    assertPinnedSnapshot(fd, snapshot);
    checkOperationalBudget();
    return {
      proof: withoutRecords(first),
      attempts: new Map(
        [...attempts].map(([attemptId, attempt]) => [attemptId, {
          intent: attempt.intent,
          records: Object.freeze(attempt.records.slice()),
          admissionValid: validAdmission(attempt),
          hasLaterCanonicalWork: attempt.laterWork,
        }]),
      ),
      sourceRecords,
      ...(options.captureActiveHistory === true
        ? { activeHistory: {
            messages: Object.freeze(reducedState.history.slice()),
            positions: Object.freeze(activePositions.slice()),
          } }
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
      remaining < BigInt(chunk.byteLength) ? remaining : BigInt(chunk.byteLength),
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
    (item.type === "compaction_committed" || item.type === "compaction_failed") &&
    item.payload.attempt_id === attempt.intent.attempt_id
  ) {
    return;
  }
  if (item.type !== "event_msg" ||
      item.payload.msg.type !== "execution_admission") {
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
  if (
    admission.sequence <= attempt.latestAdmissionSequence ||
    admission.eventId.length === 0 ||
    attempt.eventIds.has(admission.eventId) ||
    envelope.eventId !== admission.eventId ||
    envelope.id !== admission.eventId
  ) return false;
  const callNumber = admissionCallNumber(admission, attempt.intent);
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
    admission.runId !== attempt.intent.attempt_id ||
    (scoped.parentRunId !== undefined &&
      scoped.parentRunId !== attempt.intent.source.session_id) ||
    (scoped.sessionId !== undefined &&
      scoped.sessionId !== attempt.intent.source.session_id)
  ) return false;
  const state = attempt.calls.get(callNumber) ?? {
    queued: false,
    allowed: false,
    dispatched: false,
    reconciled: false,
    heldUnknown: false,
  };
  if (!advanceAdmissionState(state, admission, attempt.reservationIds)) return false;
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
      if (state.queued || state.allowed || state.dispatched ||
          state.reconciled || state.heldUnknown) return false;
      state.queued = true;
      return true;
    case "allowed":
      if (!state.queued || state.allowed || state.dispatched ||
          state.reconciled || state.heldUnknown ||
          admission.reservationId === undefined ||
          admission.reservationId.length === 0 ||
          reservationIds.has(admission.reservationId)) return false;
      state.reservationId = admission.reservationId;
      reservationIds.add(admission.reservationId);
      state.allowed = true;
      return true;
    case "fallback":
      return state.allowed && !state.reconciled && !state.heldUnknown &&
        admission.reservationId === state.reservationId;
    case "dispatched":
      if (!state.allowed || state.dispatched || state.reconciled ||
          state.heldUnknown ||
          admission.reservationId !== state.reservationId) return false;
      state.dispatched = true;
      return true;
    case "reconciled":
      if (!state.dispatched || state.reconciled ||
          admission.reservationId !== state.reservationId) return false;
      state.reconciled = true;
      return true;
    case "held_unknown":
      if (!state.dispatched || state.reconciled || state.heldUnknown ||
          admission.reservationId !== state.reservationId) return false;
      state.heldUnknown = true;
      return true;
    default:
      return false;
  }
}

function validAdmission(attempt: MutableAttemptScan): boolean {
  if (attempt.contaminated) return false;
  if (attempt.calls.size === 0) return !attempt.intent.admission_required;
  if (!attempt.intent.admission_required ||
      attempt.calls.size !== attempt.intent.planned_provider_calls ||
      attempt.latestCall !== attempt.calls.size) return false;
  for (let call = 1; call <= attempt.latestCall; call += 1) {
    const state = attempt.calls.get(call);
    if (state === undefined || !state.queued || !state.allowed ||
        !state.dispatched || (!state.reconciled && !state.heldUnknown)) return false;
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
  if (first.sourceSha256 !== second.sourceSha256 ||
      first.sourceByteLength !== second.sourceByteLength ||
      first.recordCount !== second.recordCount ||
      first.eventCount !== second.eventCount) {
    throw new Error("canonical rollout proof changed between scan passes");
  }
}

function assertPinnedSnapshot(
  fd: number,
  before: BigIntStats,
): void {
  const after = fstatSync(fd, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) {
    throw new Error("canonical rollout changed during compaction reconciliation");
  }
}

function withoutRecords(
  journal: StrictCanonicalJournal,
): Omit<StrictCanonicalJournal, "records"> {
  const { records: _records, ...proof } = journal;
  return proof;
}
