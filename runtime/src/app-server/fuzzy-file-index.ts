/**
 * Persistent derived generations for daemon fuzzy-file search.
 *
 * Ripgrep discovers raw path bytes into a private staging generation. Readers
 * continue to use the previous immutable generation until count, byte-count,
 * and digest checks succeed and SQLite atomically advances the root pointer.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
import { getAgenCHomeDir } from "../utils/envUtils.js";
import { gitExe } from "../utils/git.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";
import {
  MAX_FUZZY_CANDIDATES,
  MAX_FUZZY_CANDIDATE_UTF8_BYTES,
  MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
  comparePortablePaths,
  prepareFuzzyCandidate,
  validateFuzzyCandidate,
} from "../search/fuzzy-match.js";
import { selectPinnedRipgrepPath } from "../tools/system/pinned-ripgrep.js";
import {
  assertGrepArgvWithinLimits,
  createRipgrepWireParser,
  renderRipgrepPathBytes,
} from "../tools/system/ripgrep-protocol.js";

export const FUZZY_FILE_INDEX_SCHEMA_VERSION = 2;
export const FUZZY_FILE_INDEX_POLICY_ID = "agenc-fuzzy-files-v2";
export const FUZZY_FILE_INDEX_DIRECTORY = "derived-indexes";
export const FUZZY_FILE_INDEX_FILENAME = "fuzzy-files-v2.sqlite";
export const MAX_FUZZY_INDEXED_ROOTS = 64;
export const FUZZY_INDEX_IDLE_TTL_MS = 1_800_000;

const INDEX_DIRECTORY_MODE = 0o700;
const INDEX_FILE_MODE = 0o600;
export const MAX_FUZZY_INDEX_BUILD_MS = 30_000;
const DISCOVERY_DIAGNOSTIC_BYTES = 131_072;
const DISCOVERY_RESULT_HEADROOM = 1;
const DISCOVERY_BYTE_HEADROOM = 65_536;
const GIT_PROBE_OUTPUT_BYTES = 4_096;
const GIT_TRUE_OUTPUT = "true";
const NUL_BYTE = 0;
const MAX_COMPLETE_GENERATIONS_PER_ROOT = 2;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const INTERRUPTED_BUILD_HEARTBEAT_GRACE_MS = 300_000;
const PUBLISH_SLICE_ENTRIES = 4_096;
const HYDRATION_SLICE_ENTRIES = 512;
const PREPROCESS_HEARTBEAT_INTERVAL_MS = 1_000;
const CLEANUP_BATCH_GENERATIONS = 128;
const HASH_LENGTH_PREFIX_BYTES = 8;
const PATH_SEPARATOR_BYTE = 0x2f;
const WINDOWS_PATH_SEPARATOR_BYTE = 0x5c;
const WINDOWS_PATH_COLON_BYTE = 0x3a;
const CURRENT_DIRECTORY_BYTE = 0x2e;
const ENTRY_TYPE_FILE_TAG = "F";
const ENTRY_TYPE_DIRECTORY_TAG = "D";
const EMPTY_ERROR_TEXT = "";
// Conservative 64-bit V8 accounting: each typed-array allowance includes both
// its view/header and its independently allocated ArrayBuffer header.
const COMPACT_ENTRY_STORE_OBJECT_OVERHEAD_BYTES = 256;
const COMPACT_BUFFER_RETAINED_OVERHEAD_BYTES = 96;
const COMPACT_TYPED_ARRAY_RETAINED_OVERHEAD_BYTES = 128;
const COMPACT_BYTE_ARENA_COUNT = 2;
const COMPACT_TYPED_ARRAY_COUNT = 3;
const FILE_ENTRY_TYPE_CODE = 0;
const DIRECTORY_ENTRY_TYPE_CODE = 1;
const PINNED_RIPGREP_UNAVAILABLE_MESSAGE =
  "pinned ripgrep file discovery is unavailable; run `agenc doctor`, then reinstall the same AgenC version";
const RECOVERABLE_SQLITE_CORRUPTION_CODES = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
]);

export type FuzzyIndexedEntryType = "file" | "directory";
export type FuzzyIndexGenerationState =
  "staging" | "complete" | "failed" | "superseded";

export interface FuzzyIndexedEntry {
  readonly relativePath: string;
  readonly pathBytes: Buffer;
  readonly matchType: FuzzyIndexedEntryType;
}

/** Immutable, allocation-bounded in-memory view of one persisted generation. */
export interface FuzzyIndexEntryStore {
  readonly entryCount: number;
  readonly pathBytes: number;
  readonly candidateBytes: number;
  readonly arenaBackingBytes: number;
  readonly retainedBytes: number;
  relativePathAt(ordinal: number): string;
  pathBytesAt(ordinal: number): Buffer;
  candidateByteLengthAt(ordinal: number): number;
  matchTypeAt(ordinal: number): FuzzyIndexedEntryType;
  pathBytesStartWithAt(ordinal: number, prefix: Buffer): boolean;
  comparePathBytesSliceAt(
    ordinal: number,
    sliceStart: number,
    other: FuzzyIndexEntryStore,
    otherOrdinal: number,
  ): number;
  comparePathBytesAt(
    ordinal: number,
    other: FuzzyIndexEntryStore,
    otherOrdinal: number,
  ): number;
}

export interface FuzzyFileDiscoveryResult {
  /** AgenC-owned immutable store; callers relinquish input ownership at build. */
  readonly entryStore: FuzzyIndexEntryStore;
  readonly truncated: boolean;
  readonly directoryCoverage?: FuzzyDirectoryCoverage;
}

const ownedFuzzyFileDiscoveryResults = new WeakSet<FuzzyFileDiscoveryResult>();

export interface FuzzyFileDiscoveryBatch {
  readonly entries: readonly FuzzyIndexedEntry[];
  readonly truncated: boolean;
  readonly directoryCoverage?: FuzzyDirectoryCoverage;
}

export type FuzzyDirectoryCoverage = "complete" | "nonempty_only";

export interface FuzzyFileDiscoveryOptions {
  /** Test seam for a resolved executable; production uses the cached Git path. */
  readonly gitProgram?: string;
  /** Test seam for global/common-dir ignore fixtures. */
  readonly environment?: NodeJS.ProcessEnv;
}

export type FuzzyFileDiscovery = (
  canonicalRoot: string,
  signal: AbortSignal,
) => Promise<FuzzyFileDiscoveryBatch>;

export interface FuzzyIndexSnapshot {
  readonly rootKey: string;
  readonly canonicalRoot: string;
  readonly generationId: number;
  readonly builtAtMs: number;
  readonly entryCount: number;
  readonly pathBytes: number;
  readonly digest: string;
  readonly truncated: boolean;
  readonly directoryCoverage: FuzzyDirectoryCoverage;
  readonly entryStore: FuzzyIndexEntryStore;
}

/**
 * Conservative retained-byte estimate for the compact generation store.
 * This is intentionally pure so admission can be proven at the named limits
 * without first materializing a million JavaScript entry objects.
 */
export function estimateFuzzyIndexEntryStoreRetainedBytes(
  entryCount: number,
  pathBytes: number,
  candidateBytes: number,
): number {
  validateCompactEntryStoreBounds(entryCount, pathBytes, candidateBytes);
  const offsetEntries = entryCount + 1;
  const offsetBytes =
    offsetEntries * Uint32Array.BYTES_PER_ELEMENT * COMPACT_BYTE_ARENA_COUNT;
  const typeBytes = entryCount * Uint8Array.BYTES_PER_ELEMENT;
  return (
    pathBytes +
    candidateBytes +
    offsetBytes +
    typeBytes +
    COMPACT_BYTE_ARENA_COUNT * COMPACT_BUFFER_RETAINED_OVERHEAD_BYTES +
    COMPACT_TYPED_ARRAY_COUNT * COMPACT_TYPED_ARRAY_RETAINED_OVERHEAD_BYTES +
    COMPACT_ENTRY_STORE_OBJECT_OVERHEAD_BYTES
  );
}

export async function createFuzzyIndexEntryStore(
  entries: readonly FuzzyIndexedEntry[],
  signal: AbortSignal,
): Promise<FuzzyIndexEntryStore> {
  return (
    await normalizeDiscoveredEntries(
      entries,
      signal,
      () => {},
      () => {},
    )
  ).entryStore;
}

/**
 * Transfers a bounded discovery batch into AgenC-owned immutable storage.
 * The caller must not mutate the batch after invoking this function.
 */
export async function createFuzzyFileDiscoveryResult(
  batch: FuzzyFileDiscoveryBatch,
  signal: AbortSignal,
  onEntryStoreMeasured: (retainedBytes: number) => void = () => {},
): Promise<FuzzyFileDiscoveryResult> {
  const truncated = batch.truncated;
  if (typeof truncated !== "boolean") {
    throw new FuzzyIndexBoundaryError(
      "fuzzy-file discovery truncated flag must be boolean",
    );
  }
  const directoryCoverage = validateDirectoryCoverage(
    batch.directoryCoverage ?? "complete",
  );
  const normalized = await normalizeDiscoveredEntries(
    batch.entries,
    signal,
    () => {},
    onEntryStoreMeasured,
  );
  const discovery = Object.freeze({
    entryStore: normalized.entryStore,
    truncated,
    directoryCoverage,
  });
  ownedFuzzyFileDiscoveryResults.add(discovery);
  return discovery;
}

export function assertOwnedFuzzyFileDiscoveryResult(
  discovery: FuzzyFileDiscoveryResult,
): void {
  if (
    !ownedFuzzyFileDiscoveryResults.has(discovery) ||
    !Object.isFrozen(discovery) ||
    !(discovery.entryStore instanceof CompactFuzzyIndexEntryStore)
  ) {
    throw new FuzzyIndexBoundaryError(
      "fuzzy-file discovery must use AgenC-owned immutable storage",
    );
  }
}

class CompactFuzzyIndexEntryStore implements FuzzyIndexEntryStore {
  readonly entryCount: number;
  readonly pathBytes: number;
  readonly candidateBytes: number;
  readonly arenaBackingBytes: number;
  readonly retainedBytes: number;
  readonly #pathArena: Buffer;
  readonly #candidateArena: Buffer;
  readonly #pathOffsets: Uint32Array;
  readonly #candidateOffsets: Uint32Array;
  readonly #entryTypes: Uint8Array;

  constructor(
    pathArena: Buffer,
    candidateArena: Buffer,
    pathOffsets: Uint32Array,
    candidateOffsets: Uint32Array,
    entryTypes: Uint8Array,
  ) {
    this.entryCount = entryTypes.length;
    this.pathBytes = pathArena.byteLength;
    this.candidateBytes = candidateArena.byteLength;
    this.arenaBackingBytes =
      pathArena.buffer.byteLength + candidateArena.buffer.byteLength;
    if (this.arenaBackingBytes !== this.pathBytes + this.candidateBytes) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file compact arenas must use exact unpooled backing storage",
      );
    }
    this.retainedBytes = estimateFuzzyIndexEntryStoreRetainedBytes(
      this.entryCount,
      this.pathBytes,
      this.candidateBytes,
    );
    this.#pathArena = pathArena;
    this.#candidateArena = candidateArena;
    this.#pathOffsets = pathOffsets;
    this.#candidateOffsets = candidateOffsets;
    this.#entryTypes = entryTypes;
    Object.freeze(this);
  }

  relativePathAt(ordinal: number): string {
    this.#assertOrdinal(ordinal);
    return this.#candidateArena.toString(
      "utf8",
      this.#candidateOffsets[ordinal],
      this.#candidateOffsets[ordinal + 1],
    );
  }

  pathBytesAt(ordinal: number): Buffer {
    this.#assertOrdinal(ordinal);
    return Buffer.from(
      this.#pathArena.subarray(
        this.#pathOffsets[ordinal],
        this.#pathOffsets[ordinal + 1],
      ),
    );
  }

  candidateByteLengthAt(ordinal: number): number {
    this.#assertOrdinal(ordinal);
    return (
      this.#candidateOffsets[ordinal + 1]! - this.#candidateOffsets[ordinal]!
    );
  }

  matchTypeAt(ordinal: number): FuzzyIndexedEntryType {
    this.#assertOrdinal(ordinal);
    return this.#entryTypes[ordinal] === FILE_ENTRY_TYPE_CODE
      ? "file"
      : "directory";
  }

  pathBytesStartWithAt(ordinal: number, prefix: Buffer): boolean {
    this.#assertOrdinal(ordinal);
    const start = this.#pathOffsets[ordinal]!;
    const end = this.#pathOffsets[ordinal + 1]!;
    if (end - start < prefix.byteLength) return false;
    for (let index = 0; index < prefix.byteLength; index += 1) {
      if (this.#pathArena[start + index] !== prefix[index]) return false;
    }
    return true;
  }

  comparePathBytesSliceAt(
    ordinal: number,
    sliceStart: number,
    other: FuzzyIndexEntryStore,
    otherOrdinal: number,
  ): number {
    this.#assertOrdinal(ordinal);
    const entryStart = this.#pathOffsets[ordinal]!;
    const end = this.#pathOffsets[ordinal + 1]!;
    if (
      !Number.isSafeInteger(sliceStart) ||
      sliceStart < 0 ||
      sliceStart > end - entryStart
    ) {
      throw new RangeError("fuzzy-file path slice start is outside the entry");
    }
    const start = entryStart + sliceStart;
    if (!(other instanceof CompactFuzzyIndexEntryStore)) {
      return Buffer.compare(
        this.#pathArena.subarray(start, end),
        other.pathBytesAt(otherOrdinal),
      );
    }
    other.#assertOrdinal(otherOrdinal);
    const otherStart = other.#pathOffsets[otherOrdinal]!;
    const otherEnd = other.#pathOffsets[otherOrdinal + 1]!;
    const sharedLength = Math.min(end - start, otherEnd - otherStart);
    for (let index = 0; index < sharedLength; index += 1) {
      const difference =
        this.#pathArena[start + index]! - other.#pathArena[otherStart + index]!;
      if (difference !== 0) return difference;
    }
    return end - start - (otherEnd - otherStart);
  }

  comparePathBytesAt(
    ordinal: number,
    other: FuzzyIndexEntryStore,
    otherOrdinal: number,
  ): number {
    this.#assertOrdinal(ordinal);
    if (!(other instanceof CompactFuzzyIndexEntryStore)) {
      return Buffer.compare(
        this.#pathViewAt(ordinal),
        other.pathBytesAt(otherOrdinal),
      );
    }
    other.#assertOrdinal(otherOrdinal);
    const leftStart = this.#pathOffsets[ordinal]!;
    const leftEnd = this.#pathOffsets[ordinal + 1]!;
    const rightStart = other.#pathOffsets[otherOrdinal]!;
    const rightEnd = other.#pathOffsets[otherOrdinal + 1]!;
    const sharedLength = Math.min(leftEnd - leftStart, rightEnd - rightStart);
    for (let index = 0; index < sharedLength; index += 1) {
      const difference =
        this.#pathArena[leftStart + index]! -
        other.#pathArena[rightStart + index]!;
      if (difference !== 0) return difference;
    }
    return leftEnd - leftStart - (rightEnd - rightStart);
  }

  #pathViewAt(ordinal: number): Buffer {
    this.#assertOrdinal(ordinal);
    return this.#pathArena.subarray(
      this.#pathOffsets[ordinal],
      this.#pathOffsets[ordinal + 1],
    );
  }

  #assertOrdinal(ordinal: number): void {
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= this.entryCount
    ) {
      throw new RangeError(
        `fuzzy-file entry ordinal must be in [0, ${this.entryCount})`,
      );
    }
  }
}

class CompactFuzzyIndexEntryStoreBuilder {
  readonly #pathArena: Buffer;
  readonly #candidateArena: Buffer;
  readonly #pathOffsets: Uint32Array;
  readonly #candidateOffsets: Uint32Array;
  readonly #entryTypes: Uint8Array;
  #entryCount = 0;
  #pathOffset = 0;
  #candidateOffset = 0;

  constructor(entryCount: number, pathBytes: number, candidateBytes: number) {
    validateCompactEntryStoreBounds(entryCount, pathBytes, candidateBytes);
    this.#pathArena = Buffer.allocUnsafeSlow(pathBytes);
    this.#candidateArena = Buffer.allocUnsafeSlow(candidateBytes);
    this.#pathOffsets = new Uint32Array(entryCount + 1);
    this.#candidateOffsets = new Uint32Array(entryCount + 1);
    this.#entryTypes = new Uint8Array(entryCount);
  }

  add(entry: FuzzyIndexedEntry, requireSorted = false): void {
    if (this.#entryCount >= this.#entryTypes.length) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file entry store received too many entries",
      );
    }
    const candidate = Buffer.from(entry.relativePath, "utf8");
    if (requireSorted && this.#entryCount > 0) {
      const previousStart = this.#pathOffsets[this.#entryCount - 1]!;
      const previousEnd = this.#pathOffsets[this.#entryCount]!;
      const previous = this.#pathArena.subarray(previousStart, previousEnd);
      const order = Buffer.compare(previous, entry.pathBytes);
      if (order >= 0) {
        throw new FuzzyIndexBoundaryError(
          order === 0
            ? `fuzzy-file generation contains duplicate path bytes for '${entry.relativePath}'`
            : "fuzzy-file generation changed while it was being normalized",
        );
      }
    }
    const nextPathOffset = this.#pathOffset + entry.pathBytes.byteLength;
    const nextCandidateOffset = this.#candidateOffset + candidate.byteLength;
    if (
      nextPathOffset > this.#pathArena.byteLength ||
      nextCandidateOffset > this.#candidateArena.byteLength
    ) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file entry store exceeded its validated byte bounds",
      );
    }
    entry.pathBytes.copy(this.#pathArena, this.#pathOffset);
    candidate.copy(this.#candidateArena, this.#candidateOffset);
    this.#pathOffset = nextPathOffset;
    this.#candidateOffset = nextCandidateOffset;
    this.#entryCount += 1;
    this.#pathOffsets[this.#entryCount] = this.#pathOffset;
    this.#candidateOffsets[this.#entryCount] = this.#candidateOffset;
    this.#entryTypes[this.#entryCount - 1] =
      entry.matchType === "file"
        ? FILE_ENTRY_TYPE_CODE
        : DIRECTORY_ENTRY_TYPE_CODE;
  }

  finish(): CompactFuzzyIndexEntryStore {
    if (
      this.#entryCount !== this.#entryTypes.length ||
      this.#pathOffset !== this.#pathArena.byteLength ||
      this.#candidateOffset !== this.#candidateArena.byteLength
    ) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file entry store did not match its validated bounds",
      );
    }
    return new CompactFuzzyIndexEntryStore(
      this.#pathArena,
      this.#candidateArena,
      this.#pathOffsets,
      this.#candidateOffsets,
      this.#entryTypes,
    );
  }
}

export interface PersistentFuzzyFileIndexOptions {
  readonly databasePath?: string;
  readonly now?: () => number;
  readonly idleTtlMs?: number;
}

interface GenerationRow {
  readonly id: number;
  readonly root_key: string;
  readonly canonical_root: string;
  readonly state: FuzzyIndexGenerationState;
  readonly completed_at_ms: number | null;
  readonly entry_count: number | null;
  readonly path_bytes: number | null;
  readonly digest: string | null;
  readonly truncated: number;
  readonly source_boundary: string;
  readonly directory_coverage: FuzzyDirectoryCoverage;
}

interface EntryRow {
  readonly relative_path: string;
  readonly path_bytes: Buffer;
  readonly entry_type: FuzzyIndexedEntryType;
  readonly fingerprint: string;
}

interface GenerationEntryLengthRow {
  readonly ordinal: number;
  readonly path_bytes: number;
  readonly candidate_bytes: number;
}

export class FuzzyIndexBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FuzzyIndexBoundaryError";
  }
}

export class FuzzyIndexBuildCancelledError extends Error {
  constructor() {
    super("fuzzy-file index build was cancelled");
    this.name = "FuzzyIndexBuildCancelledError";
  }
}

export class FuzzyIndexSchemaError extends Error {
  constructor(found: number) {
    super(
      `fuzzy-file index schema ${found} is incompatible with ${FUZZY_FILE_INDEX_SCHEMA_VERSION}`,
    );
    this.name = "FuzzyIndexSchemaError";
  }
}

export class FuzzyIndexSourceChangedError extends Error {
  constructor() {
    super("fuzzy-file source changed before generation publication");
    this.name = "FuzzyIndexSourceChangedError";
  }
}

export interface FuzzyIndexPublicationOptions {
  readonly sourceBoundary?: string;
  readonly isSourceBoundaryCurrent?: () => boolean;
}

export class PersistentFuzzyFileIndex {
  readonly databasePath: string;
  readonly #db: BetterSqlite3.Database;
  readonly #now: () => number;
  readonly #idleTtlMs: number;

  constructor(options: PersistentFuzzyFileIndexOptions = {}) {
    this.databasePath =
      options.databasePath ?? resolveDefaultFuzzyFileIndexPath();
    this.#now = options.now ?? Date.now;
    this.#idleTtlMs = validateIdleTtlMs(
      options.idleTtlMs ?? FUZZY_INDEX_IDLE_TTL_MS,
    );
    const directory = dirname(this.databasePath);
    mkdirSync(directory, { recursive: true, mode: INDEX_DIRECTORY_MODE });
    chmodSync(directory, INDEX_DIRECTORY_MODE);
    this.#db = new Database(this.databasePath);
    try {
      configureDatabase(this.#db);
      initializeSchema(this.#db);
      chmodSync(this.databasePath, INDEX_FILE_MODE);
      this.#db
        .transaction(() => this.#reapExpiredStaging(this.#now()))
        .immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    if (this.#db.open) this.#db.close();
  }

  async readCurrent(
    canonicalRoot: string,
    signal: AbortSignal = new AbortController().signal,
    onEntryStoreMeasured?: (retainedBytes: number) => void,
  ): Promise<FuzzyIndexSnapshot | null> {
    throwIfCancelled(signal);
    const rootKey = fuzzyIndexRootKey(canonicalRoot);
    const row = this.#db
      .prepare<[string], GenerationRow>(
        `SELECT g.id, g.root_key, r.canonical_root, g.state,
                g.completed_at_ms, g.entry_count, g.path_bytes, g.digest,
                g.truncated, g.source_boundary
                , g.directory_coverage
           FROM fuzzy_index_roots r
           JOIN fuzzy_index_generations g ON g.id = r.current_generation_id
          WHERE r.root_key = ? AND g.state = 'complete'`,
      )
      .get(rootKey);
    if (row === undefined) return null;
    this.#touchRoot(rootKey);
    if (!generationHeaderBoundsAreValid(row)) {
      this.#invalidateGeneration(row.id, rootKey, "invalid generation bounds");
      return null;
    }
    const loaded = await this.#readGenerationEntries(
      row.id,
      row.entry_count,
      row.path_bytes,
      row.directory_coverage,
      row.canonical_root,
      row.source_boundary,
      signal,
      onEntryStoreMeasured,
    );
    const integrity = loaded.integrity;
    if (
      loaded.entryStore === null ||
      integrity === null ||
      row.completed_at_ms === null ||
      row.entry_count !== integrity.entryCount ||
      row.path_bytes !== integrity.pathBytes ||
      row.digest !== integrity.digest ||
      !loaded.fingerprintsValid
    ) {
      this.#invalidateGeneration(row.id, rootKey, "integrity mismatch");
      return null;
    }
    return Object.freeze({
      rootKey,
      canonicalRoot: row.canonical_root,
      generationId: row.id,
      builtAtMs: row.completed_at_ms,
      entryCount: integrity.entryCount,
      pathBytes: integrity.pathBytes,
      digest: integrity.digest,
      truncated: row.truncated !== 0,
      directoryCoverage: row.directory_coverage,
      entryStore: loaded.entryStore,
    });
  }

  async publish(
    canonicalRoot: string,
    discovery: FuzzyFileDiscoveryResult,
    signal: AbortSignal,
    options: FuzzyIndexPublicationOptions = {},
  ): Promise<FuzzyIndexSnapshot | null> {
    throwIfCancelled(signal);
    assertOwnedFuzzyFileDiscoveryResult(discovery);
    if (discovery.truncated) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file discovery reached a bound; refusing to publish a prefix",
      );
    }
    const rootKey = fuzzyIndexRootKey(canonicalRoot);
    const directoryCoverage = validateDirectoryCoverage(
      discovery.directoryCoverage ?? "complete",
    );
    const sourceBoundary = options.sourceBoundary ?? "unobserved";
    const generationId = this.#beginGeneration(
      rootKey,
      canonicalRoot,
      sourceBoundary,
      directoryCoverage,
    );
    try {
      const heartbeat = this.#generationHeartbeat(generationId);
      const entryStore = discovery.entryStore;
      const integrity = await describeEntryStore(
        entryStore,
        directoryCoverage,
        canonicalRoot,
        sourceBoundary,
        generationId,
        signal,
        heartbeat,
      );
      const insert = this.#db.prepare<
        [number, number, string, Buffer, string, string]
      >(
        `INSERT INTO fuzzy_index_entries
           (generation_id, ordinal, relative_path, path_bytes, entry_type,
            fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const updateProgress = this.#db.prepare<[number, number, number, number]>(
        `UPDATE fuzzy_index_generations
            SET inserted_count = ?, inserted_path_bytes = ?, heartbeat_at_ms = ?
          WHERE id = ? AND state = 'staging'`,
      );
      let insertedPathBytes = 0;
      for (
        let sliceStart = 0;
        sliceStart < entryStore.entryCount;
        sliceStart += PUBLISH_SLICE_ENTRIES
      ) {
        const sliceEnd = Math.min(
          entryStore.entryCount,
          sliceStart + PUBLISH_SLICE_ENTRIES,
        );
        this.#db
          .transaction(() => {
            for (let ordinal = sliceStart; ordinal < sliceEnd; ordinal += 1) {
              const entry = indexedEntryAt(entryStore, ordinal);
              throwIfCancelled(signal);
              insertedPathBytes += entry.pathBytes.byteLength;
              insert.run(
                generationId,
                ordinal,
                entry.relativePath,
                entry.pathBytes,
                entry.matchType,
                fingerprintEntry(entry, canonicalRoot),
              );
            }
            updateProgress.run(
              sliceEnd,
              insertedPathBytes,
              this.#now(),
              generationId,
            );
          })
          .immediate();
        if (sliceEnd < entryStore.entryCount) await yieldToEventLoop();
      }
      if (entryStore.entryCount === 0) {
        this.#db
          .transaction(() => {
            throwIfCancelled(signal);
            updateProgress.run(0, 0, this.#now(), generationId);
          })
          .immediate();
      }
      throwIfCancelled(signal);
      if (options.isSourceBoundaryCurrent?.() === false) {
        throw new FuzzyIndexSourceChangedError();
      }
      const completedAtMs = this.#completeGeneration(
        generationId,
        rootKey,
        integrity,
        discovery.truncated,
      );
      this.#pruneRoot(rootKey);
      return Object.freeze({
        rootKey,
        canonicalRoot,
        generationId,
        builtAtMs: completedAtMs,
        entryCount: integrity.entryCount,
        pathBytes: integrity.pathBytes,
        digest: integrity.digest,
        truncated: discovery.truncated,
        directoryCoverage,
        entryStore,
      });
    } catch (error) {
      this.#failGeneration(generationId, rootKey, errorMessage(error));
      throw error;
    }
  }

  #beginGeneration(
    rootKey: string,
    canonicalRoot: string,
    sourceBoundary: string,
    directoryCoverage: FuzzyDirectoryCoverage,
  ): number {
    const startedAtMs = this.#now();
    const transaction = this.#db.transaction(() => {
      this.#reapExpiredStaging(startedAtMs);
      this.#evictExpiredRoots(rootKey, startedAtMs);
      const rootExists = this.#db
        .prepare<[string], { readonly present: number }>(
          "SELECT 1 AS present FROM fuzzy_index_roots WHERE root_key = ?",
        )
        .get(rootKey);
      if (rootExists === undefined) {
        const rootCount = this.#db
          .prepare<[], { readonly count: number }>(
            "SELECT count(*) AS count FROM fuzzy_index_roots",
          )
          .get()?.count;
        if (
          rootCount === undefined ||
          (rootCount >= MAX_FUZZY_INDEXED_ROOTS &&
            !this.#evictLeastRecentlyUsedRoot(rootKey))
        ) {
          throw new FuzzyIndexBoundaryError(
            `persistent fuzzy-file roots reached ${MAX_FUZZY_INDEXED_ROOTS}`,
          );
        }
      }
      this.#db
        .prepare<[string, string, string, number]>(
          `INSERT INTO fuzzy_index_roots
             (root_key, canonical_root, policy_id, current_generation_id,
              last_access_at_ms)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(root_key) DO UPDATE SET
             canonical_root = excluded.canonical_root,
             policy_id = excluded.policy_id,
             last_access_at_ms = excluded.last_access_at_ms`,
        )
        .run(rootKey, canonicalRoot, FUZZY_FILE_INDEX_POLICY_ID, startedAtMs);
      const result = this.#db
        .prepare<[string, number, string, string, number]>(
          `INSERT INTO fuzzy_index_generations
              (root_key, state, started_at_ms, truncated, source_boundary,
              directory_coverage, inserted_count, inserted_path_bytes,
              heartbeat_at_ms, error_text)
           VALUES (?, 'staging', ?, 0, ?, ?, 0, 0, ?, '')`,
        )
        .run(
          rootKey,
          startedAtMs,
          sourceBoundary,
          directoryCoverage,
          startedAtMs,
        );
      const generationId = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(generationId) || generationId <= 0) {
        throw new FuzzyIndexBoundaryError(
          "fuzzy-file generation identifier exceeded JavaScript integer bounds",
        );
      }
      return generationId;
    });
    return transaction.immediate();
  }

  #generationHeartbeat(generationId: number): () => void {
    let lastHeartbeatAtMs: number | null = null;
    const update = this.#db.prepare<[number, number]>(
      `UPDATE fuzzy_index_generations SET heartbeat_at_ms = ?
        WHERE id = ? AND state = 'staging'`,
    );
    return (): void => {
      const nowMs = this.#now();
      if (
        lastHeartbeatAtMs !== null &&
        nowMs - lastHeartbeatAtMs < PREPROCESS_HEARTBEAT_INTERVAL_MS
      ) {
        return;
      }
      if (update.run(nowMs, generationId).changes !== 1) {
        throw new FuzzyIndexSourceChangedError();
      }
      lastHeartbeatAtMs = nowMs;
    };
  }

  #completeGeneration(
    generationId: number,
    rootKey: string,
    integrity: EntryIntegrity,
    truncated: boolean,
  ): number {
    return this.#db
      .transaction(() => {
        const newest = this.#db
          .prepare<[string], { readonly id: number }>(
            `SELECT id FROM fuzzy_index_generations
            WHERE root_key = ?
            ORDER BY id DESC LIMIT 1`,
          )
          .get(rootKey);
        if (newest?.id !== generationId) {
          this.#db
            .prepare<[number, number]>(
              `UPDATE fuzzy_index_generations
                SET state = 'superseded', completed_at_ms = ?,
                    error_text = 'newer generation exists'
              WHERE id = ?`,
            )
            .run(this.#now(), generationId);
          throw new FuzzyIndexSourceChangedError();
        }
        const completedAtMs = this.#now();
        const completion = this.#db
          .prepare<
            [number, number, number, string, number, number, number, number]
          >(
            `UPDATE fuzzy_index_generations
              SET state = 'complete', completed_at_ms = ?, entry_count = ?,
                  path_bytes = ?, digest = ?, truncated = ?, error_text = ''
            WHERE id = ? AND state = 'staging'
              AND inserted_count = ? AND inserted_path_bytes = ?`,
          )
          .run(
            completedAtMs,
            integrity.entryCount,
            integrity.pathBytes,
            integrity.digest,
            truncated ? 1 : 0,
            generationId,
            integrity.entryCount,
            integrity.pathBytes,
          );
        if (completion.changes !== 1) {
          throw new Error(
            `fuzzy-file staging generation ${generationId} changed state before publication`,
          );
        }
        this.#db
          .prepare<[number, number, string]>(
            `UPDATE fuzzy_index_roots
              SET current_generation_id = ?, last_access_at_ms = ?
            WHERE root_key = ?`,
          )
          .run(generationId, completedAtMs, rootKey);
        return completedAtMs;
      })
      .immediate();
  }

  async #readGenerationEntries(
    generationId: number,
    declaredEntryCount: number,
    declaredPathBytes: number,
    directoryCoverage: FuzzyDirectoryCoverage,
    canonicalRoot: string,
    sourceBoundary: string,
    signal: AbortSignal,
    onEntryStoreMeasured: ((retainedBytes: number) => void) | undefined,
  ): Promise<{
    readonly entryStore: FuzzyIndexEntryStore | null;
    readonly integrity: EntryIntegrity | null;
    readonly fingerprintsValid: boolean;
  }> {
    const hasNegativeOrdinal =
      this.#db
        .prepare<[number], { readonly present: number }>(
          `SELECT 1 AS present FROM fuzzy_index_entries
            WHERE generation_id = ? AND ordinal < 0 LIMIT 1`,
        )
        .get(generationId) !== undefined;
    if (hasNegativeOrdinal) return invalidLoadedGeneration();
    const readLengthSlice = this.#db.prepare<
      [number, number, number],
      GenerationEntryLengthRow
    >(
      `SELECT ordinal, length(path_bytes) AS path_bytes,
              length(CAST(relative_path AS BLOB)) AS candidate_bytes
         FROM fuzzy_index_entries
        WHERE generation_id = ? AND ordinal >= ?
        ORDER BY ordinal LIMIT ?`,
    );
    let measuredEntryCount = 0;
    let measuredPathBytes = 0;
    let measuredCandidateBytes = 0;
    while (measuredEntryCount < declaredEntryCount) {
      throwIfCancelled(signal);
      const rows = readLengthSlice.all(
        generationId,
        measuredEntryCount,
        HYDRATION_SLICE_ENTRIES,
      );
      if (rows.length === 0) {
        return invalidLoadedGeneration();
      }
      for (const row of rows) {
        throwIfCancelled(signal);
        if (
          measuredEntryCount >= declaredEntryCount ||
          row.ordinal !== measuredEntryCount ||
          !Number.isSafeInteger(row.path_bytes) ||
          row.path_bytes < 0 ||
          !Number.isSafeInteger(row.candidate_bytes) ||
          row.candidate_bytes < 0 ||
          row.candidate_bytes > MAX_FUZZY_CANDIDATE_UTF8_BYTES ||
          !boundedCompactByteSum(measuredPathBytes, row.path_bytes) ||
          !boundedCompactByteSum(measuredCandidateBytes, row.candidate_bytes)
        ) {
          return invalidLoadedGeneration();
        }
        measuredEntryCount += 1;
        measuredPathBytes += row.path_bytes;
        measuredCandidateBytes += row.candidate_bytes;
      }
      if (measuredEntryCount < declaredEntryCount) await yieldToEventLoop();
    }
    if (
      measuredPathBytes !== declaredPathBytes ||
      readLengthSlice.all(generationId, declaredEntryCount, 1).length !== 0
    ) {
      return invalidLoadedGeneration();
    }
    onEntryStoreMeasured?.(
      estimateFuzzyIndexEntryStoreRetainedBytes(
        measuredEntryCount,
        measuredPathBytes,
        measuredCandidateBytes,
      ),
    );
    let fingerprintsValid = true;
    const builder = new CompactFuzzyIndexEntryStoreBuilder(
      measuredEntryCount,
      measuredPathBytes,
      measuredCandidateBytes,
    );
    const integrityHash = createEntryIntegrityHash(
      directoryCoverage,
      canonicalRoot,
      sourceBoundary,
      generationId,
    );
    let entryCount = 0;
    let pathBytes = 0;
    const readSlice = this.#db.prepare<
      [number, number, number],
      EntryRow & { readonly ordinal: number }
    >(
      `SELECT ordinal, relative_path, path_bytes, entry_type, fingerprint
         FROM fuzzy_index_entries
        WHERE generation_id = ? AND ordinal >= ?
        ORDER BY ordinal LIMIT ?`,
    );
    try {
      while (entryCount < measuredEntryCount) {
        throwIfCancelled(signal);
        const rows = readSlice.all(
          generationId,
          entryCount,
          HYDRATION_SLICE_ENTRIES,
        );
        if (rows.length === 0) {
          throw new FuzzyIndexBoundaryError(
            "fuzzy-file generation ended before its declared entry count",
          );
        }
        for (const row of rows) {
          throwIfCancelled(signal);
          if (row.ordinal !== entryCount) {
            throw new FuzzyIndexBoundaryError(
              "fuzzy-file generation contains a non-contiguous ordinal",
            );
          }
          const entry = Object.freeze({
            relativePath: row.relative_path,
            pathBytes: Buffer.from(row.path_bytes),
            matchType: row.entry_type,
          });
          const fingerprint = fingerprintEntry(entry, canonicalRoot);
          if (row.fingerprint !== fingerprint) {
            fingerprintsValid = false;
          }
          builder.add(entry);
          addEntryIntegrity(
            integrityHash,
            fingerprint,
            entry.pathBytes.byteLength,
          );
          entryCount += 1;
          pathBytes += entry.pathBytes.byteLength;
        }
        if (entryCount < measuredEntryCount) await yieldToEventLoop();
      }
      return {
        entryStore: builder.finish(),
        integrity: finishEntryIntegrity(integrityHash, entryCount, pathBytes),
        fingerprintsValid,
      };
    } catch (error) {
      if (error instanceof FuzzyIndexBuildCancelledError) throw error;
      return {
        entryStore: null,
        integrity: null,
        fingerprintsValid: false,
      };
    }
  }

  #invalidateGeneration(
    generationId: number,
    rootKey: string,
    reason: string,
  ): void {
    this.#db
      .transaction(() => {
        this.#db
          .prepare<[string, number]>(
            `UPDATE fuzzy_index_roots SET current_generation_id = NULL
            WHERE root_key = ? AND current_generation_id = ?`,
          )
          .run(rootKey, generationId);
        this.#db
          .prepare<[number, string, number]>(
            `UPDATE fuzzy_index_generations
              SET state = 'failed', completed_at_ms = ?, error_text = ?
            WHERE id = ?`,
          )
          .run(this.#now(), reason, generationId);
      })
      .immediate();
  }

  #failGeneration(
    generationId: number,
    rootKey: string,
    message: string,
  ): void {
    this.#db
      .prepare<[number, string, number]>(
        `UPDATE fuzzy_index_generations
            SET state = 'failed', completed_at_ms = ?, error_text = ?
          WHERE id = ? AND state = 'staging'`,
      )
      .run(this.#now(), boundedErrorText(message), generationId);
    this.#pruneRoot(rootKey);
  }

  #reapExpiredStaging(nowMs: number): void {
    const expiredBeforeMs = nowMs - INTERRUPTED_BUILD_HEARTBEAT_GRACE_MS;
    this.#db
      .prepare<[number, number]>(
        `UPDATE fuzzy_index_generations
            SET state = 'failed', completed_at_ms = ?,
                error_text = 'interrupted before publication'
          WHERE state = 'staging' AND heartbeat_at_ms <= ?`,
      )
      .run(nowMs, expiredBeforeMs);
  }

  #touchRoot(rootKey: string): void {
    this.#db
      .prepare<[number, string]>(
        `UPDATE fuzzy_index_roots SET last_access_at_ms = ?
          WHERE root_key = ?`,
      )
      .run(this.#now(), rootKey);
  }

  #evictExpiredRoots(excludedRootKey: string, nowMs: number): void {
    const expiredBeforeMs = nowMs - this.#idleTtlMs;
    this.#db
      .prepare<[string, number]>(
        `DELETE FROM fuzzy_index_roots AS r
          WHERE r.root_key != ? AND r.last_access_at_ms <= ?
            AND NOT EXISTS (
              SELECT 1 FROM fuzzy_index_generations AS g
               WHERE g.root_key = r.root_key AND g.state = 'staging'
            )`,
      )
      .run(excludedRootKey, expiredBeforeMs);
  }

  #evictLeastRecentlyUsedRoot(excludedRootKey: string): boolean {
    const candidate = this.#db
      .prepare<[string], { readonly root_key: string }>(
        `SELECT r.root_key
           FROM fuzzy_index_roots AS r
          WHERE r.root_key != ?
            AND NOT EXISTS (
              SELECT 1 FROM fuzzy_index_generations AS g
               WHERE g.root_key = r.root_key AND g.state = 'staging'
            )
          ORDER BY r.last_access_at_ms, r.root_key
          LIMIT 1`,
      )
      .get(excludedRootKey);
    if (candidate === undefined) return false;
    return (
      this.#db
        .prepare<[string]>("DELETE FROM fuzzy_index_roots WHERE root_key = ?")
        .run(candidate.root_key).changes === 1
    );
  }

  #pruneRoot(rootKey: string): void {
    const retained = this.#db
      .prepare<[string, number], { readonly id: number }>(
        `SELECT id FROM fuzzy_index_generations
          WHERE root_key = ? AND state = 'complete'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(rootKey, MAX_COMPLETE_GENERATIONS_PER_ROOT)
      .map((row) => row.id);
    const current = this.#db
      .prepare<[string], { readonly current_generation_id: number | null }>(
        `SELECT current_generation_id FROM fuzzy_index_roots WHERE root_key = ?`,
      )
      .get(rootKey)?.current_generation_id;
    const protectedIds = new Set(retained);
    if (current !== null && current !== undefined) protectedIds.add(current);
    const candidates = this.#db
      .prepare<
        [string, number],
        { readonly id: number; readonly state: FuzzyIndexGenerationState }
      >(
        `SELECT id, state FROM fuzzy_index_generations
          WHERE root_key = ? AND state != 'staging'
          ORDER BY id LIMIT ?`,
      )
      .all(rootKey, CLEANUP_BATCH_GENERATIONS);
    const remove = this.#db.prepare<[number]>(
      "DELETE FROM fuzzy_index_generations WHERE id = ?",
    );
    this.#db
      .transaction(() => {
        for (const candidate of candidates) {
          if (candidate.state === "staging") continue;
          if (!protectedIds.has(candidate.id)) remove.run(candidate.id);
        }
      })
      .immediate();
  }
}

export function resolveDefaultFuzzyFileIndexPath(): string {
  return join(
    getAgenCHomeDir(),
    FUZZY_FILE_INDEX_DIRECTORY,
    FUZZY_FILE_INDEX_FILENAME,
  );
}

export function openPersistentFuzzyFileIndex(
  options: PersistentFuzzyFileIndexOptions = {},
): PersistentFuzzyFileIndex {
  const databasePath =
    options.databasePath ?? resolveDefaultFuzzyFileIndexPath();
  try {
    return new PersistentFuzzyFileIndex({ ...options, databasePath });
  } catch (error) {
    if (
      !existsSync(databasePath) ||
      (!isRecoverableSqliteCorruption(error) &&
        !(error instanceof FuzzyIndexSchemaError))
    ) {
      throw error;
    }
    quarantineCorruptDatabase(databasePath);
    return new PersistentFuzzyFileIndex({ ...options, databasePath });
  }
}

export async function canonicalizeFuzzyIndexRoot(
  root: string,
): Promise<string> {
  const absolute = resolve(root);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export function fuzzyIndexRootKey(canonicalRoot: string): string {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, Buffer.from(FUZZY_FILE_INDEX_POLICY_ID, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from(String(FUZZY_FILE_INDEX_SCHEMA_VERSION), "utf8"),
  );
  updateLengthPrefixed(hash, Buffer.from(canonicalRoot, "utf8"));
  return hash.digest("hex");
}

async function discoverFuzzyFilesWithGit(
  canonicalRoot: string,
  signal: AbortSignal,
  options: FuzzyFileDiscoveryOptions,
): Promise<FuzzyFileDiscoveryBatch | null> {
  const deadline = performance.now() + MAX_FUZZY_INDEX_BUILD_MS;
  const program = options.gitProgram ?? gitExe();
  const environment = fuzzyGitEnvironment(options.environment ?? process.env);
  const probe = await runFuzzyGitCommand(
    program,
    ["rev-parse", "--is-inside-work-tree"],
    canonicalRoot,
    environment,
    signal,
    deadline,
    GIT_PROBE_OUTPUT_BYTES,
    true,
  );
  if (probe === null || probe.toString("utf8").trim() !== GIT_TRUE_OUTPUT) {
    return null;
  }

  const deleted = parseNulPathRecords(
    await runRequiredFuzzyGitCommand(
      program,
      ["ls-files", "-z", "--deleted", "--", "."],
      canonicalRoot,
      environment,
      signal,
      deadline,
    ),
  );
  const deletedKeys = new Set(deleted.map((path) => path.toString("hex")));
  const files = parseNulPathRecords(
    await runRequiredFuzzyGitCommand(
      program,
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ".",
      ],
      canonicalRoot,
      environment,
      signal,
      deadline,
    ),
  ).filter((path) => !deletedKeys.has(path.toString("hex")));
  const directories = parseNulPathRecords(
    await runRequiredFuzzyGitCommand(
      program,
      [
        "ls-files",
        "-z",
        "--others",
        "--directory",
        "--exclude-standard",
        "--",
        ".",
      ],
      canonicalRoot,
      environment,
      signal,
      deadline,
    ),
  )
    .filter(isGitDirectoryRecord)
    .map(stripGitDirectorySuffix);
  return entriesFromDiscoveredPaths(
    files,
    directories,
    process.platform,
    // Git cannot represent a now-empty directory whose last tracked file was
    // deleted, so this surface is intentionally honest about partial empty-
    // directory coverage even though it includes visible untracked empties.
    "nonempty_only",
  );
}

async function runRequiredFuzzyGitCommand(
  program: string,
  args: readonly string[],
  canonicalRoot: string,
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  deadline: number,
): Promise<Buffer> {
  const output = await runFuzzyGitCommand(
    program,
    args,
    canonicalRoot,
    environment,
    signal,
    deadline,
    MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES + DISCOVERY_BYTE_HEADROOM,
    false,
  );
  if (output === null) {
    throw new Error("Git file discovery failed after repository recognition");
  }
  return output;
}

async function runFuzzyGitCommand(
  program: string,
  args: readonly string[],
  canonicalRoot: string,
  environment: Readonly<Record<string, string>>,
  signal: AbortSignal,
  deadline: number,
  maxStdoutBytes: number,
  allowFailure: boolean,
): Promise<Buffer | null> {
  throwIfCancelled(signal);
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) {
    throw new FuzzyIndexBoundaryError(
      `Git file discovery exceeded ${MAX_FUZZY_INDEX_BUILD_MS}ms`,
    );
  }
  const result = await runSupervisedProcess(
    { program, args, cwd: canonicalRoot, env: environment },
    {
      timeoutMs: remainingMs,
      maxOutputBytes: maxStdoutBytes + DISCOVERY_DIAGNOSTIC_BYTES,
      signal,
    },
  );
  if (signal.aborted || result.stopReason === "aborted") {
    throw new FuzzyIndexBuildCancelledError();
  }
  if (result.error !== undefined) {
    if (allowFailure) return null;
    throw result.error;
  }
  if (result.stopReason !== undefined) {
    throw new FuzzyIndexBoundaryError(
      `Git file discovery stopped: ${result.stopReason}`,
    );
  }
  if (result.stdout.byteLength > maxStdoutBytes) {
    throw new FuzzyIndexBoundaryError(
      `Git file discovery exceeded ${maxStdoutBytes} output bytes`,
    );
  }
  if (result.exitCode !== 0) {
    if (allowFailure) return null;
    throw new Error(
      `Git file discovery exited ${result.exitCode}: ${boundedErrorText(result.stderr.toString("utf8"))}`,
    );
  }
  return result.stdout;
}

function fuzzyGitEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const environment = scrubEnvForChildProcess(source);
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function parseNulPathRecords(output: Buffer): readonly Buffer[] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== NUL_BYTE) {
    throw new FuzzyIndexBoundaryError(
      "Git file discovery returned an unterminated path record",
    );
  }
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== NUL_BYTE) continue;
    if (index > start) {
      if (records.length >= MAX_FUZZY_CANDIDATES + DISCOVERY_RESULT_HEADROOM) {
        throw new FuzzyIndexBoundaryError(
          `Git file discovery exceeded ${MAX_FUZZY_CANDIDATES} paths`,
        );
      }
      records.push(Buffer.from(output.subarray(start, index)));
    }
    start = index + 1;
  }
  return records;
}

function stripGitDirectorySuffix(path: Buffer): Buffer {
  return Buffer.from(path.subarray(0, path.byteLength - 1));
}

function isGitDirectoryRecord(path: Buffer): boolean {
  return path[path.byteLength - 1] === PATH_SEPARATOR_BYTE;
}

export async function discoverFuzzyFiles(
  canonicalRoot: string,
  signal: AbortSignal,
  options: FuzzyFileDiscoveryOptions = {},
): Promise<FuzzyFileDiscoveryBatch> {
  const gitDiscovery = await discoverFuzzyFilesWithGit(
    canonicalRoot,
    signal,
    options,
  );
  return gitDiscovery ?? discoverFuzzyFilesWithRipgrep(canonicalRoot, signal);
}

export async function discoverFuzzyFilesWithRipgrep(
  canonicalRoot: string,
  signal: AbortSignal,
): Promise<FuzzyFileDiscoveryBatch> {
  const ripgrepPath = selectPinnedRipgrepPath();
  if (ripgrepPath === undefined) {
    throw new FuzzyIndexBoundaryError(PINNED_RIPGREP_UNAVAILABLE_MESSAGE);
  }
  const args: string[] = [
    "--no-config",
    "--files",
    "--null",
    "--hidden",
    "--no-require-git",
    "--no-ignore-parent",
    "--glob",
    "!.git",
    "--glob",
    "!.git/**",
  ];
  assertGrepArgvWithinLimits(ripgrepPath, args);
  const parser = createRipgrepWireParser("files_with_matches", {
    maxRecordBytes: MAX_FUZZY_CANDIDATE_UTF8_BYTES_WITH_HEADROOM,
    maxDecodedBytes:
      MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES + DISCOVERY_BYTE_HEADROOM,
    maxResults: MAX_FUZZY_CANDIDATES + DISCOVERY_RESULT_HEADROOM,
  });
  const result = await runSupervisedProcess(
    {
      program: ripgrepPath,
      args,
      cwd: canonicalRoot,
      env: scrubEnvForChildProcess(process.env),
    },
    {
      timeoutMs: MAX_FUZZY_INDEX_BUILD_MS,
      maxOutputBytes:
        MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES +
        DISCOVERY_BYTE_HEADROOM +
        DISCOVERY_DIAGNOSTIC_BYTES,
      signal,
      onStdout: (chunk) => parser.push(chunk),
    },
  );
  if (signal.aborted || result.stopReason === "aborted") {
    throw new FuzzyIndexBuildCancelledError();
  }
  if (result.error !== undefined) throw result.error;
  if (result.stopReason !== undefined) {
    throw new FuzzyIndexBoundaryError(
      `pinned ripgrep file discovery stopped: ${result.stopReason}`,
    );
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      `pinned ripgrep file discovery exited ${result.exitCode}: ${boundedErrorText(result.stderr.toString("utf8"))}`,
    );
  }
  parser.finish();
  const rawFiles = parser.records
    .filter((record) => record.kind === "file")
    .map((record) => record.path);
  return entriesFromRipgrepPaths(rawFiles, process.platform);
}

export function entriesFromRipgrepPaths(
  rawFiles: readonly Buffer[],
  platform: NodeJS.Platform,
): FuzzyFileDiscoveryBatch {
  return entriesFromDiscoveredPaths(rawFiles, [], platform, "nonempty_only");
}

function entriesFromDiscoveredPaths(
  rawFiles: readonly Buffer[],
  rawDirectories: readonly Buffer[],
  platform: NodeJS.Platform,
  directoryCoverage: FuzzyDirectoryCoverage,
): FuzzyFileDiscoveryBatch {
  const byBytes = new Map<string, FuzzyIndexedEntry>();
  const budget: DiscoveryBudget = { candidateBytes: 0 };
  for (const rawPath of rawDirectories) {
    const portableBytes = normalizeRawPath(rawPath, platform);
    if (portableBytes.byteLength === 0) continue;
    assertSafeRelativeDiscoveryPath(portableBytes, platform);
    if (
      byBytes.size === 0 &&
      directoryPrefixBytesExceedBudget(
        portableBytes,
        MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES - budget.candidateBytes,
      )
    ) {
      return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
    }
    for (const prefix of directoryPrefixes(portableBytes)) {
      if (!addBoundedEntry(byBytes, budget, prefix, "directory")) {
        return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
      }
    }
    if (!addBoundedEntry(byBytes, budget, portableBytes, "directory")) {
      return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
    }
  }
  for (const rawPath of rawFiles) {
    const portableBytes = normalizeRawPath(rawPath, platform);
    if (portableBytes.byteLength === 0) continue;
    assertSafeRelativeDiscoveryPath(portableBytes, platform);
    if (
      byBytes.size === 0 &&
      directoryPrefixBytesExceedBudget(
        portableBytes,
        MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES - budget.candidateBytes,
      )
    ) {
      return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
    }
    const prefixes = directoryPrefixes(portableBytes);
    for (const prefix of prefixes) {
      if (!addBoundedEntry(byBytes, budget, prefix, "directory")) {
        return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
      }
    }
    if (!addBoundedEntry(byBytes, budget, portableBytes, "file")) {
      return finalizeDiscoveredEntries(byBytes, true, directoryCoverage);
    }
  }
  return finalizeDiscoveredEntries(byBytes, false, directoryCoverage);
}

function finalizeDiscoveredEntries(
  byBytes: ReadonlyMap<string, FuzzyIndexedEntry>,
  truncated: boolean,
  directoryCoverage: FuzzyDirectoryCoverage,
): FuzzyFileDiscoveryBatch {
  return Object.freeze({
    entries: Object.freeze([...byBytes.values()]),
    truncated,
    directoryCoverage,
  });
}

const MAX_FUZZY_CANDIDATE_UTF8_BYTES_WITH_HEADROOM =
  MAX_FUZZY_CANDIDATE_UTF8_BYTES + DISCOVERY_BYTE_HEADROOM;

interface EntryIntegrity {
  readonly entryCount: number;
  readonly pathBytes: number;
  readonly digest: string;
}

interface DiscoveryBudget {
  candidateBytes: number;
}

function configureDatabase(db: BetterSqlite3.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("temp_store = MEMORY");
}

function initializeSchema(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    const version = db.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isSafeInteger(version)) {
      throw new FuzzyIndexSchemaError(Number(version));
    }
    if (version < 0 || version > FUZZY_FILE_INDEX_SCHEMA_VERSION) {
      throw new FuzzyIndexSchemaError(version);
    }
    if (version === 1) {
      if (
        databaseTableExists(db, "fuzzy_index_roots") &&
        !databaseColumnExists(db, "fuzzy_index_roots", "last_access_at_ms")
      ) {
        db.exec(
          `ALTER TABLE fuzzy_index_roots
             ADD COLUMN last_access_at_ms INTEGER NOT NULL DEFAULT 0`,
        );
      }
      if (
        databaseTableExists(db, "fuzzy_index_generations") &&
        !databaseColumnExists(
          db,
          "fuzzy_index_generations",
          "directory_coverage",
        )
      ) {
        db.exec(
          `ALTER TABLE fuzzy_index_generations
             ADD COLUMN directory_coverage TEXT NOT NULL DEFAULT 'nonempty_only'
             CHECK (directory_coverage IN ('complete', 'nonempty_only'))`,
        );
      }
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS fuzzy_index_roots (
      root_key TEXT PRIMARY KEY,
      canonical_root TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      current_generation_id INTEGER,
      last_access_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fuzzy_index_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_key TEXT NOT NULL REFERENCES fuzzy_index_roots(root_key) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('staging', 'complete', 'failed', 'superseded')),
      started_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      entry_count INTEGER,
      path_bytes INTEGER,
      digest TEXT,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      source_boundary TEXT NOT NULL,
      directory_coverage TEXT NOT NULL
        CHECK (directory_coverage IN ('complete', 'nonempty_only')),
      inserted_count INTEGER NOT NULL,
      inserted_path_bytes INTEGER NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL,
      error_text TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fuzzy_index_entries (
      generation_id INTEGER NOT NULL REFERENCES fuzzy_index_generations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      path_bytes BLOB NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('file', 'directory')),
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (generation_id, ordinal),
      UNIQUE (generation_id, path_bytes)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS fuzzy_index_generations_root
      ON fuzzy_index_generations(root_key, id DESC);
    `);
    db.pragma(`user_version = ${FUZZY_FILE_INDEX_SCHEMA_VERSION}`);
  }).immediate();
}

function databaseTableExists(
  db: BetterSqlite3.Database,
  tableName: string,
): boolean {
  return (
    db
      .prepare<[string], { readonly present: number }>(
        `SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name = ?`,
      )
      .get(tableName) !== undefined
  );
}

function databaseColumnExists(
  db: BetterSqlite3.Database,
  tableName: string,
  columnName: string,
): boolean {
  return (
    db
      .prepare<[string, string], { readonly present: number }>(
        `SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`,
      )
      .get(tableName, columnName) !== undefined
  );
}

interface NormalizedDiscoveredEntries {
  readonly entryStore: FuzzyIndexEntryStore;
}

async function normalizeDiscoveredEntries(
  source: readonly FuzzyIndexedEntry[],
  signal: AbortSignal,
  onYield: () => void,
  onEntryStoreMeasured: (retainedBytes: number) => void,
): Promise<NormalizedDiscoveredEntries> {
  throwIfCancelled(signal);
  if (source.length > MAX_FUZZY_CANDIDATES) {
    throw new FuzzyIndexBoundaryError(
      `fuzzy-file generation has ${source.length} entries; maximum is ${MAX_FUZZY_CANDIDATES}`,
    );
  }
  let totalBytes = 0;
  let totalCandidateBytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    throwIfCancelled(signal);
    const entry = source[index]!;
    validateDiscoveredEntry(entry);
    const candidateBytes = Buffer.byteLength(entry.relativePath, "utf8");
    if (
      !Number.isSafeInteger(totalBytes + entry.pathBytes.byteLength) ||
      totalBytes + entry.pathBytes.byteLength >
        MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
    ) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation exceeds ${MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES} path bytes`,
      );
    }
    if (
      !Number.isSafeInteger(totalCandidateBytes + candidateBytes) ||
      totalCandidateBytes + candidateBytes >
        MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
    ) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation exceeds ${MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES} candidate bytes`,
      );
    }
    totalBytes += entry.pathBytes.byteLength;
    totalCandidateBytes += candidateBytes;
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      onYield();
      await yieldToEventLoop();
    }
  }
  onEntryStoreMeasured(
    estimateFuzzyIndexEntryStoreRetainedBytes(
      source.length,
      totalBytes,
      totalCandidateBytes,
    ),
  );
  throwIfCancelled(signal);
  const entries: FuzzyIndexedEntry[] = new Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    entries[index] = source[index]!;
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      throwIfCancelled(signal);
      onYield();
      await yieldToEventLoop();
    }
  }
  await sortIndexedEntries(entries, signal, onYield);
  for (let index = 1; index < entries.length; index += 1) {
    throwIfCancelled(signal);
    const entry = entries[index]!;
    if (entry.pathBytes.equals(entries[index - 1]!.pathBytes)) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation contains duplicate path bytes for '${entry.relativePath}'`,
      );
    }
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      onYield();
      await yieldToEventLoop();
    }
  }
  const builder = new CompactFuzzyIndexEntryStoreBuilder(
    entries.length,
    totalBytes,
    totalCandidateBytes,
  );
  for (let index = 0; index < entries.length; index += 1) {
    throwIfCancelled(signal);
    const entry = entries[index]!;
    validateDiscoveredEntry(entry);
    builder.add(entry, true);
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      onYield();
      await yieldToEventLoop();
    }
  }
  return {
    entryStore: builder.finish(),
  };
}

function validateDiscoveredEntry(entry: FuzzyIndexedEntry): void {
  validateFuzzyCandidate(entry.relativePath);
  if (entry.matchType !== "file" && entry.matchType !== "directory") {
    throw new FuzzyIndexBoundaryError(
      `fuzzy-file entry has invalid type '${String(entry.matchType)}'`,
    );
  }
  if (entry.pathBytes.includes(0)) {
    throw new FuzzyIndexBoundaryError("fuzzy-file path bytes contain NUL");
  }
}

async function describeEntryStore(
  entryStore: FuzzyIndexEntryStore,
  directoryCoverage: FuzzyDirectoryCoverage,
  canonicalRoot: string,
  sourceBoundary: string,
  buildEpoch: number,
  signal: AbortSignal,
  onYield: () => void,
): Promise<EntryIntegrity> {
  const hash = createEntryIntegrityHash(
    directoryCoverage,
    canonicalRoot,
    sourceBoundary,
    buildEpoch,
  );
  let pathBytes = 0;
  for (let index = 0; index < entryStore.entryCount; index += 1) {
    throwIfCancelled(signal);
    const entry = indexedEntryAt(entryStore, index);
    pathBytes += entry.pathBytes.byteLength;
    addEntryIntegrity(
      hash,
      fingerprintEntry(entry, canonicalRoot),
      entry.pathBytes.byteLength,
    );
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      onYield();
      await yieldToEventLoop();
    }
  }
  return finishEntryIntegrity(hash, entryStore.entryCount, pathBytes);
}

function indexedEntryAt(
  entryStore: FuzzyIndexEntryStore,
  ordinal: number,
): FuzzyIndexedEntry {
  return {
    relativePath: entryStore.relativePathAt(ordinal),
    pathBytes: entryStore.pathBytesAt(ordinal),
    matchType: entryStore.matchTypeAt(ordinal),
  };
}

function createEntryIntegrityHash(
  directoryCoverage: FuzzyDirectoryCoverage,
  canonicalRoot: string,
  sourceBoundary: string,
  buildEpoch: number,
): ReturnType<typeof createHash> {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, Buffer.from(FUZZY_FILE_INDEX_POLICY_ID, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from(String(FUZZY_FILE_INDEX_SCHEMA_VERSION), "utf8"),
  );
  updateLengthPrefixed(hash, Buffer.from(canonicalRoot, "utf8"));
  updateLengthPrefixed(hash, Buffer.from(sourceBoundary, "utf8"));
  updateLengthPrefixed(hash, Buffer.from(directoryCoverage, "utf8"));
  updateLengthPrefixed(hash, Buffer.from(String(buildEpoch), "utf8"));
  return hash;
}

function addEntryIntegrity(
  hash: ReturnType<typeof createHash>,
  fingerprint: string,
  pathBytes: number,
): void {
  updateLengthPrefixed(hash, Buffer.from(fingerprint, "utf8"));
  updateLengthPrefixed(hash, lengthBuffer(pathBytes));
}

function finishEntryIntegrity(
  hash: ReturnType<typeof createHash>,
  entryCount: number,
  pathBytes: number,
): EntryIntegrity {
  return {
    entryCount,
    pathBytes,
    digest: hash.digest("hex"),
  };
}

function updateLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  value: Buffer,
): void {
  const length = Buffer.alloc(HASH_LENGTH_PREFIX_BYTES);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

function fingerprintEntry(
  entry: FuzzyIndexedEntry,
  canonicalRoot: string,
): string {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, Buffer.from(FUZZY_FILE_INDEX_POLICY_ID, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from(String(FUZZY_FILE_INDEX_SCHEMA_VERSION), "utf8"),
  );
  updateLengthPrefixed(hash, Buffer.from(canonicalRoot, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from(
      entry.matchType === "file"
        ? ENTRY_TYPE_FILE_TAG
        : ENTRY_TYPE_DIRECTORY_TAG,
      "utf8",
    ),
  );
  updateLengthPrefixed(hash, entry.pathBytes);
  updateLengthPrefixed(hash, Buffer.from(entry.relativePath, "utf8"));
  const searchCandidate = prepareFuzzyCandidate(entry.relativePath);
  updateLengthPrefixed(hash, Buffer.from(searchCandidate.portableText, "utf8"));
  updateLengthPrefixed(
    hash,
    Buffer.from([...searchCandidate.foldedSignature].join(","), "ascii"),
  );
  return hash.digest("hex");
}

function lengthBuffer(value: number): Buffer {
  const length = Buffer.alloc(HASH_LENGTH_PREFIX_BYTES);
  length.writeBigUInt64BE(BigInt(value));
  return length;
}

function normalizeRawPath(path: Buffer, platform: NodeJS.Platform): Buffer {
  let start = 0;
  while (
    start + 1 < path.byteLength &&
    path[start] === CURRENT_DIRECTORY_BYTE &&
    isRawSeparator(path[start + 1]!, platform)
  ) {
    start += 2;
  }
  const normalized = Buffer.from(path.subarray(start));
  if (platform === "win32") {
    for (let index = 0; index < normalized.byteLength; index += 1) {
      if (normalized[index] === WINDOWS_PATH_SEPARATOR_BYTE) {
        normalized[index] = PATH_SEPARATOR_BYTE;
      }
    }
  }
  return normalized;
}

function assertSafeRelativeDiscoveryPath(
  path: Buffer,
  platform: NodeJS.Platform,
): void {
  if (
    path[0] === PATH_SEPARATOR_BYTE ||
    path.includes(NUL_BYTE) ||
    (platform === "win32" && path.includes(WINDOWS_PATH_COLON_BYTE)) ||
    path.equals(Buffer.from("..")) ||
    path.subarray(0, 3).equals(Buffer.from("../")) ||
    path.includes(Buffer.from("/../")) ||
    path.subarray(-3).equals(Buffer.from("/.."))
  ) {
    throw new FuzzyIndexBoundaryError(
      "file discovery returned a path outside the canonical root",
    );
  }
}

function* directoryPrefixes(path: Buffer): Generator<Buffer> {
  for (let index = 0; index < path.byteLength; index += 1) {
    if (path[index] === PATH_SEPARATOR_BYTE && index > 0) {
      yield path.subarray(0, index);
    }
  }
}

function directoryPrefixBytesExceedBudget(
  path: Buffer,
  availableBytes: number,
): boolean {
  let prefixBytes = 0;
  for (let index = 1; index < path.byteLength; index += 1) {
    if (path[index] !== PATH_SEPARATOR_BYTE) continue;
    if (
      !Number.isSafeInteger(prefixBytes + index) ||
      prefixBytes + index > availableBytes
    ) {
      return true;
    }
    prefixBytes += index;
  }
  return false;
}

function isRawSeparator(byte: number, platform: NodeJS.Platform): boolean {
  return (
    byte === PATH_SEPARATOR_BYTE ||
    (platform === "win32" && byte === WINDOWS_PATH_SEPARATOR_BYTE)
  );
}

function addBoundedEntry(
  entries: Map<string, FuzzyIndexedEntry>,
  budget: DiscoveryBudget,
  pathBytes: Buffer,
  matchType: FuzzyIndexedEntryType,
): boolean {
  if (entries.size >= MAX_FUZZY_CANDIDATES) return false;
  const key = pathBytes.toString("hex");
  if (entries.has(key)) return true;
  const relativePath = renderRipgrepPathBytes(pathBytes);
  try {
    validateFuzzyCandidate(relativePath);
  } catch {
    return false;
  }
  const candidateBytes = Buffer.byteLength(relativePath, "utf8");
  if (
    budget.candidateBytes + candidateBytes >
    MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
  ) {
    return false;
  }
  budget.candidateBytes += candidateBytes;
  entries.set(
    key,
    Object.freeze({
      relativePath,
      pathBytes: Buffer.from(pathBytes),
      matchType,
    }),
  );
  return true;
}

function compareIndexedEntries(
  left: FuzzyIndexedEntry,
  right: FuzzyIndexedEntry,
): number {
  const bytes = Buffer.compare(left.pathBytes, right.pathBytes);
  if (bytes !== 0) return bytes;
  const type =
    left.matchType === right.matchType
      ? 0
      : left.matchType === "directory"
        ? -1
        : 1;
  return type !== 0
    ? type
    : comparePortablePaths(left.relativePath, right.relativePath);
}

async function sortIndexedEntries(
  entries: FuzzyIndexedEntry[],
  signal: AbortSignal,
  onYield: () => void,
): Promise<void> {
  if (entries.length < 2) return;
  let source = entries;
  let destination = new Array<FuzzyIndexedEntry>(entries.length);
  let comparisonsSinceYield = 0;
  for (let width = 1; width < entries.length; width *= 2) {
    for (let start = 0; start < entries.length; start += width * 2) {
      const middle = Math.min(start + width, entries.length);
      const end = Math.min(start + width * 2, entries.length);
      let left = start;
      let right = middle;
      let output = start;
      while (left < middle || right < end) {
        throwIfCancelled(signal);
        if (
          right >= end ||
          (left < middle &&
            compareIndexedEntries(source[left]!, source[right]!) <= 0)
        ) {
          destination[output] = source[left]!;
          left += 1;
        } else {
          destination[output] = source[right]!;
          right += 1;
        }
        output += 1;
        comparisonsSinceYield += 1;
        if (comparisonsSinceYield >= HYDRATION_SLICE_ENTRIES) {
          comparisonsSinceYield = 0;
          onYield();
          await yieldToEventLoop();
        }
      }
    }
    [source, destination] = [destination, source];
  }
  if (source === entries) return;
  for (let index = 0; index < entries.length; index += 1) {
    entries[index] = source[index]!;
    if ((index + 1) % HYDRATION_SLICE_ENTRIES === 0) {
      throwIfCancelled(signal);
      onYield();
      await yieldToEventLoop();
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new FuzzyIndexBuildCancelledError();
}

function boundedErrorText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) return EMPTY_ERROR_TEXT;
  return normalized.slice(0, DISCOVERY_DIAGNOSTIC_BYTES);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateIdleTtlMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > FUZZY_INDEX_IDLE_TTL_MS
  ) {
    throw new RangeError(
      `idleTtlMs must be a safe integer in [1, ${FUZZY_INDEX_IDLE_TTL_MS}]`,
    );
  }
  return value;
}

function validateDirectoryCoverage(
  value: FuzzyDirectoryCoverage,
): FuzzyDirectoryCoverage {
  if (value !== "complete" && value !== "nonempty_only") {
    throw new FuzzyIndexBoundaryError(
      `unsupported fuzzy-file directory coverage '${String(value)}'`,
    );
  }
  return value;
}

function generationHeaderBoundsAreValid(
  row: GenerationRow,
): row is GenerationRow & {
  readonly entry_count: number;
  readonly path_bytes: number;
} {
  return (
    Number.isSafeInteger(row.entry_count) &&
    row.entry_count !== null &&
    row.entry_count >= 0 &&
    row.entry_count <= MAX_FUZZY_CANDIDATES &&
    Number.isSafeInteger(row.path_bytes) &&
    row.path_bytes !== null &&
    row.path_bytes >= 0 &&
    row.path_bytes <= MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
  );
}

function boundedCompactByteSum(current: number, incoming: number): boolean {
  return (
    Number.isSafeInteger(current + incoming) &&
    current + incoming <= MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
  );
}

function invalidLoadedGeneration(): {
  readonly entryStore: null;
  readonly integrity: null;
  readonly fingerprintsValid: false;
} {
  return {
    entryStore: null,
    integrity: null,
    fingerprintsValid: false,
  };
}

function validateCompactEntryStoreBounds(
  entryCount: number,
  pathBytes: number,
  candidateBytes: number,
): void {
  if (
    !Number.isSafeInteger(entryCount) ||
    entryCount < 0 ||
    entryCount > MAX_FUZZY_CANDIDATES ||
    !Number.isSafeInteger(pathBytes) ||
    pathBytes < 0 ||
    pathBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES ||
    !Number.isSafeInteger(candidateBytes) ||
    candidateBytes < 0 ||
    candidateBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
  ) {
    throw new FuzzyIndexBoundaryError(
      "fuzzy-file compact entry-store bounds are invalid",
    );
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isRecoverableSqliteCorruption(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return RECOVERABLE_SQLITE_CORRUPTION_CODES.has(String(error.code));
}

function quarantineCorruptDatabase(databasePath: string): void {
  const quarantinePath = `${databasePath}.corrupt-${Date.now()}`;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const source = `${databasePath}${suffix}`;
    if (existsSync(source)) renameSync(source, `${quarantinePath}${suffix}`);
  }
}
