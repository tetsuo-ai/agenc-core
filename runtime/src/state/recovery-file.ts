import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import { SessionLockedError } from "../session/session-store.js";
import {
  OfflineRolloutDescriptorPathUnavailableError,
  OfflineRolloutSourceMissingError,
  OfflineRolloutUnsafePathError,
  withPinnedOfflineRolloutReadLease,
  type PinnedOfflineRolloutReader,
  type PinnedOfflineRolloutSnapshot,
} from "../durability/offline-rollout.js";
import {
  CanonicalJournalIntegrityError,
  DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN,
  DEFAULT_MAX_RECOVERY_LINE_BYTES,
  DEFAULT_MAX_RECOVERY_SOURCE_BYTES,
  DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
  DEFAULT_MAX_STARTUP_RECOVERY_MS,
  HARD_MAX_RECOVERY_EVENTS,
  HARD_MAX_RECOVERY_LINE_BYTES,
  HARD_MAX_RECOVERY_SOURCE_BYTES,
  HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
  HARD_MAX_RECOVERY_STARTUP_READ_BYTES,
  MAX_RECOVERY_PINNED_DESCRIPTORS,
  MAX_RECOVERY_SOURCES_PER_RUN,
  RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST,
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

const RECOVERY_IDENTITY_CACHE_KIB = 1_024;
const recoveryFailureSources = new WeakMap<object, string>();

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

export type PinnedCanonicalJournalSourceOptions = Omit<
  PinnedCanonicalJournalOptions,
  "limits" | "descriptorBudget" | "nowMilliseconds"
>;

export interface PinnedCanonicalJournalRunOptions {
  readonly sources: readonly PinnedCanonicalJournalSourceOptions[];
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  /** Diagnostic/test seam for registry lifecycle-failure coverage. */
  readonly createIdentityRegistry?: () => RecoveryRunIdentityRegistry;
  /** Reports the exact source associated with validation or replay failure. */
  readonly onSourceFailure?: (
    source: PinnedCanonicalJournalSourceOptions,
    error: unknown,
  ) => void;
}

export interface RecoveryRunIdentityRegistry
  extends CanonicalJournalIdentityRegistry {
  close(): void;
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
  return withPinnedCanonicalJournalRun(
    {
      sources: [sourceOptions(options)],
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.descriptorBudget !== undefined
        ? { descriptorBudget: options.descriptorBudget }
        : {}),
      ...(options.nowMilliseconds !== undefined
        ? { nowMilliseconds: options.nowMilliseconds }
        : {}),
    },
    (journals) => operation(journals[0]!),
  );
}

/**
 * Validate every source before invoking one caller-controlled transaction.
 * All source descriptors and leases remain pinned until that callback returns,
 * including SQLite's outer commit boundary.
 */
export function withPinnedCanonicalJournalRun<T>(
  options: PinnedCanonicalJournalRunOptions,
  operation: (journals: readonly PinnedCanonicalJournalReplay[]) => T,
): T {
  if (
    options.sources.length === 0 ||
    options.sources.length > MAX_RECOVERY_SOURCES_PER_RUN
  ) {
    throw new RecoveryOperationalError(
      "concurrency_limit",
      `canonical recovery requires between 1 and ${MAX_RECOVERY_SOURCES_PER_RUN} sources`,
      "RECOVERY_SOURCE_LIMIT",
    );
  }
  const sources = canonicalRecoverySources(options.sources);
  const limits = recoveryFileLimits(options.limits);
  const budget = new RecoveryReadBudget(
    limits,
    options.nowMilliseconds ?? Date.now,
  );
  const descriptors = options.descriptorBudget ?? sharedDescriptorBudget;
  const descriptorCost =
    sources.length * RECOVERY_PINNED_DESCRIPTOR_COST +
    RECOVERY_IDENTITY_DATABASE_DESCRIPTOR_COST;
  try {
    return descriptors.withReservation(descriptorCost, () =>
      withPinnedReaders(sources, 0, [], (readers) => {
        const prepared = prepareRunReplays(
          readers,
          budget,
          limits,
          options.createIdentityRegistry ??
            (() => new DiskCanonicalIdentityRegistry()),
        );
        const result = operation(prepared.map(({ replay }) => replay));
        for (const journal of prepared) {
          if (!journal.consumed()) {
            throw new Error(
              "canonical journal operation did not consume every replay",
            );
          }
          journal.replay.assertPinned();
        }
        return result;
      }),
    );
  } catch (error) {
    if (!(error instanceof RecoverySourceFailure)) throw error;
    if (
      (typeof error.error === "object" && error.error !== null) ||
      typeof error.error === "function"
    ) {
      recoveryFailureSources.set(error.error, error.source.sourcePath);
    }
    options.onSourceFailure?.(error.source, error.error);
    throw error.error;
  }
}

function prepareRunReplays(
  readers: readonly PinnedReaderEntry[],
  budget: RecoveryReadBudget,
  limits: RecoveryFileLimits,
  createIdentityRegistry: () => RecoveryRunIdentityRegistry,
): readonly PreparedReplay[] {
  const canonicalFirstSource = readers[0]?.source;
  if (canonicalFirstSource === undefined) {
    throw new Error("canonical recovery run has no pinned source");
  }
  let identityRegistry: RecoveryRunIdentityRegistry;
  try {
    identityRegistry = createIdentityRegistry();
  } catch (error) {
    throw mappedIdentityRegistryFailure(
      canonicalFirstSource,
      error,
      "open",
    );
  }

  let prepared: readonly PreparedReplay[] | undefined;
  let preparationError: unknown;
  try {
    prepared = readers.map(({ source, reader }) =>
      prepareReplay(source, reader, budget, limits, identityRegistry),
    );
  } catch (error) {
    preparationError = error;
  }

  let closeFailure: RecoverySourceFailure | undefined;
  try {
    identityRegistry.close();
  } catch (error) {
    closeFailure = mappedIdentityRegistryFailure(
      canonicalFirstSource,
      error,
      "close",
    );
  }
  if (closeFailure !== undefined) {
    if (preparationError !== undefined) {
      throw combinedIdentityRegistryFailure(
        canonicalFirstSource,
        preparationError,
        closeFailure,
      );
    }
    throw closeFailure;
  }
  if (preparationError !== undefined) throw preparationError;
  return prepared!;
}

function mappedIdentityRegistryFailure(
  source: PinnedCanonicalJournalSourceOptions,
  error: unknown,
  phase: "open" | "close",
): RecoverySourceFailure {
  const mapped = mappedSourceFailure(source, error);
  if (mapped.error instanceof RecoveryOperationalError) {
    return new RecoverySourceFailure(
      source,
      operationalErrorWithCause(
        mapped.error.reasonCode,
        mapped.error.message,
        mapped.error.errorClass,
        error,
      ),
    );
  }
  return new RecoverySourceFailure(
    source,
    operationalErrorWithCause(
      "recovery_storage_unavailable",
      `recovery identity registry could not ${phase} for ${source.sourcePath}`,
      `RECOVERY_IDENTITY_REGISTRY_${phase.toUpperCase()}`,
      mapped.error,
    ),
  );
}

function combinedIdentityRegistryFailure(
  source: PinnedCanonicalJournalSourceOptions,
  preparationError: unknown,
  closeFailure: RecoverySourceFailure,
): RecoverySourceFailure {
  const original =
    preparationError instanceof RecoverySourceFailure
      ? preparationError.error
      : preparationError;
  const close = closeFailure.error;
  const operational =
    close instanceof RecoveryOperationalError
      ? close
      : new RecoveryOperationalError(
          "recovery_storage_unavailable",
          `recovery identity registry could not close for ${source.sourcePath}`,
          "RECOVERY_IDENTITY_REGISTRY_CLOSE",
        );
  return new RecoverySourceFailure(
    source,
    operationalErrorWithCause(
      operational.reasonCode,
      `${operational.message}; first-pass validation also failed`,
      operational.errorClass,
      new AggregateError(
        [original, close],
        "canonical recovery validation and identity registry close both failed",
      ),
    ),
  );
}

function operationalErrorWithCause(
  reasonCode: ConstructorParameters<typeof RecoveryOperationalError>[0],
  message: string,
  errorClass: string,
  cause: unknown,
): RecoveryOperationalError {
  const error = new RecoveryOperationalError(reasonCode, message, errorClass);
  Object.defineProperty(error, "cause", {
    configurable: true,
    value: cause,
  });
  return error;
}

export function recoveryFailureSourcePath(error: unknown): string | undefined {
  return (typeof error === "object" && error !== null) ||
    typeof error === "function"
    ? recoveryFailureSources.get(error)
    : undefined;
}

interface PinnedReaderEntry {
  readonly source: PinnedCanonicalJournalSourceOptions;
  readonly reader: PinnedOfflineRolloutReader;
}

interface PreparedReplay {
  readonly replay: PinnedCanonicalJournalReplay;
  readonly consumed: () => boolean;
}

class RecoverySourceFailure {
  constructor(
    readonly source: PinnedCanonicalJournalSourceOptions,
    readonly error: unknown,
  ) {}
}

function sourceOptions(
  options: PinnedCanonicalJournalOptions,
): PinnedCanonicalJournalSourceOptions {
  return {
    projectDir: options.projectDir,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath,
    ...(options.expectedRunId !== undefined
      ? { expectedRunId: options.expectedRunId }
      : {}),
    ...(options.expectedEpoch !== undefined
      ? { expectedEpoch: options.expectedEpoch }
      : {}),
    ...(options.terminalPolicy !== undefined
      ? { terminalPolicy: options.terminalPolicy }
      : {}),
    ...(options.observeValidatedRecord !== undefined
      ? { observeValidatedRecord: options.observeValidatedRecord }
      : {}),
    ...(options.afterValidationPass !== undefined
      ? { afterValidationPass: options.afterValidationPass }
      : {}),
  };
}

function canonicalRecoverySources(
  sources: readonly PinnedCanonicalJournalSourceOptions[],
): readonly PinnedCanonicalJournalSourceOptions[] {
  const canonical = sources.map((source) => {
    const canonicalPath = resolve(source.sourcePath);
    if (canonicalPath !== source.sourcePath) {
      throw new RecoveryOperationalError(
        "recovery_storage_unavailable",
        `canonical recovery source path is not absolute and normalized: ${source.sourcePath}`,
        "RECOVERY_UNSAFE_PATH",
      );
    }
    return { source, comparisonPath: recoveryPathComparisonKey(canonicalPath) };
  });
  canonical.sort((left, right) =>
    compareRecoveryPaths(left.comparisonPath, right.comparisonPath),
  );
  for (let index = 1; index < canonical.length; index += 1) {
    if (
      canonical[index - 1]!.comparisonPath === canonical[index]!.comparisonPath
    ) {
      throw new RecoveryOperationalError(
        "concurrency_limit",
        `canonical recovery source path is duplicated: ${canonical[index]!.source.sourcePath}`,
        "RECOVERY_DUPLICATE_SOURCE_PATH",
      );
    }
  }
  return Object.freeze(canonical.map(({ source }) => source));
}

function recoveryPathComparisonKey(sourcePath: string): string {
  return process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
}

function compareRecoveryPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withPinnedReaders<T>(
  sources: readonly PinnedCanonicalJournalSourceOptions[],
  index: number,
  readers: PinnedReaderEntry[],
  operation: (readers: readonly PinnedReaderEntry[]) => T,
): T {
  const source = sources[index];
  if (source === undefined) return operation(readers);
  try {
    return mapRecoveryFileErrors(source.sourcePath, () =>
      withPinnedOfflineRolloutReadLease(source, (reader) => {
        readers.push({ source, reader });
        try {
          return withPinnedReaders(sources, index + 1, readers, operation);
        } finally {
          readers.pop();
        }
      }),
    );
  } catch (error) {
    if (error instanceof RecoverySourceFailure) throw error;
    throw mappedSourceFailure(source, error);
  }
}

function prepareReplay(
  source: PinnedCanonicalJournalSourceOptions,
  reader: PinnedOfflineRolloutReader,
  budget: RecoveryReadBudget,
  limits: RecoveryFileLimits,
  identityRegistry: CanonicalJournalIdentityRegistry,
): PreparedReplay {
  try {
    const snapshot = reader.stat();
    assertSourceCeilings(snapshot, limits);
    budget.reserveReadBytes(snapshot.size * 2);
    const first = scanStrictPass(reader, snapshot, budget, limits.chunkBytes, {
      ...strictOptions(source, limits, budget.remainingEvents()),
      retainRecords: false,
      identityRegistry,
      ...(source.observeValidatedRecord !== undefined
        ? { onRecord: source.observeValidatedRecord }
        : {}),
    });
    budget.reserveEvents(first.eventCount);
    const proof = journalProof(first, snapshot);
    source.afterValidationPass?.(proof);
    reader.assertSnapshot(snapshot);
    let replayed = false;
    const replay: PinnedCanonicalJournalReplay = Object.freeze({
      proof,
      replay: (onRecord: (record: StrictCanonicalJournalRecord) => void) => {
        if (replayed) {
          throw new Error("canonical journal replay may run only once");
        }
        replayed = true;
        try {
          const second = scanStrictPass(
            reader,
            snapshot,
            budget,
            limits.chunkBytes,
            {
              ...strictOptions(source, limits, proof.eventCount),
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
        } catch (error) {
          throw mappedSourceFailure(source, error);
        }
      },
      assertPinned: () => reader.assertSnapshot(snapshot),
    });
    return { replay, consumed: () => replayed };
  } catch (error) {
    if (error instanceof RecoverySourceFailure) throw error;
    throw mappedSourceFailure(source, error);
  }
}

function mappedSourceFailure(
  source: PinnedCanonicalJournalSourceOptions,
  error: unknown,
): RecoverySourceFailure {
  try {
    return mapRecoveryFileErrors(source.sourcePath, () => {
      throw error;
    });
  } catch (mapped) {
    return new RecoverySourceFailure(source, mapped);
  }
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
  return withPinnedRecoverySourceDigest(options, (digest, assertPinned) => {
    assertPinned();
    return digest;
  });
}

/** Keep the source lease pinned through the caller's evidence transaction. */
export function withPinnedRecoverySourceDigest<T>(
  options: {
    readonly projectDir: string;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly limits?: RecoveryFileLimitOverrides;
    readonly descriptorBudget?: RecoveryDescriptorBudget;
    readonly nowMilliseconds?: () => number;
  },
  operation: (
    digest: StableRecoverySourceDigest,
    assertPinned: () => void,
  ) => T,
): T {
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
        const digest = Object.freeze({
          sourcePath: options.sourcePath,
          sourceSha256: hash.digest("hex"),
          sourceByteLength: snapshot.size,
          sourceMtimeMs: snapshot.mtimeMs,
        });
        const assertPinned = () => reader.assertSnapshot(snapshot);
        const result = operation(digest, assertPinned);
        assertPinned();
        return result;
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
      DEFAULT_MAX_RECOVERY_LINE_BYTES,
      HARD_MAX_RECOVERY_LINE_BYTES,
      "maxLineBytes",
    ),
    maxSourceBytes: boundedLimit(
      overrides.maxSourceBytes,
      DEFAULT_MAX_RECOVERY_SOURCE_BYTES,
      HARD_MAX_RECOVERY_SOURCE_BYTES,
      "maxSourceBytes",
    ),
    maxEvents: boundedLimit(
      overrides.maxEvents,
      DEFAULT_MAX_RECOVERY_EVENTS_PER_RUN,
      HARD_MAX_RECOVERY_EVENTS,
      "maxEvents",
    ),
    maxScanMilliseconds: boundedLimit(
      overrides.maxScanMilliseconds,
      DEFAULT_MAX_STARTUP_RECOVERY_MS,
      HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
      "maxScanMilliseconds",
    ),
    maxReadBytes: boundedLimit(
      overrides.maxReadBytes,
      DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
      HARD_MAX_RECOVERY_STARTUP_READ_BYTES,
      "maxReadBytes",
    ),
    chunkBytes: boundedLimit(
      overrides.chunkBytes,
      RECOVERY_SCAN_CHUNK_BYTES,
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
  maxEvents = limits.maxEvents,
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
    maxEvents,
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
  if (snapshot.size > HARD_MAX_RECOVERY_SOURCE_BYTES) {
    throw new RecoveryOperationalError(
      "startup_byte_budget",
      "canonical recovery source exceeds the hard evidence byte ceiling",
      "RECOVERY_EVIDENCE_HARD_BYTE_CEILING",
    );
  }
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
    if (error instanceof OfflineRolloutDescriptorPathUnavailableError) {
      throw new RecoveryOperationalError(
        "recovery_lock_unavailable",
        `descriptor-relative recovery is unavailable for ${sourcePath}`,
        "RECOVERY_DESCRIPTOR_PATH_UNAVAILABLE",
      );
    }
    if (error instanceof OfflineRolloutUnsafePathError) {
      if (error.message.includes("changed during")) {
        throw new CanonicalJournalIntegrityError(
          "source_changed",
          `canonical journal changed while pinned: ${sourcePath}`,
        );
      }
      throw new RecoveryOperationalError(
        "recovery_storage_unavailable",
        `unsafe canonical recovery storage for ${sourcePath}`,
        "RECOVERY_UNSAFE_PATH",
      );
    }
    if (error instanceof OfflineRolloutSourceMissingError) {
      throw new RecoveryOperationalError(
        "recovery_storage_unavailable",
        `canonical recovery source is missing: ${sourcePath}`,
        "RECOVERY_SOURCE_MISSING",
      );
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new RecoveryOperationalError(
        "recovery_storage_unavailable",
        `canonical recovery storage is missing: ${sourcePath}`,
        "RECOVERY_SOURCE_MISSING",
      );
    }
    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ENOSYS" ||
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "ENODEV" ||
      code === "ESTALE" ||
      code === "EIO" ||
      code === "EROFS" ||
      code === "ENOSPC" ||
      code === "EDQUOT"
    ) {
      throw new RecoveryOperationalError(
        "recovery_storage_unavailable",
        `canonical recovery storage is unavailable for ${sourcePath}`,
        code,
      );
    }
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
  #validatedEvents = 0;

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

  reserveEvents(events: number): void {
    if (!Number.isSafeInteger(events) || events < 0) {
      throw new TypeError("recovery event reservation is invalid");
    }
    if (this.#validatedEvents + events > this.limits.maxEvents) {
      throw new CanonicalJournalIntegrityError(
        "event_limit",
        "canonical recovery exceeds its aggregate event ceiling",
        { observedSequence: this.#validatedEvents + events },
      );
    }
    this.#validatedEvents += events;
    this.checkTime();
  }

  remainingEvents(): number {
    return this.limits.maxEvents - this.#validatedEvents;
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

class DiskCanonicalIdentityRegistry implements RecoveryRunIdentityRegistry {
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
    const failures: unknown[] = [];
    try {
      this.#database.exec("COMMIT");
    } catch (error) {
      failures.push(error);
    }
    try {
      this.#database.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(this.#directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "recovery identity registry cleanup failed at multiple boundaries",
      );
    }
  }

  #claim(kind: number, identity: string): boolean {
    if (this.#closed) throw new Error("recovery identity registry is closed");
    return this.#insert.run(kind, identity).changes === 1;
  }
}

function boundedLimit(
  requested: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string,
): number {
  const value = requested ?? defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}
