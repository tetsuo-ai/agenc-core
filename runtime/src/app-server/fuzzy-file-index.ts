/**
 * Persistent derived generations for daemon fuzzy-file search.
 *
 * Ripgrep discovers raw path bytes into a private staging generation. Readers
 * continue to use the previous immutable generation until count, byte-count,
 * and digest checks succeed and SQLite atomically advances the root pointer.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
import { getAgenCConfigHomeDir } from "../utils/envUtils.js";
import { runSupervisedProcess } from "../utils/supervisedProcess.js";
import {
  MAX_FUZZY_CANDIDATES,
  MAX_FUZZY_CANDIDATE_UTF8_BYTES,
  MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES,
  comparePortablePaths,
  prepareFuzzyCandidate,
  type PreparedFuzzyCandidate,
} from "../search/fuzzy-match.js";
import { PINNED_RIPGREP_PATH } from "../tools/system/pinned-ripgrep.js";
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
const CLEANUP_BATCH_GENERATIONS = 128;
const HASH_LENGTH_PREFIX_BYTES = 8;
const PATH_SEPARATOR_BYTE = 0x2f;
const WINDOWS_PATH_SEPARATOR_BYTE = 0x5c;
const CURRENT_DIRECTORY_BYTE = 0x2e;
const ENTRY_TYPE_FILE_TAG = "F";
const ENTRY_TYPE_DIRECTORY_TAG = "D";
const EMPTY_ERROR_TEXT = "";
const GIT_EXECUTABLE_NAME = "git";
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
  readonly searchCandidate?: PreparedFuzzyCandidate;
}

export interface FuzzyFileDiscoveryResult {
  readonly entries: readonly FuzzyIndexedEntry[];
  readonly truncated: boolean;
  readonly directoryCoverage?: FuzzyDirectoryCoverage;
}

export type FuzzyDirectoryCoverage = "complete" | "nonempty_only";

export interface FuzzyFileDiscoveryOptions {
  /** Test seam for a resolved executable; production lets the OS resolve Git. */
  readonly gitProgram?: string;
  /** Test seam for global/common-dir ignore fixtures. */
  readonly environment?: NodeJS.ProcessEnv;
}

export type FuzzyFileDiscovery = (
  canonicalRoot: string,
  signal: AbortSignal,
) => Promise<FuzzyFileDiscoveryResult>;

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
  readonly entries: readonly FuzzyIndexedEntry[];
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
      this.#recoverInterruptedBuilds();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    if (this.#db.open) this.#db.close();
  }

  readCurrent(canonicalRoot: string): FuzzyIndexSnapshot | null {
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
    const loaded = this.#readGenerationEntries(row.id, row.canonical_root);
    const entries = loaded.entries;
    const integrity = describeEntries(
      entries,
      row.directory_coverage,
      row.canonical_root,
      row.source_boundary,
      row.id,
    );
    if (
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
      entries: Object.freeze(entries),
    });
  }

  async publish(
    canonicalRoot: string,
    discovery: FuzzyFileDiscoveryResult,
    signal: AbortSignal,
    options: FuzzyIndexPublicationOptions = {},
  ): Promise<FuzzyIndexSnapshot | null> {
    throwIfCancelled(signal);
    if (discovery.truncated) {
      throw new FuzzyIndexBoundaryError(
        "fuzzy-file discovery reached a bound; refusing to publish a prefix",
      );
    }
    const rootKey = fuzzyIndexRootKey(canonicalRoot);
    const entries = normalizeDiscoveredEntries(discovery.entries);
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
    const integrity = describeEntries(
      entries,
      directoryCoverage,
      canonicalRoot,
      sourceBoundary,
      generationId,
    );
    try {
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
        sliceStart < entries.length;
        sliceStart += PUBLISH_SLICE_ENTRIES
      ) {
        const sliceEnd = Math.min(
          entries.length,
          sliceStart + PUBLISH_SLICE_ENTRIES,
        );
        this.#db
          .transaction(() => {
            for (let ordinal = sliceStart; ordinal < sliceEnd; ordinal += 1) {
              const entry = entries[ordinal]!;
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
        if (sliceEnd < entries.length) await yieldToEventLoop();
      }
      if (entries.length === 0) {
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
        entries,
      });
    } catch (error) {
      this.#failGeneration(generationId, errorMessage(error));
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

  #readGenerationEntries(
    generationId: number,
    canonicalRoot: string,
  ): {
    readonly entries: FuzzyIndexedEntry[];
    readonly fingerprintsValid: boolean;
  } {
    let fingerprintsValid = true;
    const entries = this.#db
      .prepare<[number], EntryRow>(
        `SELECT relative_path, path_bytes, entry_type, fingerprint
           FROM fuzzy_index_entries
          WHERE generation_id = ? ORDER BY ordinal`,
      )
      .all(generationId)
      .map((row) => {
        const entry = Object.freeze({
          relativePath: row.relative_path,
          pathBytes: Buffer.from(row.path_bytes),
          matchType: row.entry_type,
          searchCandidate: prepareFuzzyCandidate(row.relative_path),
        });
        if (row.fingerprint !== fingerprintEntry(entry, canonicalRoot)) {
          fingerprintsValid = false;
        }
        return entry;
      });
    return { entries, fingerprintsValid };
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

  #failGeneration(generationId: number, message: string): void {
    this.#db
      .prepare<[number, string, number]>(
        `UPDATE fuzzy_index_generations
            SET state = 'failed', completed_at_ms = ?, error_text = ?
          WHERE id = ? AND state = 'staging'`,
      )
      .run(this.#now(), boundedErrorText(message), generationId);
  }

  #recoverInterruptedBuilds(): void {
    const expiredBeforeMs = this.#now() - INTERRUPTED_BUILD_HEARTBEAT_GRACE_MS;
    this.#db
      .prepare<[number, number]>(
        `UPDATE fuzzy_index_generations
            SET state = 'failed', completed_at_ms = ?,
                error_text = 'interrupted before publication'
          WHERE state = 'staging' AND heartbeat_at_ms <= ?`,
      )
      .run(this.#now(), expiredBeforeMs);
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
    getAgenCConfigHomeDir(),
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
  const absolute = resolve(root).normalize("NFC");
  try {
    return (await realpath(absolute)).normalize("NFC");
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
  updateLengthPrefixed(
    hash,
    Buffer.from(canonicalRoot.normalize("NFC"), "utf8"),
  );
  return hash.digest("hex");
}

async function discoverFuzzyFilesWithGit(
  canonicalRoot: string,
  signal: AbortSignal,
  options: FuzzyFileDiscoveryOptions,
): Promise<FuzzyFileDiscoveryResult | null> {
  const deadline = performance.now() + MAX_FUZZY_INDEX_BUILD_MS;
  const program = options.gitProgram ?? GIT_EXECUTABLE_NAME;
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
    "complete",
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
): Promise<FuzzyFileDiscoveryResult> {
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
): Promise<FuzzyFileDiscoveryResult> {
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
  const externalExclude = await externalGitInfoExclude(canonicalRoot);
  if (externalExclude !== null) {
    args.push("--ignore-file", externalExclude);
  }
  assertGrepArgvWithinLimits(PINNED_RIPGREP_PATH, args);
  const parser = createRipgrepWireParser("files_with_matches", {
    maxRecordBytes: MAX_FUZZY_CANDIDATE_UTF8_BYTES_WITH_HEADROOM,
    maxDecodedBytes:
      MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES + DISCOVERY_BYTE_HEADROOM,
    maxResults: MAX_FUZZY_CANDIDATES + DISCOVERY_RESULT_HEADROOM,
  });
  const result = await runSupervisedProcess(
    {
      program: PINNED_RIPGREP_PATH,
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
): FuzzyFileDiscoveryResult {
  return entriesFromDiscoveredPaths(rawFiles, [], platform, "nonempty_only");
}

function entriesFromDiscoveredPaths(
  rawFiles: readonly Buffer[],
  rawDirectories: readonly Buffer[],
  platform: NodeJS.Platform,
  directoryCoverage: FuzzyDirectoryCoverage,
): FuzzyFileDiscoveryResult {
  const byBytes = new Map<string, FuzzyIndexedEntry>();
  const budget: DiscoveryBudget = { candidateBytes: 0 };
  let truncated = false;
  for (const rawPath of rawDirectories) {
    const portableBytes = normalizeRawPath(rawPath, platform);
    if (portableBytes.byteLength === 0) continue;
    assertSafeRelativeDiscoveryPath(portableBytes);
    const prefixes = [...directoryPrefixes(portableBytes), portableBytes];
    for (const prefix of prefixes) {
      truncated =
        addBoundedEntry(byBytes, budget, prefix, "directory") === false ||
        truncated;
    }
  }
  for (const rawPath of rawFiles) {
    const portableBytes = normalizeRawPath(rawPath, platform);
    if (portableBytes.byteLength === 0) continue;
    assertSafeRelativeDiscoveryPath(portableBytes);
    const prefixes = directoryPrefixes(portableBytes);
    for (const prefix of prefixes) {
      truncated =
        addBoundedEntry(byBytes, budget, prefix, "directory") === false ||
        truncated;
    }
    truncated =
      addBoundedEntry(byBytes, budget, portableBytes, "file") === false ||
      truncated;
  }
  const entries = [...byBytes.values()]
    .sort(compareIndexedEntries)
    .slice(0, MAX_FUZZY_CANDIDATES);
  if (byBytes.size > entries.length) truncated = true;
  return { entries: Object.freeze(entries), truncated, directoryCoverage };
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
  const version = db.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new FuzzyIndexSchemaError(Number(version));
  }
  if (version < 0 || version > FUZZY_FILE_INDEX_SCHEMA_VERSION) {
    throw new FuzzyIndexSchemaError(version);
  }
  if (version === 1) {
    db.exec(
      `ALTER TABLE fuzzy_index_roots
         ADD COLUMN last_access_at_ms INTEGER NOT NULL DEFAULT 0`,
    );
    const generationsExist =
      db
        .prepare<[], { readonly present: number }>(
          `SELECT 1 AS present FROM sqlite_master
            WHERE type = 'table' AND name = 'fuzzy_index_generations'`,
        )
        .get() !== undefined;
    if (generationsExist) {
      db.exec(
        `ALTER TABLE fuzzy_index_generations
           ADD COLUMN directory_coverage TEXT NOT NULL DEFAULT 'complete'
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
}

function normalizeDiscoveredEntries(
  source: readonly FuzzyIndexedEntry[],
): readonly FuzzyIndexedEntry[] {
  if (source.length > MAX_FUZZY_CANDIDATES) {
    throw new FuzzyIndexBoundaryError(
      `fuzzy-file generation has ${source.length} entries; maximum is ${MAX_FUZZY_CANDIDATES}`,
    );
  }
  const entries = source
    .map((entry) => {
      const searchCandidate = prepareFuzzyCandidate(entry.relativePath);
      if (entry.matchType !== "file" && entry.matchType !== "directory") {
        throw new FuzzyIndexBoundaryError(
          `fuzzy-file entry has invalid type '${String(entry.matchType)}'`,
        );
      }
      if (entry.pathBytes.includes(0)) {
        throw new FuzzyIndexBoundaryError("fuzzy-file path bytes contain NUL");
      }
      return Object.freeze({
        relativePath: entry.relativePath,
        pathBytes: Buffer.from(entry.pathBytes),
        matchType: entry.matchType,
        searchCandidate,
      });
    })
    .sort(compareIndexedEntries);
  let totalBytes = 0;
  let totalCandidateBytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    totalBytes += entry.pathBytes.byteLength;
    totalCandidateBytes += Buffer.byteLength(entry.relativePath, "utf8");
    if (totalBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation exceeds ${MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES} path bytes`,
      );
    }
    if (totalCandidateBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation exceeds ${MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES} candidate bytes`,
      );
    }
    const key = entry.pathBytes.toString("hex");
    if (seen.has(key)) {
      throw new FuzzyIndexBoundaryError(
        `fuzzy-file generation contains duplicate path bytes for '${entry.relativePath}'`,
      );
    }
    seen.add(key);
  }
  return Object.freeze(entries);
}

function describeEntries(
  entries: readonly FuzzyIndexedEntry[],
  directoryCoverage: FuzzyDirectoryCoverage,
  canonicalRoot: string,
  sourceBoundary: string,
  buildEpoch: number,
): EntryIntegrity {
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
  let pathBytes = 0;
  for (const entry of entries) {
    pathBytes += entry.pathBytes.byteLength;
    updateLengthPrefixed(
      hash,
      Buffer.from(fingerprintEntry(entry, canonicalRoot), "utf8"),
    );
    updateLengthPrefixed(hash, lengthBuffer(entry.pathBytes.byteLength));
  }
  return {
    entryCount: entries.length,
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
  const searchCandidate =
    entry.searchCandidate ?? prepareFuzzyCandidate(entry.relativePath);
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

function assertSafeRelativeDiscoveryPath(path: Buffer): void {
  if (
    path[0] === PATH_SEPARATOR_BYTE ||
    path.includes(NUL_BYTE) ||
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

function directoryPrefixes(path: Buffer): readonly Buffer[] {
  const prefixes: Buffer[] = [];
  for (let index = 0; index < path.byteLength; index += 1) {
    if (path[index] === PATH_SEPARATOR_BYTE && index > 0) {
      prefixes.push(Buffer.from(path.subarray(0, index)));
    }
  }
  return prefixes;
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
  let searchCandidate: PreparedFuzzyCandidate;
  try {
    searchCandidate = prepareFuzzyCandidate(relativePath);
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
      searchCandidate,
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

async function externalGitInfoExclude(
  canonicalRoot: string,
): Promise<string | null> {
  const gitPath = join(canonicalRoot, ".git");
  let contents: string;
  try {
    contents = await readFile(gitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/imu.exec(contents);
  if (match === null) return null;
  const configuredPath = match[1]!.trim();
  const gitDirectory = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(canonicalRoot, configuredPath);
  const excludePath = join(gitDirectory, "info", "exclude");
  try {
    await readFile(excludePath, "utf8");
    return excludePath;
  } catch {
    return null;
  }
}
