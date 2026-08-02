import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import { SessionLockedError } from "../session/session-store.js";
import {
  OfflineRolloutUnsafePathError,
  withPinnedOfflineRolloutReadLease,
  type PinnedOfflineRolloutReader,
  type PinnedOfflineRolloutSnapshot,
} from "../durability/offline-rollout.js";
import {
  CanonicalJournalIntegrityError,
  MAX_RECOVERY_CANONICAL_EVENTS,
  MAX_RECOVERY_CANONICAL_LINE_BYTES,
  MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
  MAX_RECOVERY_PINNED_DESCRIPTORS,
  MAX_RECOVERY_SCAN_MILLISECONDS,
  MAX_RECOVERY_STARTUP_READ_BYTES,
  RECOVERY_PINNED_DESCRIPTOR_COST,
  RECOVERY_SCAN_CHUNK_BYTES,
  RecoveryOperationalError,
} from "./recovery-contract.js";
import {
  StrictCanonicalJournalValidator,
  type CanonicalJournalIdentityRegistry,
  type StrictCanonicalJournal,
  type StrictCanonicalJournalOptions,
  type StrictCanonicalJournalRecord,
} from "./recovery-journal-contract.js";

const RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST = 1;
const RECOVERY_TWO_PASS_DESCRIPTOR_COST =
  RECOVERY_PINNED_DESCRIPTOR_COST + RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST;
const RECOVERY_IDENTITY_CACHE_KIB = 1_024;

export interface RecoveryFileLimits {
  readonly maxLineBytes: number;
  readonly maxSourceBytes: number;
  readonly maxEvents: number;
  readonly maxScanMilliseconds: number;
  readonly maxReadBytes: number;
  readonly chunkBytes: number;
}

export interface RecoveryFileLimitOverrides {
  readonly maxLineBytes?: number;
  readonly maxSourceBytes?: number;
  readonly maxEvents?: number;
  readonly maxScanMilliseconds?: number;
  readonly maxReadBytes?: number;
  readonly chunkBytes?: number;
}

export interface PinnedCanonicalJournalProof extends Omit<
  StrictCanonicalJournal,
  "records"
> {
  readonly snapshot: PinnedOfflineRolloutSnapshot;
}

export interface PinnedCanonicalJournalReplay {
  readonly proof: PinnedCanonicalJournalProof;
  replay(
    onRecord: (record: StrictCanonicalJournalRecord) => void,
  ): PinnedCanonicalJournalProof;
  /** Final synchronous boundary for the surrounding SQLite transaction. */
  assertPinned(): void;
}

export interface PinnedCanonicalJournalOptions extends Pick<
  StrictCanonicalJournalOptions,
  "expectedRunId" | "expectedEpoch" | "terminalPolicy"
> {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  /** Observe transient first-pass records without retaining them. */
  readonly observeValidatedRecord?: (
    record: StrictCanonicalJournalRecord,
  ) => void;
  /** Diagnostic/test seam invoked while the source descriptor remains pinned. */
  readonly afterValidationPass?: (proof: PinnedCanonicalJournalProof) => void;
}

export interface StableRecoverySourceDigest {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceMtimeMs: number;
}

/** Shared, synchronous descriptor reservation used by nested recovery work. */
export class RecoveryDescriptorBudget {
  #inUse = 0;

  constructor(readonly limit = MAX_RECOVERY_PINNED_DESCRIPTORS) {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_RECOVERY_PINNED_DESCRIPTORS
    ) {
      throw new TypeError(
        `recovery descriptor limit must be an integer in [1, ${MAX_RECOVERY_PINNED_DESCRIPTORS}]`,
      );
    }
  }

  withReservation<T>(count: number, operation: () => T): T {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError("recovery descriptor reservation must be positive");
    }
    if (this.#inUse + count > this.limit) {
      throw new RecoveryOperationalError(
        "descriptor_limit",
        `recovery descriptor budget requires ${count} slots with ${this.#inUse} already reserved`,
        "RECOVERY_DESCRIPTOR_BUDGET",
      );
    }
    this.#inUse += count;
    try {
      return operation();
    } finally {
      this.#inUse -= count;
    }
  }
}

const sharedDescriptorBudget = new RecoveryDescriptorBudget();

/**
 * Validate one descriptor-pinned source, then expose exactly one digest-
 * anchored replay through the same retained descriptor. No record array is
 * retained in either pass.
 */
export function withPinnedCanonicalJournalTwoPass<T>(
  options: PinnedCanonicalJournalOptions,
  operation: (journal: PinnedCanonicalJournalReplay) => T,
): T {
  const limits = recoveryFileLimits(options.limits);
  const budget = new RecoveryReadBudget(
    limits,
    options.nowMilliseconds ?? Date.now,
  );
  const descriptors = options.descriptorBudget ?? sharedDescriptorBudget;
  return descriptors.withReservation(RECOVERY_TWO_PASS_DESCRIPTOR_COST, () =>
    mapRecoveryFileErrors(options.sourcePath, () =>
      withPinnedOfflineRolloutReadLease(options, (reader) => {
        const snapshot = reader.stat();
        assertSourceCeilings(snapshot, limits);
        budget.reserveReadBytes(snapshot.size * 2);
        const identityRegistry = new DiskCanonicalIdentityRegistry();
        let first: StrictCanonicalJournal;
        try {
          first = scanStrictPass(reader, snapshot, budget, limits.chunkBytes, {
            ...strictOptions(options, limits),
            retainRecords: false,
            identityRegistry,
            ...(options.observeValidatedRecord !== undefined
              ? { onRecord: options.observeValidatedRecord }
              : {}),
          });
        } finally {
          identityRegistry.close();
        }
        const proof = journalProof(first, snapshot);
        options.afterValidationPass?.(proof);
        reader.assertSnapshot(snapshot);
        let replayed = false;
        const replay: PinnedCanonicalJournalReplay = Object.freeze({
          proof,
          replay: (
            onRecord: (record: StrictCanonicalJournalRecord) => void,
          ) => {
            if (replayed) {
              throw new Error("canonical journal replay may run only once");
            }
            replayed = true;
            const second = scanStrictPass(
              reader,
              snapshot,
              budget,
              limits.chunkBytes,
              {
                ...strictOptions(options, limits),
                trustedSourceSha256: proof.sourceSha256,
                retainRecords: false,
                identityPolicy: "trusted_replay",
                onRecord,
              },
            );
            const replayProof = journalProof(second, snapshot);
            assertMatchingProof(proof, replayProof);
            reader.assertSnapshot(snapshot);
            return replayProof;
          },
          assertPinned: () => reader.assertSnapshot(snapshot),
        });
        const result = operation(replay);
        if (!replayed) {
          throw new Error(
            "canonical journal operation did not consume its replay",
          );
        }
        reader.assertSnapshot(snapshot);
        return result;
      }),
    ),
  );
}

/** Compute a stable digest without requiring the source bytes to parse. */
export function hashPinnedRecoverySource(options: {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
}): StableRecoverySourceDigest {
  const limits = recoveryFileLimits(options.limits);
  const budget = new RecoveryReadBudget(
    limits,
    options.nowMilliseconds ?? Date.now,
  );
  const descriptors = options.descriptorBudget ?? sharedDescriptorBudget;
  return descriptors.withReservation(RECOVERY_PINNED_DESCRIPTOR_COST, () =>
    mapRecoveryFileErrors(options.sourcePath, () =>
      withPinnedOfflineRolloutReadLease(options, (reader) => {
        const snapshot = reader.stat();
        assertSourceCeilings(snapshot, limits);
        budget.reserveReadBytes(snapshot.size);
        const hash = createHash("sha256");
        reader.scanChunks(limits.chunkBytes, (chunk) => {
          budget.checkTime();
          hash.update(chunk);
        });
        reader.assertSnapshot(snapshot);
        return Object.freeze({
          sourcePath: options.sourcePath,
          sourceSha256: hash.digest("hex"),
          sourceByteLength: snapshot.size,
          sourceMtimeMs: snapshot.mtimeMs,
        });
      }),
    ),
  );
}

export function recoveryFileLimits(
  overrides: RecoveryFileLimitOverrides = {},
): RecoveryFileLimits {
  return Object.freeze({
    maxLineBytes: boundedLimit(
      overrides.maxLineBytes,
      MAX_RECOVERY_CANONICAL_LINE_BYTES,
      "maxLineBytes",
    ),
    maxSourceBytes: boundedLimit(
      overrides.maxSourceBytes,
      MAX_RECOVERY_CANONICAL_SOURCE_BYTES,
      "maxSourceBytes",
    ),
    maxEvents: boundedLimit(
      overrides.maxEvents,
      MAX_RECOVERY_CANONICAL_EVENTS,
      "maxEvents",
    ),
    maxScanMilliseconds: boundedLimit(
      overrides.maxScanMilliseconds,
      MAX_RECOVERY_SCAN_MILLISECONDS,
      "maxScanMilliseconds",
    ),
    maxReadBytes: boundedLimit(
      overrides.maxReadBytes,
      MAX_RECOVERY_STARTUP_READ_BYTES,
      "maxReadBytes",
    ),
    chunkBytes: boundedLimit(
      overrides.chunkBytes,
      RECOVERY_SCAN_CHUNK_BYTES,
      "chunkBytes",
    ),
  });
}

function scanStrictPass(
  reader: PinnedOfflineRolloutReader,
  snapshot: PinnedOfflineRolloutSnapshot,
  budget: RecoveryReadBudget,
  chunkBytes: number,
  options: StrictCanonicalJournalOptions,
): StrictCanonicalJournal {
  const validator = new StrictCanonicalJournalValidator(options);
  reader.scanChunks(chunkBytes, (chunk) => {
    budget.checkTime();
    validator.push(chunk);
  });
  reader.assertSnapshot(snapshot);
  budget.checkTime();
  return validator.finish();
}

function strictOptions(
  options: PinnedCanonicalJournalOptions,
  limits: RecoveryFileLimits,
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
    maxLineBytes: limits.maxLineBytes,
    maxSourceBytes: limits.maxSourceBytes,
    maxEvents: limits.maxEvents,
  };
}

function journalProof(
  journal: StrictCanonicalJournal,
  snapshot: PinnedOfflineRolloutSnapshot,
): PinnedCanonicalJournalProof {
  return Object.freeze({
    recordCount: journal.recordCount,
    format: journal.format,
    sourceSha256: journal.sourceSha256,
    sourceByteLength: journal.sourceByteLength,
    physicalLineCount: journal.physicalLineCount,
    eventCount: journal.eventCount,
    terminalCount: journal.terminalCount,
    digestAnchored: journal.digestAnchored,
    snapshot,
  });
}

function assertMatchingProof(
  expected: PinnedCanonicalJournalProof,
  observed: PinnedCanonicalJournalProof,
): void {
  for (const key of [
    "recordCount",
    "format",
    "sourceSha256",
    "sourceByteLength",
    "physicalLineCount",
    "eventCount",
    "terminalCount",
  ] as const) {
    if (expected[key] !== observed[key]) {
      throw new CanonicalJournalIntegrityError(
        "source_changed",
        `canonical journal ${key} changed between validation passes`,
      );
    }
  }
}

function assertSourceCeilings(
  snapshot: PinnedOfflineRolloutSnapshot,
  limits: RecoveryFileLimits,
): void {
  if (snapshot.size > limits.maxSourceBytes) {
    throw new CanonicalJournalIntegrityError(
      "source_byte_limit",
      "canonical journal exceeds its source byte ceiling",
      {
        byteOffset: limits.maxSourceBytes,
      },
    );
  }
}

function mapRecoveryFileErrors<T>(sourcePath: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof CanonicalJournalIntegrityError ||
      error instanceof RecoveryOperationalError
    ) {
      throw error;
    }
    if (error instanceof OfflineRolloutUnsafePathError) {
      if (error.message.includes("changed during")) {
        throw new CanonicalJournalIntegrityError(
          "source_changed",
          `canonical journal changed while pinned: ${sourcePath}`,
        );
      }
      throw error;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EMFILE" || code === "ENFILE") {
      throw new RecoveryOperationalError(
        "descriptor_limit",
        `descriptor pressure prevented canonical recovery for ${sourcePath}`,
        code,
      );
    }
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new RecoveryOperationalError(
        "database_busy",
        `database contention prevented canonical recovery for ${sourcePath}`,
        code,
      );
    }
    if (
      code?.startsWith("SQLITE_IOERR") === true ||
      code === "SQLITE_FULL" ||
      code?.startsWith("SQLITE_READONLY") === true
    ) {
      throw new RecoveryOperationalError(
        "database_io",
        `database I/O prevented canonical recovery for ${sourcePath}`,
        code,
      );
    }
    if (code === "SQLITE_CANTOPEN" || code === "SQLITE_NOTADB") {
      throw new RecoveryOperationalError(
        "database_unavailable",
        `database storage is unavailable for canonical recovery of ${sourcePath}`,
        code,
      );
    }
    if (
      code?.startsWith("SQLITE_CONSTRAINT") === true ||
      code === "SQLITE_MISMATCH"
    ) {
      throw new RecoveryOperationalError(
        "projection_failure",
        `database projection rejected canonical recovery for ${sourcePath}`,
        code,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof SessionLockedError ||
      message.includes("canonical journal is live")
    ) {
      throw new RecoveryOperationalError(
        "source_not_quiescent",
        `canonical recovery source is not quiescent: ${sourcePath}`,
        "RECOVERY_SOURCE_LIVE",
      );
    }
    throw error;
  }
}

class RecoveryReadBudget {
  readonly #startedAt: number;
  #reservedBytes = 0;

  constructor(
    private readonly limits: RecoveryFileLimits,
    private readonly nowMilliseconds: () => number,
  ) {
    this.#startedAt = nowMilliseconds();
  }

  reserveReadBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("recovery read byte reservation is invalid");
    }
    if (this.#reservedBytes + bytes > this.limits.maxReadBytes) {
      throw new RecoveryOperationalError(
        "startup_byte_budget",
        "canonical recovery exceeds its aggregate read-byte budget",
        "RECOVERY_READ_BUDGET",
      );
    }
    this.#reservedBytes += bytes;
    this.checkTime();
  }

  checkTime(): void {
    if (
      this.nowMilliseconds() - this.#startedAt >
      this.limits.maxScanMilliseconds
    ) {
      throw new RecoveryOperationalError(
        "startup_time_budget",
        "canonical recovery exceeded its scan-time budget",
        "RECOVERY_TIME_BUDGET",
      );
    }
  }
}

class DiskCanonicalIdentityRegistry implements CanonicalJournalIdentityRegistry {
  readonly #directory: string;
  readonly #database: BetterSqlite3.Database;
  readonly #insert: BetterSqlite3.Statement<[number, string]>;
  #closed = false;

  constructor() {
    this.#directory = mkdtempSync(join(tmpdir(), "agenc-recovery-identities-"));
    const databasePath = join(this.#directory, "identities.sqlite");
    this.#database = new Database(databasePath);
    this.#database.pragma("journal_mode = OFF");
    this.#database.pragma("synchronous = OFF");
    this.#database.pragma(`cache_size = -${RECOVERY_IDENTITY_CACHE_KIB}`);
    this.#database.exec(
      `CREATE TABLE identities (
         kind INTEGER NOT NULL,
         identity TEXT NOT NULL,
         PRIMARY KEY (kind, identity)
       ) WITHOUT ROWID;
       BEGIN`,
    );
    this.#insert = this.#database.prepare(
      "INSERT OR IGNORE INTO identities (kind, identity) VALUES (?, ?)",
    );
  }

  claimEventId(eventId: string): boolean {
    return this.#claim(1, eventId);
  }

  claimTerminalKey(terminalKey: string): boolean {
    return this.#claim(2, terminalKey);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.exec("COMMIT");
    } finally {
      this.#database.close();
      rmSync(this.#directory, { recursive: true, force: true });
    }
  }

  #claim(kind: number, identity: string): boolean {
    if (this.#closed) throw new Error("recovery identity registry is closed");
    return this.#insert.run(kind, identity).changes === 1;
  }
}

function boundedLimit(
  requested: number | undefined,
  maximum: number,
  label: string,
): number {
  const value = requested ?? maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}
