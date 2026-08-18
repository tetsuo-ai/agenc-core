import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  statSync,
  watch,
  type Dir,
  type FSWatcher,
} from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { performance } from "node:perf_hooks";

import type BetterSqlite3 from "better-sqlite3";

import { parseFrontmatter } from "../utils/frontmatterParser.js";
import {
  MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE,
  MAX_MEMORY_AUDIT_MS_PER_SLICE,
  MAX_MEMORY_BUILD_OPEN_DIRECTORIES,
  MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS,
  MAX_MEMORY_FILES_PER_ROOT,
  MAX_MEMORY_FTS_CANDIDATES,
  MAX_MEMORY_HEADER_UTF8_BYTES,
  MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE,
  MAX_MEMORY_INDEX_BUILD_SLICE_MS,
  MAX_MEMORY_INDEX_TOTAL_BUILD_MS,
  MAX_MEMORY_INDEX_BYTES,
  MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS,
  MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE,
  MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH,
  MAX_MEMORY_INDEX_CONCURRENT_BUILDS,
  MAX_MEMORY_INDEX_ROOTS,
  MAX_MEMORY_INDEX_WATCHERS,
  MAX_MEMORY_PATH_UTF8_BYTES,
  MAX_MEMORY_RECENT_UNION,
  MEMORY_AUDIT_BACKOFF_MULTIPLIER,
  MEMORY_AUDIT_MAX_INTERVAL_MS,
  MEMORY_AUDIT_MIN_INTERVAL_MS,
  MEMORY_INDEX_DIRECTORY,
  MEMORY_INDEX_FILENAME,
  MEMORY_INDEX_BUILD_LEASE_MS,
  MEMORY_INDEX_ROOT_IDLE_TTL_MS,
  MEMORY_WATCH_DEBOUNCE_MS,
  MemoryIndexBoundaryError,
  MemoryIndexQueryResourceLimitedError,
  buildMemoryFtsMatch,
  computeMemoryHeaderFingerprint,
  fuseMemoryRanks,
  memoryIndexRootId,
  normalizeSearchableMetadata,
  stableMemoryId,
  type MemoryFusedCandidate,
  type MemoryIndexRootRole,
  type MemoryRankCandidate,
} from "./full-corpus-contract.js";
import { MemoryQueryProcessPool } from "./memory-query-pool.js";
import {
  MemoryIndexCorruptionError,
  openMemoryIndexDatabase,
} from "./full-corpus-storage.js";
import { parseMemoryType } from "./types.js";
import type { FileIdentity, MemoryHeader, MemoryRootBinding } from "./scan.js";

export {
  MemoryIndexCorruptionError,
  MemoryIndexSchemaError,
} from "./full-corpus-storage.js";

const FRONTMATTER_MAX_LINES = 30;
const MAX_COMPLETE_GENERATIONS_PER_ROOT = 1;
const SHA256_DIGEST_BYTES = 32;
const DIGEST_LENGTH_PREFIX_BYTES = 8;
const EMPTY_MEMORY_GENERATION_DIGEST = "00".repeat(SHA256_DIGEST_BYTES);
const MEMORY_INDEX_OWNER_HEARTBEAT_MS = 60_000;
const MEMORY_INDEX_OWNER_LEASE_MS = 180_000;
const MEMORY_INDEX_READER_PIN_HEARTBEAT_MS = 10_000;
const MEMORY_INDEX_READER_PIN_LEASE_MS = 60_000;
const MEMORY_INDEX_INCREMENTAL_CONTENTION_REASON =
  "memory index update is waiting for an active reader or writer";
const CHANGE_KIND_VALUES = new Set(["create", "update", "delete", "rename"]);

type MemoryIndexGenerationState =
  "staging" | "complete" | "failed" | "superseded";
type MemoryIndexWatcherHealth = "healthy" | "degraded" | "overflow";

export interface MemoryIndexRootSpec {
  readonly path: string;
  readonly role: MemoryIndexRootRole;
}

export interface MemoryIndexRefreshOptions {
  readonly explicit?: boolean;
}

export interface MemoryIndexGenerationStatus {
  readonly rootId: string;
  readonly canonicalRoot: string;
  readonly role: MemoryIndexRootRole;
  readonly generationId: number | null;
  readonly generationToken: string | null;
  readonly state: "complete" | "refresh_pending" | "failed" | "unavailable";
  readonly ageMs: number | null;
  readonly watcherHealth: MemoryIndexWatcherHealth;
  readonly auditCursor: string | null;
  readonly reason?: string;
}

export interface MemoryIndexRefreshResult {
  readonly kind: "complete" | "refresh_pending" | "degraded";
  readonly roots: readonly MemoryIndexGenerationStatus[];
}

export type MemoryFullCorpusQueryResult =
  | {
      readonly kind: "complete" | "stale";
      readonly candidates: readonly MemoryFusedCandidate[];
      readonly freshness: readonly MemoryIndexGenerationStatus[];
    }
  | {
      readonly kind: "unavailable" | "query_resource_limited";
      readonly candidates: readonly [];
      readonly freshness: readonly MemoryIndexGenerationStatus[];
      readonly reason: string;
    };

export interface PersistentMemoryIndexOptions {
  readonly databasePath: string;
  readonly queryPool?: MemoryQueryProcessPool;
  readonly now?: () => number;
  readonly backgroundRefresh?: boolean;
  readonly resourceLimitsForTesting?: {
    readonly maxDatabaseBytes?: number;
    readonly maxFilesPerRoot?: number;
  };
  readonly beforeIncrementalReadForTesting?: () => void | Promise<void>;
}

interface RootRow {
  readonly root_id: string;
  readonly canonical_path: string;
  readonly root_role: MemoryIndexRootRole;
  readonly current_generation_id: number | null;
  readonly last_used_at_ms: number;
  readonly watcher_health: MemoryIndexWatcherHealth;
  readonly audit_cursor: string | null;
}

interface GenerationRow {
  readonly id: number;
  readonly root_id: string;
  readonly state: MemoryIndexGenerationState;
  readonly generation_token: string;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly elapsed_active_ms: number;
  readonly discovery_operations: number;
  readonly discovered_file_count: number;
  readonly entry_count: number;
  readonly indexed_bytes: number;
  readonly digest: string | null;
  readonly change_cursor: number;
  readonly change_overflow: number;
  readonly error: string | null;
  readonly builder_owner: string | null;
  readonly builder_lease_expires_at_ms: number | null;
}

interface WorkDirectoryRow {
  readonly relative_path: string;
  readonly state: "pending" | "enumerating" | "complete";
  readonly dev: string;
  readonly ino: string;
  readonly mtime_ns: string;
}

interface DiscoveredFileRow {
  readonly relative_path: string;
}

interface EntryRow {
  readonly root_id: string;
  readonly generation_id: number;
  readonly memory_id: string;
  readonly relative_path: string;
  readonly canonical_path: string;
  readonly title: string;
  readonly description: string;
  readonly memory_type: string | null;
  readonly mtime_ms: number;
  readonly file_size: number;
  readonly fingerprint: string;
  readonly file_dev: string;
  readonly file_ino: string;
  readonly file_mode: string;
  readonly file_mtime_ns: string;
  readonly file_ctime_ns: string;
  readonly root_dev: string;
  readonly root_ino: string;
  readonly root_mode: string;
  readonly root_size: string;
  readonly root_mtime_ns: string;
  readonly root_ctime_ns: string;
}

interface BoundRoot {
  readonly rootId: string;
  readonly canonicalRoot: string;
  readonly role: MemoryIndexRootRole;
  readonly identity: FileIdentity;
}

interface OpenDirectoryState {
  readonly directory: Dir;
  readonly absolutePath: string;
  readonly beforeIdentity: DirectoryIdentity;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
}

interface IndexedMemoryHeader {
  readonly memoryId: string;
  readonly canonicalPath: string;
  readonly title: string;
  readonly description: string;
  readonly type: string | null;
  readonly mtimeMs: number;
  readonly fileSize: number;
  readonly fingerprint: string;
  readonly fileIdentity: FileIdentity;
}

interface BuildSliceBudget {
  readonly startedAt: number;
  newEntries: number;
  operations: number;
}

interface PinnedGenerationSnapshots {
  readonly pinId: string;
  readonly snapshots: readonly {
    readonly root: BoundRoot;
    readonly generation: GenerationRow;
  }[];
  readonly freshness: readonly MemoryIndexGenerationStatus[];
  readonly unavailableReason?: string;
}

interface ReaderPinHeartbeat {
  readonly timer: ReturnType<typeof setInterval>;
  readonly pinned: PinnedGenerationSnapshots;
  readonly lost: () => boolean;
  readonly markLost: () => void;
}

interface IncrementalChangeRow {
  readonly sequence: number;
  readonly relative_path: string;
  readonly change_kind: "create" | "update" | "delete" | "rename";
}

interface PreparedIncrementalChange {
  readonly sequence: number;
  readonly relativePath: string;
  readonly indexed: IndexedMemoryHeader | null | undefined;
}

type MemoryAuditPhase = "entries" | "directories";

interface MemoryAuditCursor {
  readonly phase: MemoryAuditPhase;
  readonly relativePath: string;
}

const activeBuilds = new Set<string>();
let activeMemoryIndexWatchers = 0;
let activeMemoryBuildOpenDirectories = 0;

export class PersistentMemoryIndex {
  readonly databasePath: string;
  readonly #db: BetterSqlite3.Database;
  readonly #queryPool: MemoryQueryProcessPool;
  readonly #now: () => number;
  readonly #openDirectories = new Map<string, OpenDirectoryState>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #watchDebounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #auditTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #backgroundRefreshes = new Map<string, AbortController>();
  readonly #activeQueryRoots = new Map<string, number>();
  readonly #readerPinHeartbeats = new Set<ReaderPinHeartbeat>();
  readonly #sliceLocks = new Set<string>();
  readonly #ftsAvailable: boolean;
  readonly #backgroundRefreshEnabled: boolean;
  readonly #maxDatabaseBytes: number;
  readonly #maxFilesPerRoot: number;
  readonly #beforeIncrementalReadForTesting?: () => void | Promise<void>;
  readonly #builderOwner = randomUUID();
  #ownerHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(options: PersistentMemoryIndexOptions) {
    this.databasePath = resolve(options.databasePath);
    this.#queryPool = options.queryPool ?? new MemoryQueryProcessPool();
    this.#now = options.now ?? Date.now;
    this.#backgroundRefreshEnabled = options.backgroundRefresh ?? true;
    if (
      options.resourceLimitsForTesting?.maxDatabaseBytes !== undefined &&
      (!Number.isSafeInteger(
        options.resourceLimitsForTesting.maxDatabaseBytes,
      ) ||
        options.resourceLimitsForTesting.maxDatabaseBytes < 1 ||
        options.resourceLimitsForTesting.maxDatabaseBytes >
          MAX_MEMORY_INDEX_BYTES)
    ) {
      throw new RangeError("memory index test database byte limit is invalid");
    }
    this.#maxDatabaseBytes =
      options.resourceLimitsForTesting?.maxDatabaseBytes ??
      MAX_MEMORY_INDEX_BYTES;
    if (
      options.resourceLimitsForTesting?.maxFilesPerRoot !== undefined &&
      (!Number.isSafeInteger(
        options.resourceLimitsForTesting.maxFilesPerRoot,
      ) ||
        options.resourceLimitsForTesting.maxFilesPerRoot < 1 ||
        options.resourceLimitsForTesting.maxFilesPerRoot >
          MAX_MEMORY_FILES_PER_ROOT)
    ) {
      throw new RangeError("memory index test file-count limit is invalid");
    }
    this.#maxFilesPerRoot =
      options.resourceLimitsForTesting?.maxFilesPerRoot ??
      MAX_MEMORY_FILES_PER_ROOT;
    this.#beforeIncrementalReadForTesting =
      options.beforeIncrementalReadForTesting;
    const { database, ftsAvailable } = openMemoryIndexDatabase(
      this.databasePath,
    );
    this.#db = database;
    this.#ftsAvailable = ftsAvailable;
    if (ftsAvailable) this.#recoverInterruptedEnumeration();
  }

  get ftsAvailable(): boolean {
    return this.#ftsAvailable;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of this.#openDirectories.values()) {
      void state.directory.close().catch(() => undefined);
    }
    activeMemoryBuildOpenDirectories -= this.#openDirectories.size;
    this.#openDirectories.clear();
    for (const watcher of this.#watchers.values()) watcher.close();
    activeMemoryIndexWatchers -= this.#watchers.size;
    this.#watchers.clear();
    if (this.#ownerHeartbeatTimer !== null) {
      clearTimeout(this.#ownerHeartbeatTimer);
      this.#ownerHeartbeatTimer = null;
    }
    for (const timer of this.#watchDebounceTimers.values()) clearTimeout(timer);
    this.#watchDebounceTimers.clear();
    for (const timer of this.#auditTimers.values()) clearTimeout(timer);
    this.#auditTimers.clear();
    for (const controller of this.#backgroundRefreshes.values()) {
      controller.abort(new DOMException("Memory index closed", "AbortError"));
    }
    this.#backgroundRefreshes.clear();
    for (const heartbeat of this.#readerPinHeartbeats) {
      heartbeat.markLost();
      clearInterval(heartbeat.timer);
      try {
        this.#releaseReaderPin(heartbeat.pinned);
      } catch {
        // An orderly close discards the query result, so its pin can be
        // released immediately. SQLite contention falls back to lease expiry.
      }
    }
    this.#readerPinHeartbeats.clear();
    for (const buildKey of activeBuilds) {
      if (buildKey.startsWith(`${this.databasePath}:`)) {
        activeBuilds.delete(buildKey);
      }
    }
    if (this.#ftsAvailable) {
      this.#db
        .prepare("DELETE FROM memory_index_owners WHERE owner_id = ?")
        .run(this.#builderOwner);
    }
    if (this.#db.open) this.#db.close();
  }

  pollRefresh(generationToken: string): MemoryIndexGenerationStatus | null {
    const row = this.#db
      .prepare<
        [string],
        GenerationRow & {
          canonical_path: string;
          root_role: MemoryIndexRootRole;
          watcher_health: MemoryIndexWatcherHealth;
          audit_cursor: string | null;
        }
      >(
        `SELECT g.*, r.canonical_path, r.root_role,
                r.watcher_health, r.audit_cursor
           FROM memory_index_generations g
           JOIN memory_index_roots r ON r.root_id = g.root_id
          WHERE g.generation_token = ?`,
      )
      .get(generationToken);
    if (row === undefined) return null;
    return {
      rootId: row.root_id,
      canonicalRoot: row.canonical_path,
      role: row.root_role,
      generationId: row.id,
      generationToken: row.generation_token,
      state:
        row.state === "complete"
          ? "complete"
          : row.state === "staging"
            ? "refresh_pending"
            : "failed",
      ageMs:
        row.completed_at_ms === null
          ? null
          : Math.max(0, this.#now() - row.completed_at_ms),
      watcherHealth: row.watcher_health,
      auditCursor: row.audit_cursor,
      ...(row.error === null ? {} : { reason: row.error }),
    };
  }

  async cancelRefresh(generationToken: string): Promise<boolean> {
    const generation = this.#db
      .prepare<[string], GenerationRow>(
        `SELECT * FROM memory_index_generations
          WHERE generation_token = ? AND state = 'staging'`,
      )
      .get(generationToken);
    if (generation === undefined) return false;
    this.#backgroundRefreshes
      .get(generation.root_id)
      ?.abort(new DOMException("Memory refresh cancelled", "AbortError"));
    await this.#closeGenerationDirectories(generation.root_id, generation.id);
    this.#releaseBuildLease(generation.id);
    this.#failGeneration(
      generation.id,
      new DOMException("Memory refresh cancelled", "AbortError"),
    );
    activeBuilds.delete(`${this.databasePath}:${generation.root_id}`);
    return true;
  }

  async refresh(
    rootSpecs: readonly MemoryIndexRootSpec[],
    signal: AbortSignal,
    options: MemoryIndexRefreshOptions = {},
  ): Promise<MemoryIndexRefreshResult> {
    throwIfAborted(signal);
    validateRootSpecsBeforeIo(rootSpecs);
    if (!this.#ftsAvailable) {
      return {
        kind: "degraded",
        roots: rootSpecs.map((spec) => unavailableRootStatus(spec)),
      };
    }
    const roots = await bindRoots(rootSpecs, signal);
    for (const root of roots) this.#upsertRoot(root);
    this.#ensureWatchers(roots);
    const deadline =
      performance.now() +
      (options.explicit
        ? MAX_MEMORY_EXPLICIT_REFRESH_WAIT_MS
        : MAX_MEMORY_INDEX_BUILD_SLICE_MS);
    const statuses: MemoryIndexGenerationStatus[] = [];
    for (const root of roots) {
      throwIfAborted(signal);
      let status = await this.#refreshRootSlice(
        root,
        signal,
        options.explicit === true,
      );
      while (
        options.explicit === true &&
        status.state === "refresh_pending" &&
        performance.now() < deadline
      ) {
        await yieldToEventLoop();
        status = await this.#refreshRootSlice(root, signal, false);
      }
      statuses.push(status);
    }
    if (options.explicit !== true && this.#backgroundRefreshEnabled) {
      for (let index = 0; index < roots.length; index += 1) {
        if (statuses[index]?.state === "refresh_pending") {
          this.#scheduleBackgroundRefresh(roots[index]!);
        }
      }
    }
    this.cleanupUnusedRoots();
    if (
      statuses.every(
        (status) =>
          status.state === "complete" && status.watcherHealth === "healthy",
      )
    ) {
      return { kind: "complete", roots: statuses };
    }
    if (statuses.some((status) => status.state === "refresh_pending")) {
      return { kind: "refresh_pending", roots: statuses };
    }
    return { kind: "degraded", roots: statuses };
  }

  async query(
    rootSpecs: readonly MemoryIndexRootSpec[],
    terms: readonly string[],
    signal: AbortSignal,
  ): Promise<MemoryFullCorpusQueryResult> {
    throwIfAborted(signal);
    validateRootSpecsBeforeIo(rootSpecs);
    if (this.#closed) {
      return {
        kind: "unavailable",
        candidates: [],
        freshness: rootSpecs.map((spec) => unavailableRootStatus(spec)),
        reason: "memory index closed while query was in progress",
      };
    }
    if (!this.#ftsAvailable) {
      return {
        kind: "unavailable",
        candidates: [],
        freshness: rootSpecs.map((spec) => unavailableRootStatus(spec)),
        reason: "SQLite FTS5 unicode61 capability is unavailable",
      };
    }
    const match = buildMemoryFtsMatch(terms);
    if (match.length === 0) {
      return { kind: "complete", candidates: [], freshness: [] };
    }
    const roots = await bindRoots(rootSpecs, signal);
    if (this.#closed) {
      return {
        kind: "unavailable",
        candidates: [],
        freshness: rootSpecs.map((spec) => unavailableRootStatus(spec)),
        reason: "memory index closed while query was in progress",
      };
    }
    const pinned = this.#pinCurrentGenerations(roots);
    if (pinned.snapshots.length === 0) {
      return {
        kind: "unavailable",
        candidates: [],
        freshness: pinned.freshness,
        reason:
          pinned.unavailableReason ??
          "no complete full-corpus memory generation is available",
      };
    }
    for (const { root } of pinned.snapshots) {
      this.#acquireQueryRoot(root.rootId);
    }
    const heartbeat = this.#startReaderPinHeartbeat(pinned);
    try {
      const rankedByRoot = await Promise.all(
        pinned.snapshots.map(async ({ root, generation }) => ({
          role: root.role,
          candidates: await this.#queryPool.query(
            {
              databasePath: this.databasePath,
              rootId: root.rootId,
              generationId: generation.id,
              rootRole: root.role,
              match,
              limit: MAX_MEMORY_FTS_CANDIDATES,
            },
            signal,
          ),
        })),
      );
      if (this.#closed) {
        throw new MemoryIndexQueryResourceLimitedError(
          "memory index closed while query was in progress",
        );
      }
      if (heartbeat.lost()) {
        throw new MemoryIndexQueryResourceLimitedError(
          "memory query reader snapshot lease expired before completion",
        );
      }
      const project = rankedByRoot
        .filter((result) => result.role === "project")
        .flatMap((result) => result.candidates);
      const global = rankedByRoot
        .filter((result) => result.role === "global")
        .flatMap((result) => result.candidates);
      const recent = this.#readRecentCandidates(pinned.snapshots);
      if (heartbeat.lost() || !this.#readerPinIsLive(pinned)) {
        throw new MemoryIndexQueryResourceLimitedError(
          "memory query reader snapshot lease expired before completion",
        );
      }
      const candidates = fuseMemoryRanks({ project, global, recent });
      return {
        kind: pinned.freshness.every(
          (status) =>
            status.state === "complete" &&
            status.watcherHealth === "healthy",
        )
          ? "complete"
          : "stale",
        candidates,
        freshness: pinned.freshness,
      };
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (this.#closed) {
        return {
          kind: "unavailable",
          candidates: [],
          freshness: pinned.freshness,
          reason: "memory index closed while query was in progress",
        };
      }
      return {
        kind:
          error instanceof MemoryIndexQueryResourceLimitedError
            ? "query_resource_limited"
            : "unavailable",
        candidates: [],
        freshness: pinned.freshness,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.#stopReaderPinHeartbeat(heartbeat);
      for (const { root } of pinned.snapshots) {
        this.#releaseQueryRoot(root.rootId);
      }
      if (!this.#closed) this.#releaseReaderPin(pinned);
    }
  }

  readHeader(candidate: MemoryRankCandidate): MemoryHeader | null {
    try {
      return rankCandidateToMemoryHeader(candidate);
    } catch {
      return null;
    }
  }

  recordChange(input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly kind: "create" | "update" | "delete" | "rename";
  }): void {
    if (!CHANGE_KIND_VALUES.has(input.kind)) {
      throw new MemoryIndexBoundaryError("memory change kind is invalid");
    }
    if (input.relativePath.length > 0) {
      validatePortableRelativePath(input.relativePath);
    }
    validateMemoryRootPathBeforeIo(input.rootPath);
    const canonicalRoot = realpathSyncExisting(input.rootPath);
    const rootId = memoryIndexRootId(canonicalRoot);
    const root = this.#db
      .prepare<[string], RootRow>(
        "SELECT * FROM memory_index_roots WHERE root_id = ?",
      )
      .get(rootId);
    if (root === undefined) return;
    const count = this.#db
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_index_change_log WHERE root_id = ?",
      )
      .get(rootId)!.count;
    if (count >= MAX_MEMORY_INDEX_CHANGE_LOG_EVENTS) {
      this.#db
        .prepare(
          "UPDATE memory_index_roots SET watcher_health = 'overflow' WHERE root_id = ?",
        )
        .run(rootId);
      this.#db
        .prepare(
          `UPDATE memory_index_generations
              SET change_overflow = 1
            WHERE root_id = ? AND state = 'staging'`,
        )
        .run(rootId);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO memory_index_change_log(
           root_id, relative_path, change_kind, observed_at_ms
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(rootId, input.relativePath, input.kind, this.#now());
  }

  async auditSlice(
    rootSpec: MemoryIndexRootSpec,
    signal: AbortSignal,
  ): Promise<MemoryIndexGenerationStatus> {
    validateRootSpecsBeforeIo([rootSpec]);
    const [root] = await bindRoots([rootSpec], signal);
    if (root === undefined) return unavailableRootStatus(rootSpec);
    const current = this.#currentGeneration(root);
    if (current === null) return this.#rootStatus(root);
    const rootRow = this.#db
      .prepare<[string], RootRow>(
        "SELECT * FROM memory_index_roots WHERE root_id = ?",
      )
      .get(root.rootId)!;
    const started = performance.now();
    const persistedCursor = decodeAuditCursor(rootRow.audit_cursor);
    let phase = persistedCursor.phase;
    let cursor = persistedCursor.relativePath;
    let inspected = 0;
    let nextCursor: string | null = null;
    let directoryChanged = false;

    if (phase === "entries") {
      const rows = this.#db
        .prepare<[string, number, string, number], EntryRow>(
          `SELECT * FROM memory_index_entries
            WHERE root_id = ? AND generation_id = ? AND relative_path > ?
            ORDER BY CAST(relative_path AS BLOB)
            LIMIT ?`,
        )
        .all(
          root.rootId,
          current.generation.id,
          cursor,
          MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE,
        );
      let processedAllRows = true;
      for (const row of rows) {
        throwIfAborted(signal);
        if (performance.now() - started >= MAX_MEMORY_AUDIT_MS_PER_SLICE) {
          processedAllRows = false;
          break;
        }
        cursor = row.relative_path;
        inspected += 1;
        const path = join(root.canonicalRoot, row.relative_path);
        try {
          const indexed = await readIndexedHeader(
            root,
            row.relative_path,
            path,
            signal,
          );
          if (indexed === null || indexed.fingerprint !== row.fingerprint) {
            this.recordChange({
              rootPath: root.canonicalRoot,
              relativePath: row.relative_path,
              kind: "update",
            });
          }
        } catch {
          throwIfAborted(signal);
          this.recordChange({
            rootPath: root.canonicalRoot,
            relativePath: row.relative_path,
            kind: "delete",
          });
        }
      }
      if (
        !processedAllRows ||
        rows.length === MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE
      ) {
        nextCursor = encodeAuditCursor("entries", cursor);
      } else {
        phase = "directories";
        cursor = "";
      }
    }

    if (
      phase === "directories" &&
      nextCursor === null &&
      inspected < MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE &&
      performance.now() - started < MAX_MEMORY_AUDIT_MS_PER_SLICE
    ) {
      const remaining = MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE - inspected;
      const rows = this.#db
        .prepare<[string, number, string, string, number], WorkDirectoryRow>(
          `SELECT relative_path, state, dev, ino, mtime_ns
             FROM memory_index_directory_work
            WHERE root_id = ? AND generation_id = ?
              AND (? = '' OR relative_path > ?)
            ORDER BY CAST(relative_path AS BLOB)
            LIMIT ?`,
        )
        .all(root.rootId, current.generation.id, cursor, cursor, remaining);
      let processedAllRows = true;
      for (const row of rows) {
        throwIfAborted(signal);
        if (performance.now() - started >= MAX_MEMORY_AUDIT_MS_PER_SLICE) {
          processedAllRows = false;
          break;
        }
        cursor = row.relative_path;
        inspected += 1;
        try {
          const identity = await readDirectoryIdentity(
            join(root.canonicalRoot, row.relative_path),
            signal,
          );
          if (
            identity.dev.toString() !== row.dev ||
            identity.ino.toString() !== row.ino ||
            identity.mtimeNs.toString() !== row.mtime_ns
          ) {
            directoryChanged = true;
          }
        } catch {
          throwIfAborted(signal);
          directoryChanged = true;
        }
      }
      if (!processedAllRows || rows.length === remaining) {
        nextCursor = encodeAuditCursor("directories", cursor);
      }
    }
    if (
      phase === "directories" &&
      nextCursor === null &&
      (inspected >= MAX_MEMORY_AUDIT_ENTRIES_PER_SLICE ||
        performance.now() - started >= MAX_MEMORY_AUDIT_MS_PER_SLICE)
    ) {
      nextCursor = encodeAuditCursor("directories", cursor);
    }
    this.#db
      .prepare(
        `UPDATE memory_index_roots
            SET audit_cursor = ?,
                watcher_health = CASE
                  WHEN ? = 1 THEN 'degraded'
                  ELSE watcher_health
                END
          WHERE root_id = ?`,
      )
      .run(nextCursor, directoryChanged ? 1 : 0, root.rootId);
    return this.#rootStatus(root);
  }

  cleanupUnusedRoots(): number {
    const started = performance.now();
    const now = this.#now();
    const cutoff = now - MEMORY_INDEX_ROOT_IDLE_TTL_MS;
    const rows = this.#db
      .prepare<
        [number, number, number, string, number, number],
        RootRow
      >(
        `SELECT * FROM memory_index_roots
          WHERE last_used_at_ms <= ?
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_generations g
               WHERE g.root_id = memory_index_roots.root_id
                 AND g.state = 'staging'
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_reader_pins p
              JOIN memory_index_generations g ON g.id = p.generation_id
               WHERE g.root_id = memory_index_roots.root_id
                 AND p.lease_expires_at_ms > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_owners o
               WHERE o.root_id = memory_index_roots.root_id
                 AND o.lease_expires_at_ms > ?
                 AND o.owner_id <> ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_generations g
               WHERE g.root_id = memory_index_roots.root_id
                 AND g.builder_owner IS NOT NULL
                 AND g.builder_lease_expires_at_ms > ?
            )
          ORDER BY last_used_at_ms, root_id
          LIMIT ?`,
      )
      .all(
        cutoff,
        now,
        now,
        this.#builderOwner,
        now,
        MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH,
      );
    let removed = 0;
    for (const row of rows) {
      if (
        performance.now() - started >=
        MAX_MEMORY_INDEX_CLEANUP_MS_PER_SLICE
      ) {
        break;
      }
      if (this.#rootHasActiveLocalWork(row.root_id)) continue;
      if (this.#deleteIndexedRoot(row.root_id, now)) removed += 1;
    }
    return removed;
  }

  #ensureWatchers(roots: readonly BoundRoot[]): void {
    for (const root of roots) {
      if (this.#watchers.has(root.rootId)) {
        this.#renewWatcherOwner(root.rootId);
        continue;
      }
      if (activeMemoryIndexWatchers >= MAX_MEMORY_INDEX_WATCHERS) {
        this.#db
          .prepare(
            "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
          )
          .run(root.rootId);
        continue;
      }
      try {
        const watcher = watch(
          root.canonicalRoot,
          { persistent: false, recursive: true },
          (_eventType, filename) => {
            const relativePath =
              filename === null ? "" : String(filename).normalize("NFC");
            this.#recordWatcherChange(root, relativePath);
          },
        );
        watcher.on("error", () => {
          if (this.#closed) return;
          if (this.#watchers.get(root.rootId) === watcher) {
            watcher.close();
            this.#watchers.delete(root.rootId);
            activeMemoryIndexWatchers -= 1;
            try {
              this.#releaseWatcherOwner(root.rootId);
            } catch {
              // The bounded lease expires if SQLite is temporarily unavailable.
            }
            const auditTimer = this.#auditTimers.get(root.rootId);
            if (auditTimer !== undefined) {
              clearTimeout(auditTimer);
              this.#auditTimers.delete(root.rootId);
            }
          }
          try {
            this.#db
              .prepare(
                "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
              )
              .run(root.rootId);
          } catch {
            // A watcher error must never escape an EventEmitter callback.
          }
        });
        this.#watchers.set(root.rootId, watcher);
        activeMemoryIndexWatchers += 1;
        try {
          this.#renewWatcherOwner(root.rootId);
        } catch (error) {
          watcher.close();
          this.#watchers.delete(root.rootId);
          activeMemoryIndexWatchers -= 1;
          throw error;
        }
        this.#ensureOwnerHeartbeat();
        this.#scheduleAudit(root, MEMORY_AUDIT_MIN_INTERVAL_MS);
      } catch {
        this.#db
          .prepare(
            "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
          )
          .run(root.rootId);
      }
    }
  }

  #renewWatcherOwner(rootId: string): void {
    this.#db
      .prepare(
        `INSERT INTO memory_index_owners(
           root_id, owner_id, kind, lease_expires_at_ms
         ) VALUES (?, ?, 'watcher', ?)
         ON CONFLICT(root_id, owner_id, kind) DO UPDATE SET
           lease_expires_at_ms = excluded.lease_expires_at_ms`,
      )
      .run(
        rootId,
        this.#builderOwner,
        this.#now() + MEMORY_INDEX_OWNER_LEASE_MS,
      );
  }

  #releaseWatcherOwner(rootId: string): void {
    this.#db
      .prepare(
        `DELETE FROM memory_index_owners
          WHERE root_id = ? AND owner_id = ? AND kind = 'watcher'`,
      )
      .run(rootId, this.#builderOwner);
  }

  #ensureOwnerHeartbeat(): void {
    if (this.#closed || this.#ownerHeartbeatTimer !== null) return;
    const timer = setTimeout(() => {
      this.#ownerHeartbeatTimer = null;
      if (this.#closed) return;
      for (const rootId of this.#watchers.keys()) {
        try {
          this.#renewWatcherOwner(rootId);
        } catch {
          try {
            this.#db
              .prepare(
                "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
              )
              .run(rootId);
          } catch {
            // The next heartbeat retries both ownership and health persistence.
          }
        }
      }
      if (this.#watchers.size > 0) this.#ensureOwnerHeartbeat();
    }, MEMORY_INDEX_OWNER_HEARTBEAT_MS);
    timer.unref?.();
    this.#ownerHeartbeatTimer = timer;
  }

  #recordWatcherChange(root: BoundRoot, relativePath: string): void {
    try {
      this.recordChange({
        rootPath: root.canonicalRoot,
        relativePath,
        kind: "update",
      });
    } catch {
      this.#db
        .prepare(
          "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
        )
        .run(root.rootId);
      return;
    }
    const key = `${root.rootId}:${relativePath}`;
    const prior = this.#watchDebounceTimers.get(key);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.#watchDebounceTimers.delete(key);
      this.#scheduleBackgroundRefresh(root);
    }, MEMORY_WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.#watchDebounceTimers.set(key, timer);
  }

  #scheduleAudit(root: BoundRoot, delayMs: number): void {
    if (this.#closed || this.#auditTimers.has(root.rootId)) return;
    const timer = setTimeout(() => {
      this.#auditTimers.delete(root.rootId);
      const startedAt = performance.now();
      void this.auditSlice(
        { path: root.canonicalRoot, role: root.role },
        new AbortController().signal,
      )
        .then((status) => {
          if (status.watcherHealth !== "healthy") {
            this.#scheduleBackgroundRefresh(root);
          }
        })
        .catch(() => {
          this.#db
            .prepare(
              "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
            )
            .run(root.rootId);
        })
        .finally(() => {
          const duration = Math.max(1, performance.now() - startedAt);
          const nextDelay = Math.max(
            MEMORY_AUDIT_MIN_INTERVAL_MS,
            Math.min(
              MEMORY_AUDIT_MAX_INTERVAL_MS,
              Math.ceil(duration * MEMORY_AUDIT_BACKOFF_MULTIPLIER),
            ),
          );
          this.#scheduleAudit(root, nextDelay);
        });
    }, delayMs);
    timer.unref?.();
    this.#auditTimers.set(root.rootId, timer);
  }

  #scheduleBackgroundRefresh(root: BoundRoot): void {
    if (this.#closed || this.#backgroundRefreshes.has(root.rootId)) return;
    const controller = new AbortController();
    this.#backgroundRefreshes.set(root.rootId, controller);
    void this.#continueBackgroundRefresh(root, controller).finally(() => {
      if (this.#backgroundRefreshes.get(root.rootId) === controller) {
        this.#backgroundRefreshes.delete(root.rootId);
      }
    });
  }

  async #continueBackgroundRefresh(
    root: BoundRoot,
    controller: AbortController,
  ): Promise<void> {
    while (!controller.signal.aborted) {
      const status = await this.#refreshRootSlice(
        root,
        controller.signal,
        false,
      ).catch(() => null);
      if (status === null || status.state !== "refresh_pending") return;
      if (status.reason === MEMORY_INDEX_INCREMENTAL_CONTENTION_REASON) {
        await waitForIncrementalRetry(controller.signal);
      } else {
        await yieldToEventLoop();
      }
    }
  }

  async #refreshRootSlice(
    root: BoundRoot,
    signal: AbortSignal,
    forceRebuild: boolean,
  ): Promise<MemoryIndexGenerationStatus> {
    const buildKey = `${this.databasePath}:${root.rootId}`;
    this.#upsertRoot(root);
    const staging = this.#stagingGeneration(root.rootId);
    const current = this.#currentGeneration(root);
    const persistedRoot = this.#db
      .prepare<[string], RootRow>(
        "SELECT * FROM memory_index_roots WHERE root_id = ?",
      )
      .get(root.rootId)!;
    const latestChangeCursor = this.#latestChangeCursor(root.rootId);
    if (
      !forceRebuild &&
      staging === null &&
      current !== null &&
      persistedRoot.watcher_health === "healthy" &&
      latestChangeCursor <= current.generation.change_cursor
    ) {
      return this.#rootStatus(root);
    }
    if (this.#sliceLocks.has(buildKey)) {
      return {
        ...this.#rootStatus(root),
        state: "refresh_pending",
        reason: "memory index build slice is already active",
      };
    }
    if (!activeBuilds.has(buildKey)) {
      if (activeBuilds.size >= MAX_MEMORY_INDEX_CONCURRENT_BUILDS) {
        return {
          ...this.#rootStatus(root),
          state: "refresh_pending",
          reason: "global memory index build concurrency limit reached",
        };
      }
      activeBuilds.add(buildKey);
    }
    this.#sliceLocks.add(buildKey);
    try {
      if (
        !forceRebuild &&
        staging === null &&
        current !== null &&
        latestChangeCursor > current.generation.change_cursor &&
        persistedRoot.watcher_health === "healthy"
      ) {
        if (!this.#claimBuildLease(current.generation.id)) {
          activeBuilds.delete(buildKey);
          return {
            ...this.#rootStatus(root),
            state: "refresh_pending",
            reason: MEMORY_INDEX_INCREMENTAL_CONTENTION_REASON,
          };
        }
        try {
          await this.#beforeIncrementalReadForTesting?.();
          const status = await this.#applyIncrementalChanges(
            root,
            current.generation,
            signal,
          );
          if (status.state !== "refresh_pending") activeBuilds.delete(buildKey);
          return status;
        } finally {
          this.#releaseBuildLease(current.generation.id);
        }
      }
      const generation = this.#beginOrResumeGeneration(root);
      if (!this.#claimBuildLease(generation.id)) {
        activeBuilds.delete(buildKey);
        return {
          ...this.#rootStatus(root),
          state: "refresh_pending",
          reason: "another daemon owns the bounded memory index writer lease",
        };
      }
      try {
        const status = await this.#runBuildSlice(root, generation, signal);
        if (status.state !== "refresh_pending") activeBuilds.delete(buildKey);
        return status;
      } finally {
        this.#releaseBuildLease(generation.id);
      }
    } catch (error) {
      activeBuilds.delete(buildKey);
      if (signal.aborted) throw abortReason(signal);
      const generation = this.#stagingGeneration(root.rootId);
      if (generation !== null) {
        await this.#closeGenerationDirectories(root.rootId, generation.id);
        this.#failGeneration(generation.id, error);
      }
      return {
        ...this.#rootStatus(root),
        state: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.#sliceLocks.delete(buildKey);
    }
  }

  async #applyIncrementalChanges(
    root: BoundRoot,
    generation: GenerationRow,
    signal: AbortSignal,
  ): Promise<MemoryIndexGenerationStatus> {
    const startedAt = performance.now();
    const changes = this.#db
      .prepare<[string, number, number], IncrementalChangeRow>(
        `SELECT sequence, relative_path, change_kind
           FROM memory_index_change_log
          WHERE root_id = ? AND sequence > ?
          ORDER BY sequence
          LIMIT ?`,
      )
      .all(
        root.rootId,
        generation.change_cursor,
        MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE,
      );
    if (
      changes.some(
        (change) =>
          change.relative_path.length === 0 ||
          !change.relative_path.endsWith(".md"),
      )
    ) {
      this.#db
        .prepare(
          "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
        )
        .run(root.rootId);
      return {
        ...this.#rootStatus(root),
        state: "refresh_pending",
        reason: "directory watcher change requires a bounded full rebuild",
      };
    }
    const coalesced = new Map<string, IncrementalChangeRow>();
    for (const change of changes) coalesced.set(change.relative_path, change);
    const prepared: PreparedIncrementalChange[] = [];
    let incrementalReadFailed = false;
    let lastSequence = generation.change_cursor;
    const orderedChanges = [...coalesced.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const change of orderedChanges) {
      throwIfAborted(signal);
      if (performance.now() - startedAt >= MAX_MEMORY_INDEX_BUILD_SLICE_MS)
        break;
      lastSequence = Math.max(lastSequence, change.sequence);
      if (change.change_kind === "delete") {
        prepared.push({
          sequence: change.sequence,
          relativePath: change.relative_path,
          indexed: null,
        });
        continue;
      }
      try {
        const indexed = await readIndexedHeader(
          root,
          change.relative_path,
          join(root.canonicalRoot, change.relative_path),
          signal,
        );
        prepared.push({
          sequence: change.sequence,
          relativePath: change.relative_path,
          indexed,
        });
      } catch (error) {
        throwIfAborted(signal);
        if (errnoCode(error) !== "ENOENT") incrementalReadFailed = true;
        prepared.push({
          sequence: change.sequence,
          relativePath: change.relative_path,
          indexed: errnoCode(error) === "ENOENT" ? null : undefined,
        });
      }
    }
    if (incrementalReadFailed) {
      this.#db
        .prepare(
          "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
        )
        .run(root.rootId);
    }
    const changedDirectories = new Map<string, DirectoryIdentity>();
    for (const change of prepared) {
      const directoryPath = dirname(change.relativePath);
      const relativeDirectory = directoryPath === "." ? "" : directoryPath;
      if (changedDirectories.has(relativeDirectory)) continue;
      try {
        changedDirectories.set(
          relativeDirectory,
          await readDirectoryIdentity(
            join(root.canonicalRoot, relativeDirectory),
            signal,
          ),
        );
      } catch {
        throwIfAborted(signal);
        incrementalReadFailed = true;
        this.#db
          .prepare(
            "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
          )
          .run(root.rootId);
      }
    }
    if (prepared.length === 0 && changes.length > 0) {
      return {
        ...this.#rootStatus(root),
        state: "refresh_pending",
      };
    }
    const databaseBytesBefore = databaseBytes(this.#db);
    const applied = this.#db
      .transaction(() => {
        const now = this.#now();
        const ownership = this.#db
          .prepare<
            [number, string, string, number, number],
            { present: number }
          >(
            `SELECT 1 AS present
               FROM memory_index_generations g
               JOIN memory_index_roots r ON r.current_generation_id = g.id
              WHERE g.id = ? AND g.root_id = ? AND g.state = 'complete'
                AND g.builder_owner = ?
                AND g.builder_lease_expires_at_ms > ?
                AND NOT EXISTS (
                  SELECT 1 FROM memory_index_reader_pins p
                   WHERE p.generation_id = g.id
                     AND p.lease_expires_at_ms > ?
                )`,
          )
          .get(
            generation.id,
            root.rootId,
            this.#builderOwner,
            now,
            now,
          );
        if (ownership === undefined) return false;
        this.#db
          .prepare(
            `UPDATE memory_index_generations
                SET builder_lease_expires_at_ms = ?
              WHERE id = ? AND builder_owner = ?`,
          )
          .run(
            now + MEMORY_INDEX_BUILD_LEASE_MS,
            generation.id,
            this.#builderOwner,
          );
        for (const change of prepared) {
          if (change.indexed === null) {
            this.#removeStagingPath(
              root.rootId,
              generation.id,
              change.relativePath,
            );
          }
        }
        for (const change of prepared) {
          if (change.indexed !== null && change.indexed !== undefined) {
            this.#upsertIndexedEntry(
              root,
              generation.id,
              change.relativePath,
              change.indexed,
            );
          }
        }
        for (const [relativePath, identity] of changedDirectories) {
          this.#db
            .prepare(
              `UPDATE memory_index_directory_work
                  SET dev = ?, ino = ?, mtime_ns = ?
                WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
            )
            .run(
              identity.dev.toString(),
              identity.ino.toString(),
              identity.mtimeNs.toString(),
              root.rootId,
              generation.id,
              relativePath,
            );
        }
        this.#db
          .prepare(
            `UPDATE memory_index_generations
                SET change_cursor = ?, completed_at_ms = ?,
                    elapsed_active_ms = elapsed_active_ms + ?
              WHERE id = ? AND state = 'complete'`,
          )
          .run(
            lastSequence,
            now,
            Math.ceil(Math.max(0, performance.now() - startedAt)),
            generation.id,
          );
        this.#db
          .prepare(
            "UPDATE memory_index_roots SET last_used_at_ms = ? WHERE root_id = ?",
          )
          .run(now, root.rootId);
        this.#db
          .prepare(
            "DELETE FROM memory_index_change_log WHERE root_id = ? AND sequence <= ?",
          )
          .run(root.rootId, lastSequence);
        if (
          databaseBytes(this.#db) >
          Math.max(this.#maxDatabaseBytes, databaseBytesBefore)
        ) {
          throw new MemoryIndexBoundaryError(
            "memory index database byte limit crossed",
          );
        }
        return true;
      })
      .immediate();
    if (!applied) {
      return {
        ...this.#rootStatus(root),
        state: "refresh_pending",
        reason: MEMORY_INDEX_INCREMENTAL_CONTENTION_REASON,
      };
    }
    if (incrementalReadFailed) {
      return {
        ...this.#rootStatus(root),
        state: "refresh_pending",
        reason: "incremental memory update requires a bounded full rebuild",
      };
    }
    const remaining = this.#latestChangeCursor(root.rootId) > lastSequence;
    return remaining
      ? { ...this.#rootStatus(root), state: "refresh_pending" }
      : this.#rootStatus(root);
  }

  #beginOrResumeGeneration(root: BoundRoot): GenerationRow {
    const existing = this.#stagingGeneration(root.rootId);
    if (existing !== null) return existing;
    const changeCursor = this.#latestChangeCursor(root.rootId);
    const generationId = Number(
      this.#db
        .prepare(
          `INSERT INTO memory_index_generations(
             root_id, state, generation_token, started_at_ms,
             completed_at_ms, elapsed_active_ms, entry_count, indexed_bytes,
             discovery_operations, discovered_file_count, digest, change_cursor,
             change_overflow, error, builder_owner,
             builder_lease_expires_at_ms
           ) VALUES (
             ?, 'staging', ?, ?, NULL, 0, 0, 0, 0, 0, NULL, ?, 0, NULL,
             NULL, NULL
           )`,
        )
        .run(root.rootId, randomUUID(), this.#now(), changeCursor)
        .lastInsertRowid,
    );
    this.#db
      .prepare(
        `INSERT INTO memory_index_directory_work(
           root_id, generation_id, relative_path, state, dev, ino, mtime_ns
         ) VALUES (?, ?, '', 'pending', ?, ?, ?)`,
      )
      .run(
        root.rootId,
        generationId,
        root.identity.dev.toString(),
        root.identity.ino.toString(),
        root.identity.mtimeNs.toString(),
      );
    return this.#generationById(generationId)!;
  }

  async #runBuildSlice(
    root: BoundRoot,
    generation: GenerationRow,
    signal: AbortSignal,
  ): Promise<MemoryIndexGenerationStatus> {
    const budget: BuildSliceBudget = {
      startedAt: performance.now(),
      newEntries: 0,
      operations: 0,
    };
    while (!sliceExhausted(budget)) {
      throwIfAborted(signal);
      const directory = this.#nextDirectory(root.rootId, generation.id);
      if (directory !== null) {
        const advanced = await this.#enumerateDirectory(
          root,
          generation,
          directory,
          budget,
          signal,
        );
        if (!advanced) break;
        continue;
      }
      const file = this.#nextDiscoveredFile(root.rootId, generation.id);
      if (file !== null) {
        await this.#indexDiscoveredFile(root, generation, file, signal);
        budget.newEntries += 1;
        budget.operations += 1;
        continue;
      }
      const currentGeneration = this.#generationById(generation.id);
      if (currentGeneration === null) {
        throw new Error("memory staging generation disappeared");
      }
      if (currentGeneration.change_overflow !== 0) {
        throw new MemoryIndexBoundaryError(
          "memory change log overflowed during staging generation",
        );
      }
      const replayed = this.#replayChanges(root, currentGeneration);
      if (replayed > 0) continue;
      this.#recordSliceElapsed(
        generation.id,
        budget.startedAt,
        budget.operations,
      );
      this.#publishGeneration(root, generation.id);
      return this.#rootStatus(root);
    }
    this.#recordSliceElapsed(
      generation.id,
      budget.startedAt,
      budget.operations,
    );
    const updated = this.#generationById(generation.id)!;
    if (updated.elapsed_active_ms > MAX_MEMORY_INDEX_TOTAL_BUILD_MS) {
      throw new MemoryIndexBoundaryError(
        "memory index total active build time exceeds limit",
      );
    }
    while (
      databaseBytes(this.#db) > this.#maxDatabaseBytes &&
      this.#evictLeastRecentlyUsedRoot(root.rootId)
    ) {
      // Evict only inactive, non-building roots before rejecting this build.
    }
    if (databaseBytes(this.#db) > this.#maxDatabaseBytes) {
      throw new MemoryIndexBoundaryError(
        "memory index database byte limit crossed",
      );
    }
    return {
      ...this.#rootStatus(root),
      state: "refresh_pending",
      generationId: generation.id,
      generationToken: generation.generation_token,
    };
  }

  async #enumerateDirectory(
    root: BoundRoot,
    generation: GenerationRow,
    work: WorkDirectoryRow,
    budget: BuildSliceBudget,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = openDirectoryKey(
      root.rootId,
      generation.id,
      work.relative_path,
    );
    let openState = this.#openDirectories.get(key);
    if (openState === undefined) {
      if (
        activeMemoryBuildOpenDirectories >= MAX_MEMORY_BUILD_OPEN_DIRECTORIES
      ) {
        return false;
      }
      const absolutePath = join(root.canonicalRoot, work.relative_path);
      const before = await readDirectoryIdentity(absolutePath, signal);
      if (
        before.dev.toString() !== work.dev ||
        before.ino.toString() !== work.ino
      ) {
        this.#requeueDirectory(root, generation.id, work.relative_path, before);
        return true;
      }
      const directory = await opendir(absolutePath);
      openState = { directory, absolutePath, beforeIdentity: before };
      this.#openDirectories.set(key, openState);
      activeMemoryBuildOpenDirectories += 1;
      this.#db
        .prepare(
          `UPDATE memory_index_directory_work
              SET state = 'enumerating', dev = ?, ino = ?, mtime_ns = ?
            WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
        )
        .run(
          before.dev.toString(),
          before.ino.toString(),
          before.mtimeNs.toString(),
          root.rootId,
          generation.id,
          work.relative_path,
        );
    }
    while (!sliceExhausted(budget)) {
      throwIfAborted(signal);
      const entry = await openState.directory.read();
      if (entry === null) {
        await openState.directory.close().catch(() => undefined);
        this.#openDirectories.delete(key);
        activeMemoryBuildOpenDirectories -= 1;
        const after = await readDirectoryIdentity(
          openState.absolutePath,
          signal,
        );
        if (!sameDirectoryIdentity(openState.beforeIdentity, after)) {
          this.#requeueDirectory(
            root,
            generation.id,
            work.relative_path,
            after,
          );
          this.recordChange({
            rootPath: root.canonicalRoot,
            relativePath: work.relative_path,
            kind: "update",
          });
          return true;
        }
        this.#db
          .prepare(
            `UPDATE memory_index_directory_work SET state = 'complete'
              WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
          )
          .run(root.rootId, generation.id, work.relative_path);
        return true;
      }
      budget.operations += 1;
      if (entry.isSymbolicLink()) continue;
      const relativePath = work.relative_path
        ? join(work.relative_path, entry.name)
        : entry.name;
      validatePortableRelativePath(relativePath);
      if (entry.isDirectory()) {
        const identity = await readDirectoryIdentity(
          join(root.canonicalRoot, relativePath),
          signal,
        );
        const result = this.#db
          .prepare(
            `INSERT OR IGNORE INTO memory_index_directory_work(
               root_id, generation_id, relative_path, state, dev, ino, mtime_ns
             ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            root.rootId,
            generation.id,
            relativePath,
            identity.dev.toString(),
            identity.ino.toString(),
            identity.mtimeNs.toString(),
          );
        budget.newEntries += result.changes;
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        basename(entry.name) !== "MEMORY.md"
      ) {
        budget.newEntries += this.#db
          .transaction(() =>
            this.#insertDiscoveredFile(
              root.rootId,
              generation.id,
              relativePath,
              false,
            ),
          )
          .immediate();
      }
    }
    return true;
  }

  async #indexDiscoveredFile(
    root: BoundRoot,
    generation: GenerationRow,
    discovered: DiscoveredFileRow,
    signal: AbortSignal,
  ): Promise<void> {
    const absolutePath = join(root.canonicalRoot, discovered.relative_path);
    try {
      const indexed = await readIndexedHeader(
        root,
        discovered.relative_path,
        absolutePath,
        signal,
      );
      if (indexed === null) {
        this.#removeStagingPath(
          root.rootId,
          generation.id,
          discovered.relative_path,
        );
        this.#markDiscoveredComplete(
          root.rootId,
          generation.id,
          discovered.relative_path,
        );
        return;
      }
      this.#db
        .transaction(() => {
          this.#upsertIndexedEntry(
            root,
            generation.id,
            discovered.relative_path,
            indexed,
          );
          this.#markDiscoveredComplete(
            root.rootId,
            generation.id,
            discovered.relative_path,
          );
        })
        .immediate();
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (errnoCode(error) === "ENOENT") {
        this.#removeStagingPath(
          root.rootId,
          generation.id,
          discovered.relative_path,
        );
        this.#markDiscoveredComplete(
          root.rootId,
          generation.id,
          discovered.relative_path,
        );
        return;
      }
      this.#db
        .prepare(
          `UPDATE memory_index_discovered_files
              SET state = 'diagnosed', error = ?
            WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
        )
        .run(
          error instanceof Error ? error.message : String(error),
          root.rootId,
          generation.id,
          discovered.relative_path,
        );
    }
  }

  #upsertIndexedEntry(
    root: BoundRoot,
    generationId: number,
    relativePath: string,
    indexed: IndexedMemoryHeader,
  ): void {
    const prior = this.#db
      .prepare<
        [string, number, string],
        { canonical_path: string; fingerprint: string }
      >(
        `SELECT canonical_path, fingerprint FROM memory_index_entries
          WHERE root_id = ? AND generation_id = ? AND memory_id = ?`,
      )
      .get(root.rootId, generationId, indexed.memoryId);
    if (prior === undefined) {
      const generation = this.#generationById(generationId);
      if (
        generation === null ||
        generation.entry_count >= this.#maxFilesPerRoot
      ) {
        throw new MemoryIndexBoundaryError(
          "memory file count per root exceeds limit",
        );
      }
    }
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO memory_index_entries(
           root_id, generation_id, memory_id, relative_path,
           canonical_path, title, description, memory_type, mtime_ms,
           file_size, fingerprint, last_seen_generation,
           file_dev, file_ino, file_mode, file_mtime_ns, file_ctime_ns,
           root_dev, root_ino, root_mode, root_size, root_mtime_ns,
           root_ctime_ns
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        root.rootId,
        generationId,
        indexed.memoryId,
        relativePath,
        indexed.canonicalPath,
        indexed.title,
        indexed.description,
        indexed.type,
        indexed.mtimeMs,
        indexed.fileSize,
        indexed.fingerprint,
        generationId,
        indexed.fileIdentity.dev.toString(),
        indexed.fileIdentity.ino.toString(),
        indexed.fileIdentity.mode.toString(),
        indexed.fileIdentity.mtimeNs.toString(),
        indexed.fileIdentity.ctimeNs.toString(),
        root.identity.dev.toString(),
        root.identity.ino.toString(),
        root.identity.mode.toString(),
        root.identity.size.toString(),
        root.identity.mtimeNs.toString(),
        root.identity.ctimeNs.toString(),
      );
    this.#db
      .prepare(
        `DELETE FROM memory_fts
          WHERE root_id = ? AND generation_id = ? AND memory_id = ?`,
      )
      .run(root.rootId, generationId, indexed.memoryId);
    this.#db
      .prepare(
        `INSERT INTO memory_fts(
           root_id, generation_id, memory_id, title, description
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        root.rootId,
        generationId,
        indexed.memoryId,
        normalizeSearchableMetadata(indexed.title),
        normalizeSearchableMetadata(indexed.description),
      );
    this.#advanceGenerationProgress({
      generationId,
      ...(prior === undefined
        ? {}
        : {
            previous: {
              canonicalPath: prior.canonical_path,
              fingerprint: prior.fingerprint,
            },
          }),
      next: {
        canonicalPath: indexed.canonicalPath,
        fingerprint: indexed.fingerprint,
      },
      entryDelta: prior === undefined ? 1 : 0,
      byteDelta:
        indexedEntryBytes(indexed.canonicalPath, indexed.fingerprint) -
        (prior === undefined
          ? 0
          : indexedEntryBytes(prior.canonical_path, prior.fingerprint)),
    });
  }

  #replayChanges(root: BoundRoot, generation: GenerationRow): number {
    const changes = this.#db
      .prepare<
        [string, number, number],
        { sequence: number; relative_path: string; change_kind: string }
      >(
        `SELECT sequence, relative_path, change_kind
           FROM memory_index_change_log
          WHERE root_id = ? AND sequence > ?
          ORDER BY sequence
          LIMIT ?`,
      )
      .all(
        root.rootId,
        generation.change_cursor,
        MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE,
      );
    if (changes.length === 0) return 0;
    if (
      changes.some(
        (change) =>
          change.relative_path.length === 0 ||
          !change.relative_path.endsWith(".md"),
      )
    ) {
      this.#db
        .transaction(() => {
          this.#db
            .prepare(
              "UPDATE memory_index_roots SET watcher_health = 'degraded' WHERE root_id = ?",
            )
            .run(root.rootId);
          this.#db
            .prepare(
              "UPDATE memory_index_generations SET change_overflow = 1 WHERE id = ?",
            )
            .run(generation.id);
        })
        .immediate();
      throw new MemoryIndexBoundaryError(
        "directory watcher change invalidated the staging generation",
      );
    }
    this.#db
      .transaction(() => {
        let cursor = generation.change_cursor;
        for (const change of changes) {
          cursor = change.sequence;
          if (change.change_kind === "delete") {
            this.#removeStagingPath(
              root.rootId,
              generation.id,
              change.relative_path,
            );
          } else if (change.relative_path.endsWith(".md")) {
            this.#insertDiscoveredFile(
              root.rootId,
              generation.id,
              change.relative_path,
              true,
            );
          }
        }
        this.#db
          .prepare(
            "UPDATE memory_index_generations SET change_cursor = ? WHERE id = ?",
          )
          .run(cursor, generation.id);
      })
      .immediate();
    return changes.length;
  }

  #publishGeneration(root: BoundRoot, generationId: number): void {
    const integrity = this.#generationIntegrity(root.rootId, generationId);
    if (databaseBytes(this.#db) > this.#maxDatabaseBytes) {
      throw new MemoryIndexBoundaryError(
        "memory index database byte limit crossed",
      );
    }
    const now = this.#now();
    this.#db
      .transaction(() => {
        const pendingDirectories = this.#db
          .prepare<[string, number], { count: number }>(
            `SELECT COUNT(*) AS count FROM memory_index_directory_work
              WHERE root_id = ? AND generation_id = ? AND state <> 'complete'`,
          )
          .get(root.rootId, generationId)!.count;
        const pendingFiles = this.#db
          .prepare<[string, number], { count: number }>(
            `SELECT COUNT(*) AS count FROM memory_index_discovered_files
              WHERE root_id = ? AND generation_id = ? AND state = 'pending'`,
          )
          .get(root.rootId, generationId)!.count;
        const generation = this.#generationById(generationId);
        if (generation === null) {
          throw new Error("memory staging generation disappeared");
        }
        const discoveredFiles = this.#db
          .prepare<[string, number], { count: number }>(
            `SELECT COUNT(*) AS count FROM memory_index_discovered_files
              WHERE root_id = ? AND generation_id = ?`,
          )
          .get(root.rootId, generationId)!.count;
        if (pendingDirectories !== 0 || pendingFiles !== 0) {
          throw new Error("memory index generation is not converged");
        }
        if (discoveredFiles !== generation.discovered_file_count) {
          throw new Error("memory discovered-file count is inconsistent");
        }
        this.#db
          .prepare(
            "DELETE FROM memory_index_discovered_files WHERE generation_id = ?",
          )
          .run(generationId);
        const previous = this.#db
          .prepare<[string], { current_generation_id: number | null }>(
            "SELECT current_generation_id FROM memory_index_roots WHERE root_id = ?",
          )
          .get(root.rootId)!.current_generation_id;
        this.#db
          .prepare(
            `UPDATE memory_index_generations
                SET state = 'complete', completed_at_ms = ?, entry_count = ?,
                    indexed_bytes = ?, digest = ?, discovered_file_count = 0,
                    error = NULL
              WHERE id = ? AND state = 'staging'`,
          )
          .run(
            now,
            integrity.entryCount,
            integrity.indexedBytes,
            integrity.digest,
            generationId,
          );
        this.#db
          .prepare(
            `UPDATE memory_index_roots
                SET current_generation_id = ?, last_used_at_ms = ?,
                    audit_cursor = NULL
              WHERE root_id = ?`,
          )
          .run(generationId, now, root.rootId);
        if (previous !== null && previous !== generationId) {
          this.#db
            .prepare(
              "UPDATE memory_index_generations SET state = 'superseded' WHERE id = ?",
            )
            .run(previous);
        }
        this.#db
          .prepare(
            `DELETE FROM memory_index_change_log
              WHERE root_id = ? AND sequence <= (
                SELECT change_cursor FROM memory_index_generations WHERE id = ?
              )`,
          )
          .run(root.rootId, generationId);
        this.#deleteOldGenerations(root.rootId);
      })
      .immediate();
  }

  #generationIntegrity(
    rootId: string,
    generationId: number,
  ): {
    readonly entryCount: number;
    readonly indexedBytes: number;
    readonly digest: string;
  } {
    const rows = this.#db
      .prepare<
        [string, number],
        { canonical_path: string; fingerprint: string }
      >(
        `SELECT canonical_path, fingerprint FROM memory_index_entries
          WHERE root_id = ? AND generation_id = ?
          ORDER BY CAST(canonical_path AS BLOB), CAST(memory_id AS BLOB)`,
      )
      .iterate(rootId, generationId);
    const digest = Buffer.from(EMPTY_MEMORY_GENERATION_DIGEST, "hex");
    let entryCount = 0;
    let indexedBytes = 0;
    for (const row of rows) {
      entryCount += 1;
      const path = Buffer.from(row.canonical_path, "utf8");
      const fingerprint = Buffer.from(row.fingerprint, "hex");
      xorDigest(
        digest,
        memoryEntryDigest({
          canonicalPath: row.canonical_path,
          fingerprint: row.fingerprint,
        }),
      );
      indexedBytes += path.byteLength + fingerprint.byteLength;
    }
    return {
      entryCount,
      indexedBytes,
      digest: digest.toString("hex"),
    };
  }

  #recordSliceElapsed(
    generationId: number,
    startedAt: number,
    operations: number,
  ): void {
    const elapsed = Math.max(0, performance.now() - startedAt);
    this.#db
      .prepare(
        `UPDATE memory_index_generations
            SET elapsed_active_ms = elapsed_active_ms + ?,
                discovery_operations = discovery_operations + ?
          WHERE id = ? AND state = 'staging'`,
      )
      .run(Math.ceil(elapsed), operations, generationId);
  }

  #readRecentCandidates(
    snapshots: readonly { root: BoundRoot; generation: GenerationRow }[],
  ): MemoryRankCandidate[] {
    const recent: MemoryRankCandidate[] = [];
    for (const { root, generation } of snapshots) {
      const rows = this.#db
        .prepare<[string, number, number], EntryRow>(
          `SELECT * FROM memory_index_entries
            WHERE root_id = ? AND generation_id = ?
            ORDER BY mtime_ms DESC, CAST(canonical_path AS BLOB), CAST(memory_id AS BLOB)
            LIMIT ?`,
        )
        .all(root.rootId, generation.id, MAX_MEMORY_RECENT_UNION);
      recent.push(
        ...rows.map((row) => entryRowToRankCandidate(row, root.role)),
      );
    }
    recent.sort((left, right) => {
      if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return Buffer.compare(
        Buffer.from(left.canonicalPath, "utf8"),
        Buffer.from(right.canonicalPath, "utf8"),
      );
    });
    return recent.slice(0, MAX_MEMORY_RECENT_UNION);
  }

  #pinCurrentGenerations(
    roots: readonly BoundRoot[],
  ): PinnedGenerationSnapshots {
    const pinId = randomUUID();
    const now = this.#now();
    const leaseExpiresAt = now + MEMORY_INDEX_READER_PIN_LEASE_MS;
    return this.#db
      .transaction(() => {
        this.#deleteExpiredReaderPins(now);
        const snapshots = roots
          .map((root) => this.#currentGeneration(root))
          .filter(
            (
              snapshot,
            ): snapshot is { root: BoundRoot; generation: GenerationRow } =>
              snapshot !== null,
          );
        const busyRootIds = new Set(
          snapshots
            .filter(
              ({ generation }) =>
                generation.builder_owner !== null &&
                generation.builder_lease_expires_at_ms !== null &&
                generation.builder_lease_expires_at_ms > now,
            )
            .map(({ root }) => root.rootId),
        );
        if (busyRootIds.size > 0) {
          return {
            pinId,
            snapshots: [],
            freshness: roots.map((root) => {
              const status = this.#rootStatus(root);
              return busyRootIds.has(root.rootId)
                ? {
                    ...status,
                    state: "refresh_pending" as const,
                    reason: "memory index update is in progress",
                  }
                : status;
            }),
            unavailableReason:
              "memory index update is in progress; retry the query",
          };
        }
        const insertPin = this.#db.prepare(
          `INSERT INTO memory_index_reader_pins(
             pin_id, generation_id, lease_expires_at_ms
           ) VALUES (?, ?, ?)`,
        );
        for (const { generation } of snapshots) {
          insertPin.run(pinId, generation.id, leaseExpiresAt);
        }
        return {
          pinId,
          snapshots,
          freshness: roots.map((root) => this.#rootStatus(root)),
        };
      })
      .immediate();
  }

  #startReaderPinHeartbeat(
    pinned: PinnedGenerationSnapshots,
  ): ReaderPinHeartbeat {
    let lost = false;
    const timer = setInterval(() => {
      if (this.#closed) {
        lost = true;
        return;
      }
      try {
        const result = this.#db
          .prepare(
            `UPDATE memory_index_reader_pins
                SET lease_expires_at_ms = ?
              WHERE pin_id = ?`,
          )
          .run(
            this.#now() + MEMORY_INDEX_READER_PIN_LEASE_MS,
            pinned.pinId,
          );
        if (result.changes !== pinned.snapshots.length) lost = true;
      } catch {
        // The generous lease tolerates transient writer contention. A crashed
        // owner stops renewing and is rejected by the terminal pin check.
      }
    }, MEMORY_INDEX_READER_PIN_HEARTBEAT_MS);
    timer.unref();
    const heartbeat: ReaderPinHeartbeat = {
      timer,
      pinned,
      lost: () => lost,
      markLost: () => {
        lost = true;
      },
    };
    this.#readerPinHeartbeats.add(heartbeat);
    return heartbeat;
  }

  #stopReaderPinHeartbeat(heartbeat: ReaderPinHeartbeat): void {
    clearInterval(heartbeat.timer);
    this.#readerPinHeartbeats.delete(heartbeat);
  }

  #readerPinIsLive(pinned: PinnedGenerationSnapshots): boolean {
    if (this.#closed || !this.#db.open) return false;
    const row = this.#db
      .prepare<[string, number], { count: number }>(
        `SELECT COUNT(*) AS count FROM memory_index_reader_pins
          WHERE pin_id = ? AND lease_expires_at_ms > ?`,
      )
      .get(pinned.pinId, this.#now())!;
    return row.count === pinned.snapshots.length;
  }

  #releaseReaderPin(pinned: PinnedGenerationSnapshots): void {
    if (!this.#db.open) return;
    this.#db
      .transaction(() => {
        this.#db
          .prepare("DELETE FROM memory_index_reader_pins WHERE pin_id = ?")
          .run(pinned.pinId);
        for (const rootId of new Set(
          pinned.snapshots.map(({ root }) => root.rootId),
        )) {
          this.#deleteOldGenerations(rootId);
        }
      })
      .immediate();
  }

  #deleteExpiredReaderPins(now: number): void {
    this.#db
      .prepare(
        "DELETE FROM memory_index_reader_pins WHERE lease_expires_at_ms <= ?",
      )
      .run(now);
  }

  #upsertRoot(root: BoundRoot): void {
    let count = this.#db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_index_roots",
      )
      .get()!.count;
    const existing = this.#db
      .prepare<[string], RootRow>(
        "SELECT * FROM memory_index_roots WHERE root_id = ?",
      )
      .get(root.rootId);
    if (existing === undefined && count >= MAX_MEMORY_INDEX_ROOTS) {
      this.cleanupUnusedRoots();
      count = this.#db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM memory_index_roots",
        )
        .get()!.count;
      if (
        count >= MAX_MEMORY_INDEX_ROOTS &&
        !this.#evictLeastRecentlyUsedRoot(root.rootId)
      ) {
        throw new MemoryIndexBoundaryError(
          "global memory index root limit reached",
        );
      }
    }
    this.#db
      .prepare(
        `INSERT INTO memory_index_roots(
           root_id, canonical_path, root_role, current_generation_id,
           last_used_at_ms, watcher_health, audit_cursor
         ) VALUES (?, ?, ?, NULL, ?, 'healthy', NULL)
         ON CONFLICT(root_id) DO UPDATE SET
           canonical_path = excluded.canonical_path,
           root_role = excluded.root_role,
           last_used_at_ms = excluded.last_used_at_ms`,
      )
      .run(root.rootId, root.canonicalRoot, root.role, this.#now());
  }

  #currentGeneration(
    root: BoundRoot,
  ): { root: BoundRoot; generation: GenerationRow } | null {
    const row = this.#db
      .prepare<[string], GenerationRow>(
        `SELECT g.* FROM memory_index_roots r
          JOIN memory_index_generations g ON g.id = r.current_generation_id
          WHERE r.root_id = ? AND g.state = 'complete'`,
      )
      .get(root.rootId);
    if (row === undefined) return null;
    this.#db
      .prepare(
        "UPDATE memory_index_roots SET last_used_at_ms = ? WHERE root_id = ?",
      )
      .run(this.#now(), root.rootId);
    return { root, generation: row };
  }

  #rootStatus(root: BoundRoot): MemoryIndexGenerationStatus {
    const rootRow = this.#db
      .prepare<[string], RootRow>(
        "SELECT * FROM memory_index_roots WHERE root_id = ?",
      )
      .get(root.rootId);
    const staging = this.#stagingGeneration(root.rootId);
    const current =
      rootRow?.current_generation_id === null ||
      rootRow?.current_generation_id === undefined
        ? null
        : this.#generationById(rootRow.current_generation_id);
    if (staging !== null) {
      return {
        rootId: root.rootId,
        canonicalRoot: root.canonicalRoot,
        role: root.role,
        generationId: staging.id,
        generationToken: staging.generation_token,
        state: "refresh_pending",
        ageMs:
          current?.completed_at_ms === null || current === null
            ? null
            : Math.max(0, this.#now() - current.completed_at_ms),
        watcherHealth: rootRow?.watcher_health ?? "degraded",
        auditCursor: rootRow?.audit_cursor ?? null,
      };
    }
    if (current !== null && current.state === "complete") {
      return {
        rootId: root.rootId,
        canonicalRoot: root.canonicalRoot,
        role: root.role,
        generationId: current.id,
        generationToken: current.generation_token,
        state: "complete",
        ageMs:
          current.completed_at_ms === null
            ? null
            : Math.max(0, this.#now() - current.completed_at_ms),
        watcherHealth: rootRow?.watcher_health ?? "degraded",
        auditCursor: rootRow?.audit_cursor ?? null,
      };
    }
    return {
      rootId: root.rootId,
      canonicalRoot: root.canonicalRoot,
      role: root.role,
      generationId: null,
      generationToken: null,
      state: "unavailable",
      ageMs: null,
      watcherHealth: rootRow?.watcher_health ?? "degraded",
      auditCursor: rootRow?.audit_cursor ?? null,
    };
  }

  #nextDirectory(
    rootId: string,
    generationId: number,
  ): WorkDirectoryRow | null {
    return (
      this.#db
        .prepare<[string, number], WorkDirectoryRow>(
          `SELECT relative_path, state, dev, ino, mtime_ns
             FROM memory_index_directory_work
            WHERE root_id = ? AND generation_id = ? AND state <> 'complete'
            ORDER BY CASE state WHEN 'enumerating' THEN 0 ELSE 1 END,
                     CAST(relative_path AS BLOB)
            LIMIT 1`,
        )
        .get(rootId, generationId) ?? null
    );
  }

  #nextDiscoveredFile(
    rootId: string,
    generationId: number,
  ): DiscoveredFileRow | null {
    return (
      this.#db
        .prepare<[string, number], DiscoveredFileRow>(
          `SELECT relative_path FROM memory_index_discovered_files
            WHERE root_id = ? AND generation_id = ? AND state = 'pending'
            ORDER BY CAST(relative_path AS BLOB)
            LIMIT 1`,
        )
        .get(rootId, generationId) ?? null
    );
  }

  #insertDiscoveredFile(
    rootId: string,
    generationId: number,
    relativePath: string,
    resetPending: boolean,
  ): number {
    const inserted = this.#db
      .prepare(
        `INSERT OR IGNORE INTO memory_index_discovered_files(
           root_id, generation_id, relative_path, state, error
         ) VALUES (?, ?, ?, 'pending', NULL)`,
      )
      .run(rootId, generationId, relativePath).changes;
    if (inserted === 1) {
      const counted = this.#db
        .prepare(
          `UPDATE memory_index_generations
              SET discovered_file_count = discovered_file_count + 1
            WHERE id = ? AND root_id = ? AND state = 'staging'
              AND discovered_file_count < ?`,
        )
        .run(generationId, rootId, this.#maxFilesPerRoot).changes;
      if (counted !== 1) {
        throw new MemoryIndexBoundaryError(
          "memory file count per root exceeds limit",
        );
      }
    }
    if (resetPending) {
      this.#db
        .prepare(
          `UPDATE memory_index_discovered_files
              SET state = 'pending', error = NULL
            WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
        )
        .run(rootId, generationId, relativePath);
    }
    return inserted;
  }

  #markDiscoveredComplete(
    rootId: string,
    generationId: number,
    relativePath: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE memory_index_discovered_files SET state = 'complete', error = NULL
          WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
      )
      .run(rootId, generationId, relativePath);
  }

  #removeStagingPath(
    rootId: string,
    generationId: number,
    relativePath: string,
  ): void {
    const existing = this.#db
      .prepare<
        [string, number, string],
        { memory_id: string; canonical_path: string; fingerprint: string }
      >(
        `SELECT memory_id, canonical_path, fingerprint FROM memory_index_entries
          WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
      )
      .get(rootId, generationId, relativePath);
    if (existing === undefined) return;
    this.#db
      .prepare(
        `DELETE FROM memory_fts
          WHERE root_id = ? AND generation_id = ? AND memory_id = ?`,
      )
      .run(rootId, generationId, existing.memory_id);
    this.#db
      .prepare(
        `DELETE FROM memory_index_entries
          WHERE root_id = ? AND generation_id = ? AND memory_id = ?`,
      )
      .run(rootId, generationId, existing.memory_id);
    this.#advanceGenerationProgress({
      generationId,
      previous: {
        canonicalPath: existing.canonical_path,
        fingerprint: existing.fingerprint,
      },
      entryDelta: -1,
      byteDelta: -indexedEntryBytes(
        existing.canonical_path,
        existing.fingerprint,
      ),
    });
  }

  #advanceGenerationProgress(input: {
    readonly generationId: number;
    readonly previous?: {
      readonly canonicalPath: string;
      readonly fingerprint: string;
    };
    readonly next?: {
      readonly canonicalPath: string;
      readonly fingerprint: string;
    };
    readonly entryDelta: number;
    readonly byteDelta: number;
  }): void {
    const generation = this.#generationById(input.generationId);
    if (generation === null) {
      throw new Error(
        "memory generation disappeared during progress checkpoint",
      );
    }
    const digest = Buffer.from(
      generation.digest ?? EMPTY_MEMORY_GENERATION_DIGEST,
      "hex",
    );
    if (input.previous !== undefined) {
      xorDigest(digest, memoryEntryDigest(input.previous));
    }
    if (input.next !== undefined) {
      xorDigest(digest, memoryEntryDigest(input.next));
    }
    this.#db
      .prepare(
        `UPDATE memory_index_generations
            SET entry_count = entry_count + ?,
                indexed_bytes = indexed_bytes + ?,
                digest = ?
          WHERE id = ?`,
      )
      .run(
        input.entryDelta,
        input.byteDelta,
        digest.toString("hex"),
        input.generationId,
      );
  }

  #requeueDirectory(
    root: BoundRoot,
    generationId: number,
    relativePath: string,
    identity: DirectoryIdentity,
  ): void {
    this.#db
      .prepare(
        `UPDATE memory_index_directory_work
            SET state = 'pending', dev = ?, ino = ?, mtime_ns = ?
          WHERE root_id = ? AND generation_id = ? AND relative_path = ?`,
      )
      .run(
        identity.dev.toString(),
        identity.ino.toString(),
        identity.mtimeNs.toString(),
        root.rootId,
        generationId,
        relativePath,
      );
  }

  #stagingGeneration(rootId: string): GenerationRow | null {
    return (
      this.#db
        .prepare<[string], GenerationRow>(
          `SELECT * FROM memory_index_generations
            WHERE root_id = ? AND state = 'staging'
            ORDER BY id DESC LIMIT 1`,
        )
        .get(rootId) ?? null
    );
  }

  #generationById(id: number): GenerationRow | null {
    return (
      this.#db
        .prepare<[number], GenerationRow>(
          "SELECT * FROM memory_index_generations WHERE id = ?",
        )
        .get(id) ?? null
    );
  }

  #latestChangeCursor(rootId: string): number {
    return this.#db
      .prepare<[string], { cursor: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS cursor FROM memory_index_change_log WHERE root_id = ?",
      )
      .get(rootId)!.cursor;
  }

  #claimBuildLease(generationId: number): boolean {
    const now = this.#now();
    return this.#db
      .transaction(() => {
        this.#deleteExpiredReaderPins(now);
        const result = this.#db
          .prepare(
            `UPDATE memory_index_generations
                SET builder_owner = ?, builder_lease_expires_at_ms = ?
              WHERE id = ? AND state IN ('staging', 'complete')
                AND (
                  builder_owner IS NULL OR builder_owner = ? OR
                  builder_lease_expires_at_ms IS NULL OR
                  builder_lease_expires_at_ms <= ?
                )
                AND (
                  state = 'staging' OR NOT EXISTS (
                    SELECT 1 FROM memory_index_reader_pins p
                     WHERE p.generation_id = memory_index_generations.id
                       AND p.lease_expires_at_ms > ?
                  )
                )`,
          )
          .run(
            this.#builderOwner,
            now + MEMORY_INDEX_BUILD_LEASE_MS,
            generationId,
            this.#builderOwner,
            now,
            now,
          );
        return result.changes === 1;
      })
      .immediate();
  }

  #releaseBuildLease(generationId: number): void {
    this.#db
      .prepare(
        `UPDATE memory_index_generations
            SET builder_owner = NULL, builder_lease_expires_at_ms = NULL
          WHERE id = ? AND builder_owner = ?`,
      )
      .run(generationId, this.#builderOwner);
  }

  #failGeneration(generationId: number, error: unknown): void {
    this.#db
      .transaction(() => {
        this.#db
          .prepare(
            `UPDATE memory_index_generations
                SET state = 'failed', error = ?, discovered_file_count = 0
              WHERE id = ? AND state = 'staging'`,
          )
          .run(
            error instanceof Error ? error.message : String(error),
            generationId,
          );
        this.#db
          .prepare("DELETE FROM memory_fts WHERE generation_id = ?")
          .run(generationId);
        this.#db
          .prepare("DELETE FROM memory_index_entries WHERE generation_id = ?")
          .run(generationId);
        this.#db
          .prepare(
            "DELETE FROM memory_index_directory_work WHERE generation_id = ?",
          )
          .run(generationId);
        this.#db
          .prepare(
            "DELETE FROM memory_index_discovered_files WHERE generation_id = ?",
          )
          .run(generationId);
      })
      .immediate();
  }

  async #closeGenerationDirectories(
    rootId: string,
    generationId: number,
  ): Promise<void> {
    const prefix = `${rootId}:${generationId}:`;
    const closes: Promise<void>[] = [];
    for (const [key, state] of this.#openDirectories) {
      if (!key.startsWith(prefix)) continue;
      this.#openDirectories.delete(key);
      closes.push(
        state.directory
          .close()
          .catch(() => undefined)
          .then(() => {
            activeMemoryBuildOpenDirectories -= 1;
          }),
      );
    }
    await Promise.all(closes);
  }

  #evictLeastRecentlyUsedRoot(excludedRootId: string): boolean {
    const now = this.#now();
    const rows = this.#db
      .prepare<
        [string, number, number, string, number, number],
        RootRow
      >(
        `SELECT * FROM memory_index_roots
          WHERE root_id <> ?
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_generations g
               WHERE g.root_id = memory_index_roots.root_id
                 AND g.state = 'staging'
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_reader_pins p
              JOIN memory_index_generations g ON g.id = p.generation_id
               WHERE g.root_id = memory_index_roots.root_id
                 AND p.lease_expires_at_ms > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_owners o
               WHERE o.root_id = memory_index_roots.root_id
                 AND o.lease_expires_at_ms > ?
                 AND o.owner_id <> ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_generations g
               WHERE g.root_id = memory_index_roots.root_id
                 AND g.builder_owner IS NOT NULL
                 AND g.builder_lease_expires_at_ms > ?
            )
          ORDER BY last_used_at_ms, root_id
          LIMIT ?`,
      )
      .all(
        excludedRootId,
        now,
        now,
        this.#builderOwner,
        now,
        MAX_MEMORY_INDEX_CLEANUP_ROOTS_PER_BATCH,
      );
    for (const row of rows) {
      if (this.#rootHasActiveLocalWork(row.root_id)) continue;
      if (this.#deleteIndexedRoot(row.root_id, now)) return true;
    }
    return false;
  }

  #deleteIndexedRoot(rootId: string, now: number): boolean {
    let deleted = false;
    this.#db
      .transaction(() => {
        const foreignOwner = this.#db
          .prepare<[string, number, string], { present: number }>(
            `SELECT 1 AS present FROM memory_index_owners
              WHERE root_id = ? AND lease_expires_at_ms > ?
                AND owner_id <> ?
              LIMIT 1`,
          )
          .get(rootId, now, this.#builderOwner);
        const activeGeneration = this.#db
          .prepare<[string, number], { present: number }>(
            `SELECT 1 AS present FROM memory_index_generations
              WHERE root_id = ?
                AND (
                  state = 'staging' OR (
                    builder_owner IS NOT NULL AND
                    builder_lease_expires_at_ms > ?
                  )
                )
              LIMIT 1`,
          )
          .get(rootId, now);
        const activeReader = this.#db
          .prepare<[string, number], { present: number }>(
            `SELECT 1 AS present FROM memory_index_reader_pins p
              JOIN memory_index_generations g ON g.id = p.generation_id
             WHERE g.root_id = ? AND p.lease_expires_at_ms > ?
             LIMIT 1`,
          )
          .get(rootId, now);
        if (
          foreignOwner !== undefined ||
          activeGeneration !== undefined ||
          activeReader !== undefined
        ) {
          return;
        }
        this.#db
          .prepare("DELETE FROM memory_fts WHERE root_id = ?")
          .run(rootId);
        deleted =
          this.#db
            .prepare("DELETE FROM memory_index_roots WHERE root_id = ?")
            .run(rootId).changes === 1;
      })
      .immediate();
    if (deleted) this.#retireLocalWatcher(rootId);
    return deleted;
  }

  #retireLocalWatcher(rootId: string): void {
    const watcher = this.#watchers.get(rootId);
    if (watcher !== undefined) {
      watcher.close();
      this.#watchers.delete(rootId);
      activeMemoryIndexWatchers -= 1;
    }
    for (const [key, timer] of this.#watchDebounceTimers) {
      if (!key.startsWith(`${rootId}:`)) continue;
      clearTimeout(timer);
      this.#watchDebounceTimers.delete(key);
    }
    const auditTimer = this.#auditTimers.get(rootId);
    if (auditTimer !== undefined) {
      clearTimeout(auditTimer);
      this.#auditTimers.delete(rootId);
    }
    this.#releaseWatcherOwner(rootId);
    if (this.#watchers.size === 0 && this.#ownerHeartbeatTimer !== null) {
      clearTimeout(this.#ownerHeartbeatTimer);
      this.#ownerHeartbeatTimer = null;
    }
  }

  #rootHasActiveLocalWork(rootId: string): boolean {
    const buildKey = `${this.databasePath}:${rootId}`;
    return (
      activeBuilds.has(buildKey) ||
      this.#sliceLocks.has(buildKey) ||
      this.#backgroundRefreshes.has(rootId) ||
      (this.#activeQueryRoots.get(rootId) ?? 0) > 0
    );
  }

  #acquireQueryRoot(rootId: string): void {
    this.#activeQueryRoots.set(
      rootId,
      (this.#activeQueryRoots.get(rootId) ?? 0) + 1,
    );
  }

  #releaseQueryRoot(rootId: string): void {
    const count = this.#activeQueryRoots.get(rootId) ?? 0;
    if (count <= 1) {
      this.#activeQueryRoots.delete(rootId);
      return;
    }
    this.#activeQueryRoots.set(rootId, count - 1);
  }

  #deleteOldGenerations(rootId: string): void {
    const now = this.#now();
    const old = this.#db
      .prepare<[string, number, number], { id: number }>(
        `SELECT g.id FROM memory_index_generations g
          WHERE g.root_id = ?
            AND g.state IN ('complete', 'superseded', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM memory_index_reader_pins p
               WHERE p.generation_id = g.id AND p.lease_expires_at_ms > ?
            )
          ORDER BY CASE g.state WHEN 'complete' THEN 0 ELSE 1 END, g.id DESC
          LIMIT -1 OFFSET ?`,
      )
      .all(rootId, now, MAX_COMPLETE_GENERATIONS_PER_ROOT);
    for (const { id } of old) {
      this.#db
        .prepare("DELETE FROM memory_fts WHERE generation_id = ?")
        .run(id);
      this.#db
        .prepare("DELETE FROM memory_index_generations WHERE id = ?")
        .run(id);
    }
  }

  #recoverInterruptedEnumeration(): void {
    const now = this.#now();
    this.#db
      .transaction(() => {
        this.#db
          .prepare(
            `UPDATE memory_index_directory_work SET state = 'pending'
              WHERE state = 'enumerating'`,
          )
          .run();
        this.#db
          .prepare(
            "DELETE FROM memory_index_owners WHERE lease_expires_at_ms <= ?",
          )
          .run(now);
        this.#deleteExpiredReaderPins(now);
        const roots = this.#db
          .prepare<[], { root_id: string }>(
            "SELECT root_id FROM memory_index_roots ORDER BY root_id",
          )
          .all();
        for (const { root_id: rootId } of roots) {
          this.#deleteOldGenerations(rootId);
        }
      })
      .immediate();
  }
}

export function resolveMemoryIndexDatabasePath(agencHome: string): string {
  if (agencHome.trim().length === 0 || !isAbsolute(agencHome)) {
    throw new MemoryIndexBoundaryError(
      "memory index state requires an absolute AgenC home",
    );
  }
  return join(agencHome, MEMORY_INDEX_DIRECTORY, MEMORY_INDEX_FILENAME);
}

function validateRootSpecsBeforeIo(
  rootSpecs: readonly MemoryIndexRootSpec[],
): void {
  if (rootSpecs.length > MAX_MEMORY_INDEX_ROOTS) {
    throw new MemoryIndexBoundaryError("memory root count exceeds limit");
  }
  for (const root of rootSpecs) {
    if (root.role !== "global" && root.role !== "project") {
      throw new MemoryIndexBoundaryError("memory root role is invalid");
    }
    validateMemoryRootPathBeforeIo(root.path);
  }
}

function validateMemoryRootPathBeforeIo(path: string): void {
  if (!isAbsolute(path)) {
    throw new MemoryIndexBoundaryError("memory root must be absolute");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES) {
    throw new MemoryIndexBoundaryError("memory root path exceeds limit");
  }
}

async function bindRoots(
  rootSpecs: readonly MemoryIndexRootSpec[],
  signal: AbortSignal,
): Promise<BoundRoot[]> {
  const roots: BoundRoot[] = [];
  const seen = new Set<string>();
  for (const spec of rootSpecs) {
    throwIfAborted(signal);
    try {
      const requested = resolve(spec.path);
      const metadata = await lstat(requested, { bigint: true });
      throwIfAborted(signal);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      const canonicalRoot = (await realpath(requested)).normalize("NFC");
      throwIfAborted(signal);
      if (
        Buffer.byteLength(canonicalRoot, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES
      ) {
        throw new MemoryIndexBoundaryError(
          "canonical memory root path exceeds limit",
        );
      }
      const rootId = memoryIndexRootId(canonicalRoot);
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      roots.push({
        rootId,
        canonicalRoot,
        role: spec.role,
        identity: identityFromStats(metadata),
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof MemoryIndexBoundaryError) throw error;
    }
  }
  return roots;
}

async function readIndexedHeader(
  root: BoundRoot,
  relativePath: string,
  absolutePath: string,
  signal: AbortSignal,
): Promise<IndexedMemoryHeader | null> {
  throwIfAborted(signal);
  const relativeToRoot = relative(root.canonicalRoot, absolutePath);
  if (
    relativeToRoot.startsWith("..") ||
    isAbsolute(relativeToRoot) ||
    relativeToRoot !== relativePath
  ) {
    throw new MemoryIndexBoundaryError(
      "memory candidate escaped its canonical root",
    );
  }
  const before = await lstat(absolutePath, { bigint: true });
  throwIfAborted(signal);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    return null;
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MemoryIndexBoundaryError(
      "memory file size is not safely representable",
    );
  }
  const handle = await open(absolutePath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(identityFromStats(before), identityFromStats(opened))
    ) {
      throw new Error("memory file changed before bounded header read");
    }
    const bytes = await readBoundedHeader(handle, signal);
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(identityFromStats(opened), identityFromStats(after))
    ) {
      throw new Error("memory file changed during bounded header read");
    }
    const text = bytes.toString("utf8");
    const { frontmatter } = parseFrontmatter(
      firstLines(text, FRONTMATTER_MAX_LINES),
      absolutePath,
    );
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : typeof frontmatter.name === "string"
          ? frontmatter.name
          : basename(relativePath, ".md");
    const description =
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : "";
    const type = parseMemoryType(frontmatter.type) ?? null;
    const canonicalPath = join(root.canonicalRoot, relativePath).normalize(
      "NFC",
    );
    return {
      memoryId: stableMemoryId(canonicalPath),
      canonicalPath,
      title,
      description,
      type,
      mtimeMs: Number(opened.mtimeNs / 1_000_000n),
      fileSize: Number(opened.size),
      fingerprint: computeMemoryHeaderFingerprint(bytes, {
        title,
        description,
        type,
      }),
      fileIdentity: identityFromStats(opened),
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedHeader(
  handle: FileHandle,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_MEMORY_HEADER_UTF8_BYTES);
  let offset = 0;
  while (offset < buffer.byteLength) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  throwIfAborted(signal);
  return buffer.subarray(0, offset);
}

async function readDirectoryIdentity(
  path: string,
  signal: AbortSignal,
): Promise<DirectoryIdentity> {
  const metadata = await lstat(path, { bigint: true });
  throwIfAborted(signal);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("memory directory identity is not stable");
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeNs: metadata.mtimeNs,
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs
  );
}

function identityFromStats(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function entryRowToRankCandidate(
  row: EntryRow,
  rootRole: MemoryIndexRootRole,
): MemoryRankCandidate {
  return {
    memoryId: row.memory_id,
    generationId: row.generation_id,
    canonicalPath: row.canonical_path,
    title: row.title,
    description: row.description,
    type: row.memory_type,
    mtimeMs: row.mtime_ms,
    size: row.file_size,
    fingerprint: row.fingerprint,
    rootId: row.root_id,
    rootRole,
    headerSnapshot: {
      relativePath: row.relative_path,
      fileDev: row.file_dev,
      fileIno: row.file_ino,
      fileMode: row.file_mode,
      fileMtimeNs: row.file_mtime_ns,
      fileCtimeNs: row.file_ctime_ns,
      rootDev: row.root_dev,
      rootIno: row.root_ino,
      rootMode: row.root_mode,
      rootSize: row.root_size,
      rootMtimeNs: row.root_mtime_ns,
      rootCtimeNs: row.root_ctime_ns,
    },
  };
}

function rankCandidateToMemoryHeader(
  candidate: MemoryRankCandidate,
): MemoryHeader {
  const snapshot = candidate.headerSnapshot;
  const storedRootIdentity: FileIdentity = {
    dev: BigInt(snapshot.rootDev),
    ino: BigInt(snapshot.rootIno),
    mode: BigInt(snapshot.rootMode),
    size: BigInt(snapshot.rootSize),
    mtimeNs: BigInt(snapshot.rootMtimeNs),
    ctimeNs: BigInt(snapshot.rootCtimeNs),
  };
  const rootPath = dirnameFromRelative(
    candidate.canonicalPath,
    snapshot.relativePath,
  );
  let rootIdentity = storedRootIdentity;
  try {
    const current = lstatSync(rootPath, { bigint: true });
    if (current.isDirectory() && !current.isSymbolicLink()) {
      rootIdentity = identityFromStats(current);
    }
  } catch {
    // The subsequent descriptor-bound read rejects the stored stale identity.
  }
  const root: MemoryRootBinding = {
    requestedPath: rootPath,
    canonicalPath: rootPath,
    identity: rootIdentity,
  };
  return {
    filename: snapshot.relativePath,
    relativePath: snapshot.relativePath,
    filePath: candidate.canonicalPath,
    pathBytes: Buffer.from(candidate.canonicalPath, "utf8"),
    mtimeMs: candidate.mtimeMs,
    title: candidate.title,
    description: candidate.description || null,
    type: parseMemoryType(candidate.type),
    root,
    identity: {
      dev: BigInt(snapshot.fileDev),
      ino: BigInt(snapshot.fileIno),
      mode: BigInt(snapshot.fileMode),
      size: BigInt(candidate.size),
      mtimeNs: BigInt(snapshot.fileMtimeNs),
      ctimeNs: BigInt(snapshot.fileCtimeNs),
    },
  };
}

function dirnameFromRelative(
  canonicalPath: string,
  relativePath: string,
): string {
  let root = canonicalPath;
  for (const segment of platformRelativePathSegments(relativePath)) {
    if (segment.length > 0) root = dirname(root);
  }
  return root;
}

function firstLines(value: string, maximumLines: number): string {
  return value.split("\n").slice(0, maximumLines).join("\n");
}

function encodeAuditCursor(
  phase: MemoryAuditPhase,
  relativePath: string,
): string {
  return JSON.stringify([phase, relativePath]);
}

function decodeAuditCursor(cursor: string | null): MemoryAuditCursor {
  if (cursor === null) return { phase: "entries", relativePath: "" };
  try {
    const decoded = JSON.parse(cursor) as unknown;
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      (decoded[0] === "entries" || decoded[0] === "directories") &&
      typeof decoded[1] === "string"
    ) {
      return { phase: decoded[0], relativePath: decoded[1] };
    }
  } catch {
    // A malformed derived cursor safely restarts the bounded audit.
  }
  return { phase: "entries", relativePath: "" };
}

function validatePortableRelativePath(path: string): void {
  const segments = platformRelativePathSegments(path);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new MemoryIndexBoundaryError("memory relative path is invalid");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES) {
    throw new MemoryIndexBoundaryError("memory path exceeds limit");
  }
}

function platformRelativePathSegments(path: string): string[] {
  return sep === "\\" ? path.split(/[/\\]/u) : path.split("/");
}

function sliceExhausted(budget: BuildSliceBudget): boolean {
  return (
    budget.newEntries >= MAX_MEMORY_INDEX_BUILD_ENTRIES_PER_SLICE ||
    performance.now() - budget.startedAt >= MAX_MEMORY_INDEX_BUILD_SLICE_MS
  );
}

function openDirectoryKey(
  rootId: string,
  generationId: number,
  relativePath: string,
): string {
  return `${rootId}:${generationId}:${relativePath}`;
}

function databaseBytes(database: BetterSqlite3.Database): number {
  const pageCount = database.pragma("page_count", { simple: true });
  const pageSize = database.pragma("page_size", { simple: true });
  if (typeof pageCount !== "number" || typeof pageSize !== "number") {
    throw new Error("memory index database byte accounting is unavailable");
  }
  return pageCount * pageSize;
}

function indexedEntryBytes(canonicalPath: string, fingerprint: string): number {
  return Buffer.byteLength(canonicalPath, "utf8") + fingerprint.length / 2;
}

function memoryEntryDigest(input: {
  readonly canonicalPath: string;
  readonly fingerprint: string;
}): Buffer {
  if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) {
    throw new MemoryIndexCorruptionError(
      "memory index entry has an invalid content fingerprint",
    );
  }
  const hash = createHash("sha256");
  hash.update("agenc-memory-index-entry-v1\0");
  for (const field of [
    Buffer.from(input.canonicalPath, "utf8"),
    Buffer.from(input.fingerprint, "hex"),
  ]) {
    const length = Buffer.alloc(DIGEST_LENGTH_PREFIX_BYTES);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    hash.update(length);
    hash.update(field);
  }
  return hash.digest();
}

function xorDigest(target: Buffer, contribution: Buffer): void {
  if (
    target.byteLength !== SHA256_DIGEST_BYTES ||
    contribution.byteLength !== SHA256_DIGEST_BYTES
  ) {
    throw new MemoryIndexCorruptionError(
      "memory index generation digest has an invalid length",
    );
  }
  for (let index = 0; index < SHA256_DIGEST_BYTES; index += 1) {
    target[index] = target[index]! ^ contribution[index]!;
  }
}

function realpathSyncExisting(path: string): string {
  if (!statSync(path).isDirectory()) {
    throw new MemoryIndexBoundaryError("memory change root is not a directory");
  }
  const canonical = realpathSync(path);
  if (Buffer.byteLength(canonical, "utf8") > MAX_MEMORY_PATH_UTF8_BYTES) {
    throw new MemoryIndexBoundaryError(
      "canonical memory root path exceeds limit",
    );
  }
  return canonical.normalize("NFC");
}

function unavailableRootStatus(
  spec: MemoryIndexRootSpec,
): MemoryIndexGenerationStatus {
  return {
    rootId: "",
    canonicalRoot: spec.path,
    role: spec.role,
    generationId: null,
    generationToken: null,
    state: "unavailable",
    ageMs: null,
    watcherHealth: "degraded",
    auditCursor: null,
    reason: "memory root or FTS5 capability is unavailable",
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Memory indexing aborted", "AbortError")
  );
}

function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function waitForIncrementalRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, MEMORY_WATCH_DEBOUNCE_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
