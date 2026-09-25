/** Thread-store persistence boundary for live and on-disk AgenC threads. */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { persistDisplayArtifactBytes, readDisplayArtifact, removeDisplayArtifacts } from "../session/display-artifact-store.js";
import { THREAD_REGISTRY_FILENAME, ThreadRegistryLock } from "./registry-lock.js";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ThreadId } from "../agents/registry.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type ResponseItem,
  type RolloutItem,
} from "../session/rollout-item.js";
import type { RolloutStore } from "../session/rollout-store.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type SessionMetaLine,
} from "../session/event-log.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
  listResumableSessions,
  readAndValidateSchemaVersion,
  SessionLock,
  SessionLockedError,
} from "../session/session-store.js";
import {
  LOGS_DATABASE_FILENAME,
  openStateDatabases,
  openStateDatabasePaths,
  STATE_DATABASE_FILENAME,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import { StateThreadRepository } from "../state/threads.js";
import { backfillRolloutFile } from "../state/backfill.js";
import { isRecord } from "../utils/record.js";
import { timed } from "../utils/slow-store-op.js";

// ─────────────────────────────────────────────────────────────────────
// Params + types.
// ─────────────────────────────────────────────────────────────────────

/**
 * Thread memory mode. Serialized to the registry as the lowercase
 * string form.
 */
export type ThreadMemoryMode = "enabled" | "disabled";

/**
 * Controls how many event variants should be persisted for future
 * replay. Currently unused by `FileThreadStore` (kept for signature
 * stability) because the runtime has a single event-persistence policy.
 */
export type ThreadEventPersistenceMode = "limited" | "extended";

/**
 * Runtime source for the thread. Accepts both compatibility string
 * labels and JSON-shaped structured sources used by subagents.
 */
export type ThreadSource = string | Readonly<Record<string, unknown>>;

/** Parameters for creating a new thread. */
export interface CreateThreadParams {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  readonly source?: ThreadSource;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly eventPersistenceMode?: ThreadEventPersistenceMode;
  readonly cwd?: string;
  readonly agencHome?: string;
  /**
   * The already-opened `RolloutStore` this thread will append into.
   * The `RolloutStore` lifecycle lives with `Session`, so the caller
   * must pass an opened store in.
   */
  readonly rolloutStore: RolloutStore;
}

/** Parameters for resuming an existing thread. */
export interface ResumeThreadParams {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly history?: ReadonlyArray<RolloutItem>;
  readonly includeArchived?: boolean;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly eventPersistenceMode?: ThreadEventPersistenceMode;
  readonly rolloutStore: RolloutStore;
}

/** Parameters for appending rollout items to a thread. */
export interface AppendThreadItemsParams {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<RolloutItem>;
}

/** Parameters for loading a thread's rollout history. */
export interface LoadThreadHistoryParams {
  readonly threadId: ThreadId;
  readonly includeArchived: boolean;
}

/** Rollout history loaded for a thread. */
export interface StoredThreadHistory {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<RolloutItem>;
}

/** Parameters for reading a thread by id. */
export interface ReadThreadParams {
  readonly threadId: ThreadId;
  readonly includeArchived: boolean;
  readonly includeHistory: boolean;
}

/** Parameters for reading a thread by its rollout path. */
export interface ReadThreadByRolloutPathParams {
  readonly rolloutPath: string;
  readonly includeArchived: boolean;
  readonly includeHistory: boolean;
}

/** Sort key for thread listings. */
export type ThreadSortKey = "created_at" | "updated_at";

/** Sort direction for thread listings. */
export type SortDirection = "asc" | "desc";

/** Parameters for listing threads. */
export interface ListThreadsParams {
  readonly pageSize: number;
  readonly cursor?: string;
  readonly sortKey?: ThreadSortKey;
  readonly sortDirection?: SortDirection;
  readonly allowedSources?: ReadonlyArray<ThreadSource>;
  readonly modelProviders?: ReadonlyArray<string>;
  readonly cwdFilters?: ReadonlyArray<string>;
  readonly archived: boolean;
  readonly searchTerm?: string;
  readonly useStateDbOnly?: boolean;
}

/** Persisted thread record, narrowed to the fields actually stored in
 *  the registry. Token usage, reasoning effort, approval mode, sandbox
 *  policy, git info, full preview, and cli version are not populated. */
export interface StoredThread {
  readonly threadId: ThreadId;
  readonly parentThreadId?: ThreadId;
  readonly rolloutPath?: string;
  readonly forkedFromId?: ThreadId;
  readonly name?: string;
  readonly modelProvider: string;
  readonly model?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
  readonly archivedAt?: string; // ISO-8601 when archived
  readonly cwd?: string;
  readonly source?: ThreadSource;
  readonly history?: StoredThreadHistory;
}

/** One page of a thread listing. */
export interface ThreadPage {
  readonly items: ReadonlyArray<StoredThread>;
  readonly nextCursor?: string;
}

/** Optional string patch: `undefined` leaves the field alone, `null` clears it. */
export type OptionalStringPatch = string | null | undefined;

/** Git info patch. Accepted for signature stability;
 *  `FileThreadStore.updateThreadMetadata` does NOT persist git info
 *  (the local store rejects git-info patches). */
export interface GitInfoPatch {
  readonly sha?: OptionalStringPatch;
  readonly branch?: OptionalStringPatch;
  readonly originUrl?: OptionalStringPatch;
}

/** Metadata fields that can be patched on a thread. */
export interface ThreadMetadataPatch {
  readonly name?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly gitInfo?: GitInfoPatch;
}

/** Parameters for updating thread metadata. */
export interface UpdateThreadMetadataParams {
  readonly threadId: ThreadId;
  readonly patch: ThreadMetadataPatch;
  readonly includeArchived: boolean;
}

/** Parameters for archiving a thread. */
export interface ArchiveThreadParams {
  readonly threadId: ThreadId;
}

// ─────────────────────────────────────────────────────────────────────
// Error types.
// ─────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a requested thread does not exist in the store.
 */
export class ThreadNotFoundError extends Error {
  readonly threadId: ThreadId;

  constructor(threadId: ThreadId) {
    super(`thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
    this.threadId = threadId;
  }
}

/**
 * Error thrown when request data is invalid.
 */
export class ThreadStoreInvalidRequestError extends Error {
  constructor(message: string) {
    super(`invalid thread-store request: ${message}`);
    this.name = "ThreadStoreInvalidRequestError";
  }
}

/**
 * Error thrown on state conflicts.
 */
class ThreadStoreConflictError extends Error {
  constructor(message: string) {
    super(`thread-store conflict: ${message}`);
    this.name = "ThreadStoreConflictError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// ThreadStore interface.
// ─────────────────────────────────────────────────────────────────────

/**
 * Storage-neutral thread persistence boundary.
 */
export interface ThreadStore {
  createThread(params: CreateThreadParams): void;
  resumeThread(params: ResumeThreadParams): void;
  appendItems(params: AppendThreadItemsParams): void;
  persistThread(threadId: ThreadId): void;
  flushThread(threadId: ThreadId): void;
  shutdownThread(threadId: ThreadId): void;
  discardThread(threadId: ThreadId): void;
  loadHistory(params: LoadThreadHistoryParams): StoredThreadHistory;
  readThread(params: ReadThreadParams): StoredThread;
  /** Publish snapshot text against the thread's current canonical rollout. */
  publishTranscriptArtifact?(threadId: ThreadId, observedRolloutPath: string, bytes: Buffer): string;
  readThreadByRolloutPath(params: ReadThreadByRolloutPathParams): StoredThread;
  listThreads(params: ListThreadsParams): ThreadPage;
  /** Indexed count for latency-sensitive health probes. */
  countThreads?(params: {
    readonly archived: boolean;
    readonly excludeThreadIds?: ReadonlySet<string>;
  }): number;
  updateThreadMetadata(params: UpdateThreadMetadataParams): StoredThread;
  archiveThread(params: ArchiveThreadParams): void;
  unarchiveThread(params: ArchiveThreadParams): StoredThread;
}

// ─────────────────────────────────────────────────────────────────────
// FileThreadStore — default filesystem-backed implementation.
// ─────────────────────────────────────────────────────────────────────

interface RegistryEntry {
  readonly parentThreadId?: ThreadId;
  readonly threadId: ThreadId;
  readonly name?: string;
  readonly modelProvider?: string;
  readonly model?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly cwd?: string;
  readonly source?: ThreadSource;
  readonly forkedFromId?: ThreadId;
  readonly rolloutPath?: string;
  readonly archivedRolloutPath?: string;
  readonly archiveCleanupGeneration?: string;
}

interface RegistrySnapshot {
  readonly version: number;
  readonly threads: ReadonlyArray<RegistryEntry>;
}

const REGISTRY_VERSION = 1;

export interface FileThreadStoreOpts {
  /**
   * The cwd used to resolve the per-project state path
   * (`getProjectDir(cwd, projectRootMarkers)`). Defaults
   * to `process.cwd()` if omitted.
   */
  readonly cwd?: string;
  /**
   * Direct per-project state path. Used when recovery already knows the
   * project directory but no original cwd is available.
   */
  readonly projectDir?: string;
  readonly agencHome?: string;
  /**
   * Fallback provider id used when old rollout metadata does not include
   * a provider. Mirrors the local store's default-provider fallback.
   */
  readonly defaultModelProviderId?: string;
  /**
   * Optional project-root markers, matching `RolloutStore`/`SessionStore`.
   */
  readonly projectRootMarkers?: readonly string[];
}

/**
 * Default filesystem-backed `ThreadStore`. Tracks live thread writers
 * (via the caller-supplied `RolloutStore` per thread) in memory, and
 * persists thread metadata in the per-project AgenC state database.
 *
 * Wire-format notes:
 *   - Live archives defer the `archived_sessions/` move until the writer is
 *     no longer registered, preserving the open `RolloutStore` path.
 *   - No on-disk `ThreadNameUpdated` rows: name updates only rewrite the
 *     state row. Memory-mode updates append a new `session_meta` row.
 */
export class FileThreadStore implements ThreadStore {
  private readonly registryPath: string;
  private readonly projectDir: string;
  private readonly archivedSessionsDir: string;
  private readonly defaultModelProviderId: string;
  private readonly stateDriver: StateSqliteDriver;
  private readonly threadIndex: StateThreadRepository;
  private readonly liveRecorders = new Map<ThreadId, RolloutStore>();
  private closed = false;
  /** One legacy sessions-dir import per store instance (see readRegistryUnlocked). */
  private legacyImportDone = false;

  constructor(opts: FileThreadStoreOpts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const markers = opts.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS;
    const projectDir =
      opts.projectDir ?? getProjectDir(cwd, markers, opts.agencHome);
    this.projectDir = projectDir;
    this.registryPath = join(projectDir, THREAD_REGISTRY_FILENAME);
    this.archivedSessionsDir = join(projectDir, "archived_sessions");
    this.defaultModelProviderId = opts.defaultModelProviderId ?? "unknown";
    this.stateDriver =
      opts.projectDir === undefined
        ? openStateDatabases({
            cwd,
            ...(opts.agencHome !== undefined
              ? { agencHome: opts.agencHome }
              : {}),
            projectRootMarkers: markers,
          })
        : openStateDatabasePaths({
            projectDir,
            stateDbPath: join(projectDir, STATE_DATABASE_FILENAME),
            logsDbPath: join(projectDir, LOGS_DATABASE_FILENAME),
          });
    this.threadIndex = new StateThreadRepository(this.stateDriver);
    this.readLegacyThreadsJson();
    this.finishPendingUnarchiveCleanup();
  }

  /** Compatibility sidecar path imported by this store. Exposed for tests. */
  get registryFilePath(): string {
    return this.registryPath;
  }

  // ── ThreadStore trait implementation ────────────────────────────────

  createThread(params: CreateThreadParams): void {
    this.assertOpen();
    const threadId = params.threadId;
    if (this.liveRecorders.has(threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${threadId} already has a live local writer`,
      );
    }
    const source =
      params.source === undefined
        ? undefined
        : canonicalizeThreadSource(params.source);
    this.prepareLiveRecorder(params.rolloutStore);

    this.updateRegistry((registry) => {
      const now = new Date().toISOString();
      const existing = registry.get(threadId);
      const entry: RegistryEntry = {
        threadId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.name !== undefined ? { name: existing.name } : {}),
        ...(params.modelProvider !== undefined
          ? { modelProvider: params.modelProvider }
          : existing?.modelProvider !== undefined
            ? { modelProvider: existing.modelProvider }
            : {}),
        ...(params.model !== undefined
          ? { model: params.model }
          : existing?.model !== undefined
            ? { model: existing.model }
            : {}),
        ...(existing?.memoryMode !== undefined
          ? { memoryMode: existing.memoryMode }
          : {}),
        ...(params.cwd !== undefined
          ? { cwd: params.cwd }
          : existing?.cwd !== undefined
            ? { cwd: existing.cwd }
            : {}),
        ...(params.source !== undefined
          ? { source: source! }
          : existing?.source !== undefined
            ? { source: existing.source }
            : {}),
        ...(params.forkedFromId !== undefined
          ? { forkedFromId: params.forkedFromId }
          : existing?.forkedFromId !== undefined
            ? { forkedFromId: existing.forkedFromId }
            : {}),
        ...(existing?.archivedRolloutPath !== undefined
          ? { archivedRolloutPath: existing.archivedRolloutPath }
          : {}),
        ...(existing?.archiveCleanupGeneration !== undefined
          ? { archiveCleanupGeneration: existing.archiveCleanupGeneration }
          : {}),
        rolloutPath: params.rolloutStore.rolloutPath,
      };
      registry.set(threadId, entry);
    });
    this.bindLiveRecorder(threadId, params.rolloutStore);
  }

  resumeThread(params: ResumeThreadParams): void {
    this.assertOpen();
    const threadId = params.threadId;
    if (this.liveRecorders.has(threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${threadId} already has a live local writer`,
      );
    }
    this.updateRegistry((registry) => {
      const existing = registry.get(threadId);
      if (
        existing?.archivedAt !== undefined &&
        params.includeArchived !== true
      ) {
        throw new ThreadStoreInvalidRequestError(
          `thread ${threadId} is archived; pass includeArchived=true to resume`,
        );
      }

      this.prepareLiveRecorder(params.rolloutStore);

      const now = new Date().toISOString();
      const entry: RegistryEntry = {
        threadId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.name !== undefined ? { name: existing.name } : {}),
        ...(params.modelProvider !== undefined
          ? { modelProvider: params.modelProvider }
          : existing?.modelProvider !== undefined
            ? { modelProvider: existing.modelProvider }
            : {}),
        ...(params.model !== undefined
          ? { model: params.model }
          : existing?.model !== undefined
            ? { model: existing.model }
            : {}),
        ...(existing?.memoryMode !== undefined
          ? { memoryMode: existing.memoryMode }
          : {}),
        ...(existing?.archivedAt !== undefined
          ? { archivedAt: existing.archivedAt }
          : {}),
        ...(existing?.cwd !== undefined ? { cwd: existing.cwd } : {}),
        ...(existing?.source !== undefined ? { source: existing.source } : {}),
        ...(existing?.forkedFromId !== undefined
          ? { forkedFromId: existing.forkedFromId }
          : {}),
        ...(existing?.archivedRolloutPath !== undefined
          ? { archivedRolloutPath: existing.archivedRolloutPath }
          : {}),
        ...(existing?.archiveCleanupGeneration !== undefined
          ? { archiveCleanupGeneration: existing.archiveCleanupGeneration }
          : {}),
        rolloutPath:
          params.rolloutPath ??
          existing?.rolloutPath ??
          params.rolloutStore.rolloutPath,
      };
      registry.set(threadId, entry);
    });
    this.bindLiveRecorder(threadId, params.rolloutStore);
  }

  appendItems(params: AppendThreadItemsParams): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(params.threadId);
    for (const item of params.items) {
      recorder.appendRollout(item);
    }
    recorder.flushDurable();
    this.indexRolloutFile(recorder.rolloutPath);
  }

  persistThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
  }

  flushThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
  }

  shutdownThread(threadId: ThreadId): void {
    this.assertOpen();
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
    this.unbindLiveRecorder(threadId, recorder);
    let archivedSessionDir: string | undefined;
    this.withRegistryLock(() => {
      const registry = this.readRegistryUnlocked(true);
      const existing = registry.get(threadId);
      if (
        existing === undefined ||
        existing.archivedAt === undefined ||
        existing.archivedRolloutPath !== undefined
      ) {
        return;
      }
      // This instance owns the writer it just flushed, so the rollout lease
      // it still holds is not a foreign live writer.
      const archivedRolloutPath = this.archiveRolloutFile(existing, {
        ownedWriter: true,
      });
      if (archivedRolloutPath === undefined) return;
      if (existing.rolloutPath) archivedSessionDir = dirname(existing.rolloutPath);
      registry.set(threadId, {
        ...existing,
        archivedRolloutPath,
        updatedAt: new Date().toISOString(),
      });
      this.writeRegistryUnlocked(registry);
      if (archivedSessionDir !== undefined) removeDisplayArtifacts(archivedSessionDir);
    });
  }

  discardThread(threadId: ThreadId): void {
    this.assertOpen();
    // Drops the live entry without flushing: we do NOT call flushDurable.
    const recorder = this.liveRecorders.get(threadId);
    if (recorder === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    this.unbindLiveRecorder(threadId, recorder);
  }

  loadHistory(params: LoadThreadHistoryParams): StoredThreadHistory {
    this.assertOpen();
    const registry = this.readRegistry();
    const entry = registry.get(params.threadId);
    if (entry?.archivedAt !== undefined && params.includeArchived !== true) {
      throw new ThreadNotFoundError(params.threadId);
    }
    const live = this.liveRecorders.get(params.threadId);
    if (live !== undefined) {
      return {
        threadId: params.threadId,
        items: live.readAll(),
      };
    }
    if (entry === undefined) {
      throw new ThreadNotFoundError(params.threadId);
    }
    const rolloutPath = this.readableRolloutPath(entry);
    if (rolloutPath === undefined) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${params.threadId} has no rollout path`,
      );
    }
    if (!existsSync(rolloutPath)) {
      throw new ThreadNotFoundError(params.threadId);
    }
    return {
      threadId: params.threadId,
      items: this.readRolloutItems(rolloutPath),
    };
  }

  readThread(params: ReadThreadParams): StoredThread {
    this.assertOpen();
    const registry = this.readRegistry();
    const entry = registry.get(params.threadId);
    if (entry === undefined) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (entry.archivedAt !== undefined && !params.includeArchived) {
      throw new ThreadNotFoundError(params.threadId);
    }
    const history = params.includeHistory
      ? this.loadHistory({
          threadId: params.threadId,
          includeArchived: params.includeArchived,
        })
      : undefined;
    return toStoredThread(entry, this.defaultModelProviderId, history);
  }

  publishTranscriptArtifact(threadId: ThreadId, observedRolloutPath: string, bytes: Buffer): string {
    this.assertOpen();
    return this.withRegistryLock(() => {
      let candidate = observedRolloutPath;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const entry = this.readRegistryUnlocked(true).get(threadId);
        const current = entry === undefined ? undefined : this.readableRolloutPath(entry);
        if (current === undefined) throw new ThreadNotFoundError(threadId);
        if (current !== candidate) {
          candidate = current;
          continue;
        }
        // Archive takes the registry lock before moving this journal. Retention
        // takes its canonical rollout lease before removing the session dir.
        // Do not let lock acquisition create a directory that retention moved.
        if (!existsSync(current)) throw new ThreadNotFoundError(threadId);
        let digest: string;
        const ownWriter = this.liveRecorders.get(threadId);
        if (ownWriter?.rolloutPath === current) {
          digest = persistDisplayArtifactBytes(dirname(current), bytes);
        } else {
          const lease = new SessionLock(`${current}.lock`);
          try {
            try {
              lease.acquire({ createParent: false });
            } catch (error) {
              if (!(error instanceof SessionLockedError)) throw error;
              // A foreign foreground writer can own this lease for the whole
              // session. Retention takes the project registry lock before its
              // lease and directory removal, so it cannot be the holder here.
              if (!existsSync(current)) throw new ThreadNotFoundError(threadId);
            }
            if (!existsSync(current)) throw new ThreadNotFoundError(threadId);
            digest = persistDisplayArtifactBytes(dirname(current), bytes);
          } finally {
            lease.release();
          }
        }
        // A former registry holder could have lost its lock to a stale-lock
        // race while the foreign writer still held the rollout lease. Verify
        // the committed location after the write and retry a moved session.
        const latest = this.readRegistryUnlocked(true).get(threadId);
        const latestPath = latest === undefined ? undefined : this.readableRolloutPath(latest);
        if (latestPath === undefined) throw new ThreadNotFoundError(threadId);
        if (latestPath !== current) {
          candidate = latestPath;
          continue;
        }
        try {
          if (readDisplayArtifact(dirname(latestPath), digest).equals(bytes)) return digest;
        } catch { /* The current location was cleaned up while publishing. */ }
      }
      throw new ThreadStoreInvalidRequestError(`thread ${threadId} moved during transcript artifact publication`);
    });
  }

  readThreadByRolloutPath(params: ReadThreadByRolloutPathParams): StoredThread {
    this.assertOpen();
    const rolloutPath = this.validateReadableRolloutPath(params.rolloutPath);
    const fileThreadId = threadIdFromRolloutPath(rolloutPath);
    if (fileThreadId === undefined) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path does not contain a thread id: ${rolloutPath}`,
      );
    }
    const meta = firstSessionMetaFromRollout(rolloutPath);
    if (meta?.sessionId !== undefined && meta.sessionId !== fileThreadId) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path thread id ${fileThreadId} disagrees with session metadata ${meta.sessionId}`,
      );
    }

    const registry = this.readRegistry();
    const pathEntry = this.findEntryByRolloutPath(registry, rolloutPath);
    if (pathEntry !== undefined && pathEntry.threadId !== fileThreadId) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path belongs to ${pathEntry.threadId}, not ${fileThreadId}`,
      );
    }

    let entry = pathEntry ?? registry.get(fileThreadId);
    if (entry === undefined) {
      this.indexRolloutFile(rolloutPath);
      const refreshed = this.readRegistry();
      entry =
        this.findEntryByRolloutPath(refreshed, rolloutPath) ??
        refreshed.get(fileThreadId);
    }
    if (entry === undefined) {
      throw new ThreadNotFoundError(fileThreadId);
    }
    const readablePath = this.readableRolloutPath(entry);
    if (
      readablePath === undefined ||
      !sameExistingPath(readablePath, rolloutPath)
    ) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path does not match thread ${fileThreadId}`,
      );
    }
    return this.readThread({
      threadId: fileThreadId,
      includeArchived: params.includeArchived,
      includeHistory: params.includeHistory,
    });
  }

  listThreads(params: ListThreadsParams): ThreadPage {
    this.assertOpen();
    const pageSize = validatePageSize(params.pageSize);
    const scope = normalizeListScope(params);
    const cursor = parseThreadCursor(params.cursor, scope.hash);
    // Daemon control-plane listings deliberately use the state DB only and do
    // not request the richer resume-picker filters. Serve that hot path with a
    // SQL LIMIT page so session.list never materializes the complete persisted
    // registry merely to return a small page.
    if (
      params.useStateDbOnly === true &&
      scope.allowedSources === undefined &&
      scope.modelProviders === undefined &&
      scope.cwdFilters === undefined &&
      scope.searchTerm === undefined &&
      (cursor === undefined || cursor.kind === "keyset")
    ) {
      const sortKey: ThreadSortKey = params.sortKey ?? "created_at";
      const sortDirection: SortDirection = params.sortDirection ?? "desc";
      const page = this.threadIndex.listThreadPage({
        limit: pageSize,
        archived: params.archived,
        sortKey,
        sortDirection,
        ...(cursor?.kind === "keyset"
          ? {
              after: {
                sortValue: cursor.sortValue,
                threadId: cursor.threadId,
              },
            }
          : {}),
      });
      const last = page.items.at(-1);
      return {
        items: page.items.map((entry) =>
          toStoredThread(entry, this.defaultModelProviderId),
        ),
        ...(page.hasMore && last !== undefined
          ? {
              nextCursor: formatKeysetThreadCursor({
                kind: "keyset",
                sortValue:
                  sortKey === "updated_at" ? last.updatedAt : last.createdAt,
                threadId: last.threadId,
                scopeHash: scope.hash,
              }),
            }
          : {}),
      };
    }
    const registry = this.readRegistry(params.useStateDbOnly !== true);
    const wantArchived = params.archived;
    const entries = Array.from(registry.values()).filter((e) => {
      const isArchived = e.archivedAt !== undefined;
      return (
        (wantArchived ? isArchived : !isArchived) &&
        matchesListScope(e, scope, this.defaultModelProviderId) &&
        this.matchesSearch(e, scope.searchTerm)
      );
    });
    const sortKey: ThreadSortKey = params.sortKey ?? "created_at";
    const sortDir: SortDirection = params.sortDirection ?? "desc";
    entries.sort((a, b) => {
      const aKey = sortKey === "created_at" ? a.createdAt : a.updatedAt;
      const bKey = sortKey === "created_at" ? b.createdAt : b.updatedAt;
      const cmp =
        aKey.localeCompare(bKey) || a.threadId.localeCompare(b.threadId);
      return sortDir === "asc" ? cmp : -cmp;
    });
    const start = cursor?.kind === "offset" ? cursor.offset : 0;
    const sliced = entries.slice(start, start + pageSize);
    const nextOffset = start + sliced.length;
    const nextCursor =
      nextOffset < entries.length
        ? formatOffsetThreadCursor({
            kind: "offset",
            offset: nextOffset,
            scopeHash: scope.hash,
          })
        : undefined;
    return {
      items: sliced.map((e) => toStoredThread(e, this.defaultModelProviderId)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  countThreads(params: {
    readonly archived: boolean;
    readonly excludeThreadIds?: ReadonlySet<string>;
  }): number {
    this.assertOpen();
    let count = this.threadIndex.countThreads(params.archived);
    for (const threadId of params.excludeThreadIds ?? []) {
      const thread = this.threadIndex.getThread(threadId);
      if (
        thread !== undefined &&
        (thread.archivedAt !== undefined) === params.archived
      ) {
        count -= 1;
      }
    }
    return Math.max(0, count);
  }

  updateThreadMetadata(params: UpdateThreadMetadataParams): StoredThread {
    this.assertOpen();
    if (params.patch.gitInfo !== undefined) {
      // The local store rejects git-info patches.
      throw new ThreadStoreInvalidRequestError(
        "FileThreadStore does not implement git metadata updates",
      );
    }
    if (
      params.patch.name !== undefined &&
      params.patch.memoryMode !== undefined
    ) {
      // One metadata field per patch.
      throw new ThreadStoreInvalidRequestError(
        "FileThreadStore applies one metadata field per patch",
      );
    }
    let result: StoredThread | undefined;
    this.updateRegistry((registry) => {
      const existing = registry.get(params.threadId);
      if (existing === undefined) {
        throw new ThreadNotFoundError(params.threadId);
      }
      if (existing.archivedAt !== undefined && !params.includeArchived) {
        throw new ThreadNotFoundError(params.threadId);
      }
      const now = new Date().toISOString();
      const updated: RegistryEntry = {
        ...existing,
        updatedAt: now,
        ...(params.patch.name !== undefined ? { name: params.patch.name } : {}),
        ...(params.patch.memoryMode !== undefined
          ? { memoryMode: params.patch.memoryMode }
          : {}),
      };
      if (params.patch.memoryMode !== undefined) {
        this.appendMemoryModeSessionMeta(updated, params.patch.memoryMode);
        this.indexReadableRollout(updated);
      }
      registry.set(params.threadId, updated);
      result = toStoredThread(updated, this.defaultModelProviderId);
    });
    return result!;
  }

  archiveThread(params: ArchiveThreadParams): void {
    this.assertOpen();
    // Re-archiving an active thread must not overwrite the only path that
    // records a failed unarchive cleanup.
    this.finishPendingUnarchiveCleanup(params.threadId);
    let archivedSessionDir: string | undefined;
    let archiveArtifactDir: string | undefined;
    timed("thread_archive", () =>
      this.withRegistryLock(() => {
        const registry = this.readRegistryUnlocked(true);
        const existing = registry.get(params.threadId);
        if (existing === undefined) {
          throw new ThreadNotFoundError(params.threadId);
        }
        if (existing.archivedAt !== undefined) {
          // The registry may have committed before artifact removal failed.
          // A repeated archive also completes a move if a foreign writer
          // released its lease without calling shutdownThread.
          if (!this.liveRecorders.has(params.threadId)) {
            const archivedRolloutPath = existing.archivedRolloutPath ?? this.archiveRolloutFile(existing);
            if (archivedRolloutPath !== undefined) archiveArtifactDir = dirname(archivedRolloutPath);
            if (archivedRolloutPath !== undefined && existing.archivedRolloutPath === undefined) {
              registry.set(params.threadId, { ...existing, archivedRolloutPath, updatedAt: new Date().toISOString() });
            }
            if (existing.rolloutPath && (archivedRolloutPath !== undefined || !existsSync(existing.rolloutPath))) archivedSessionDir = dirname(existing.rolloutPath);
          }
          this.writeRegistryUnlocked(registry);
          if (archivedSessionDir !== undefined) removeDisplayArtifacts(archivedSessionDir);
          if (archiveArtifactDir !== undefined && archiveArtifactDir !== archivedSessionDir) removeDisplayArtifacts(archiveArtifactDir);
          return;
        }
        const now = new Date().toISOString();
        this.appendThreadMetadataRollout(existing, {
          archivedAt: now,
        });
        const archivedRolloutPath = this.liveRecorders.has(params.threadId)
          ? existing.archivedRolloutPath
          : this.archiveRolloutFile(existing);
        if (archivedRolloutPath !== undefined) archiveArtifactDir = dirname(archivedRolloutPath);
        if (archivedRolloutPath !== undefined && existing.rolloutPath) archivedSessionDir = dirname(existing.rolloutPath);
        registry.set(params.threadId, {
          ...existing,
          updatedAt: now,
          archivedAt: now,
          ...(archivedRolloutPath !== undefined ? { archivedRolloutPath } : {}),
        });
        this.writeRegistryUnlocked(registry);
        if (archivedSessionDir !== undefined) removeDisplayArtifacts(archivedSessionDir);
        if (archiveArtifactDir !== undefined && archiveArtifactDir !== archivedSessionDir) removeDisplayArtifacts(archiveArtifactDir);
      }),
    );
  }

  unarchiveThread(params: ArchiveThreadParams): StoredThread {
    this.assertOpen();
    let result: StoredThread | undefined;
    let archiveArtifactDir: string | undefined;
    this.updateRegistry((registry) => {
      const existing = registry.get(params.threadId);
      if (existing === undefined) {
        throw new ThreadNotFoundError(params.threadId);
      }
      if (existing.archivedAt === undefined) {
        if (existing.archivedRolloutPath !== undefined) archiveArtifactDir = dirname(existing.archivedRolloutPath);
        result = toStoredThread(existing, this.defaultModelProviderId);
        return;
      }
      const now = new Date().toISOString();
      this.appendThreadMetadataRollout(existing, {
        archivedAt: null,
      });
      const restoredRolloutPath = this.liveRecorders.has(params.threadId)
        ? existing.rolloutPath
        : this.unarchiveRolloutFile(existing);
      if (existing.archivedRolloutPath !== undefined) archiveArtifactDir = dirname(existing.archivedRolloutPath);
      const {
        archivedAt: _drop,
        ...rest
      } = existing;
      void _drop;
      // Keep archivedRolloutPath as a durable cleanup cursor. A crash or
      // failed removal can resume after the active registry transition.
      const updated: RegistryEntry = {
        ...rest,
        updatedAt: now,
        ...(existing.archivedRolloutPath !== undefined
          ? { archiveCleanupGeneration: randomUUID() }
          : {}),
        ...(restoredRolloutPath !== undefined
          ? { rolloutPath: restoredRolloutPath }
          : {}),
      };
      registry.set(params.threadId, updated);
      result = toStoredThread(updated, this.defaultModelProviderId);
    });
    if (archiveArtifactDir !== undefined) this.finishPendingUnarchiveCleanup(params.threadId);
    return result!;
  }

  private finishPendingUnarchiveCleanup(threadId?: ThreadId): void {
    const entries = threadId === undefined
      ? this.threadIndex.listThreads()
      : [this.threadIndex.getThread(threadId)];
    for (const entry of entries) {
      if (entry === undefined || entry.archivedAt !== undefined || entry.archivedRolloutPath === undefined) continue;
      this.withRegistryLock(() => {
        const registry = this.readRegistryUnlocked(true);
        const current = registry.get(entry.threadId);
        if (current === undefined || current.archivedAt !== undefined || current.archivedRolloutPath === undefined || current.archivedRolloutPath !== entry.archivedRolloutPath || current.archiveCleanupGeneration !== entry.archiveCleanupGeneration) return;
        removeDisplayArtifacts(dirname(current.archivedRolloutPath));
        const { archivedRolloutPath: _drop, archiveCleanupGeneration: _generation, ...cleaned } = current;
        void _drop;
        void _generation;
        registry.set(entry.threadId, cleaned);
        this.writeRegistryUnlocked(registry);
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const recorder of this.liveRecorders.values()) {
      recorder.setOnRolloutCommitted(undefined);
    }
    this.liveRecorders.clear();
    this.stateDriver.close();
  }

  /** Per-project state directory this store is bound to (DAE-03 multi-project). */
  getProjectDir(): string {
    return this.projectDir;
  }

  /** A daemon may evict this project's read cache once no writer uses it. */
  hasLiveRecorders(): boolean {
    return this.liveRecorders.size > 0;
  }

  // ── internal helpers ────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) {
      throw new ThreadStoreInvalidRequestError("FileThreadStore is closed");
    }
  }

  private validateReadableRolloutPath(rolloutPath: string): string {
    if (rolloutPath.trim().length === 0) {
      throw new ThreadStoreInvalidRequestError("rollout path is empty");
    }
    const resolved = isAbsolute(rolloutPath)
      ? rolloutPath
      : resolve(rolloutPath);
    if (!isRolloutJsonlPath(resolved)) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path must point to a rollout JSONL file: ${rolloutPath}`,
      );
    }
    if (!existsSync(resolved)) {
      throw new ThreadStoreInvalidRequestError(
        `rollout file does not exist: ${rolloutPath}`,
      );
    }
    const canonical = realpathSync(resolved);
    if (
      !isPathInside(canonical, this.projectDir) &&
      !this.isRegisteredRolloutPath(canonical)
    ) {
      throw new ThreadStoreInvalidRequestError(
        `rollout path is outside this thread store: ${rolloutPath}`,
      );
    }
    return canonical;
  }

  private isRegisteredRolloutPath(canonicalPath: string): boolean {
    for (const recorder of this.liveRecorders.values()) {
      if (sameExistingPath(recorder.rolloutPath, canonicalPath)) return true;
    }
    for (const entry of this.readRegistry().values()) {
      if (
        (entry.rolloutPath !== undefined &&
          sameExistingPath(entry.rolloutPath, canonicalPath)) ||
        (entry.archivedRolloutPath !== undefined &&
          sameExistingPath(entry.archivedRolloutPath, canonicalPath))
      ) {
        return true;
      }
    }
    return false;
  }

  private findEntryByRolloutPath(
    registry: ReadonlyMap<ThreadId, RegistryEntry>,
    rolloutPath: string,
  ): RegistryEntry | undefined {
    for (const entry of registry.values()) {
      if (
        (entry.rolloutPath !== undefined &&
          sameExistingPath(entry.rolloutPath, rolloutPath)) ||
        (entry.archivedRolloutPath !== undefined &&
          sameExistingPath(entry.archivedRolloutPath, rolloutPath))
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private matchesSearch(
    entry: RegistryEntry,
    searchTerm: string | undefined,
  ): boolean {
    if (searchTerm === undefined) return true;
    const name = entry.name?.toLocaleLowerCase();
    if (name?.includes(searchTerm)) return true;
    const firstUserMessage = this.firstUserMessage(entry)?.toLocaleLowerCase();
    return firstUserMessage?.includes(searchTerm) ?? false;
  }

  private firstUserMessage(entry: RegistryEntry): string | undefined {
    const live = this.liveRecorders.get(entry.threadId);
    const rolloutPath = live?.rolloutPath ?? this.readableRolloutPath(entry);
    if (rolloutPath === undefined || !existsSync(rolloutPath)) return undefined;
    return readFirstUserMessageFromRollout(rolloutPath);
  }

  private readableRolloutPath(entry: RegistryEntry): string | undefined {
    if (entry.archivedAt !== undefined) {
      return entry.archivedRolloutPath ?? entry.rolloutPath;
    }
    return entry.rolloutPath ?? entry.archivedRolloutPath;
  }

  private readRolloutItems(rolloutPath: string): RolloutItem[] {
    if (!existsSync(rolloutPath)) {
      throw new ThreadStoreInvalidRequestError(
        `rollout file does not exist: ${rolloutPath}`,
      );
    }
    const raw = readFileSync(rolloutPath, "utf8");
    const items: RolloutItem[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let parsed: RolloutItem | null;
      try {
        parsed = parseRolloutLine(line);
      } catch {
        // Skip a corrupt interior line rather than aborting the whole
        // reconstruction — one bad row must not strand every later row.
        continue;
      }
      if (parsed !== null) items.push(parsed);
    }
    return items;
  }

  private appendMemoryModeSessionMeta(
    entry: RegistryEntry,
    memoryMode: ThreadMemoryMode,
  ): void {
    const live = this.liveRecorders.get(entry.threadId);
    if (live !== undefined) {
      const latest = latestSessionMeta(live.readAll());
      live.appendRollout(
        {
          type: "session_meta",
          payload: {
            ...buildFallbackSessionMeta(entry),
            ...(latest ?? {}),
            memoryMode,
          },
        },
        { durable: true },
      );
      return;
    }

    const rolloutPath = this.readableRolloutPath(entry);
    if (rolloutPath === undefined) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${entry.threadId} has no rollout path`,
      );
    }
    const latest = latestSessionMeta(this.readRolloutItems(rolloutPath));
    appendFileSync(
      rolloutPath,
      serializeRolloutItem({
        type: "session_meta",
        payload: {
          ...buildFallbackSessionMeta(entry),
          ...(latest ?? {}),
          memoryMode,
        },
      }),
      "utf8",
    );
  }

  private appendThreadMetadataRollout(
    entry: RegistryEntry,
    patch: { readonly archivedAt?: string | null },
  ): void {
    const payload = {
      ...buildFallbackSessionMeta(entry),
      threadMetadata: patch,
    };
    const live = this.liveRecorders.get(entry.threadId);
    if (live !== undefined) {
      live.appendRollout(
        {
          type: "session_meta",
          payload,
        } as RolloutItem,
        { durable: true },
      );
      this.indexRolloutFile(live.rolloutPath);
      return;
    }
    const rolloutPath = this.readableRolloutPath(entry);
    if (rolloutPath === undefined || !existsSync(rolloutPath)) return;
    // Another store instance may own a live writer for this rollout (the
    // daemon archives sessions that bootstrap-services' store created). A
    // foreign appendFileSync would bypass that writer's size and offset
    // bookkeeping, so under a held lease the registry alone records the
    // change and the file is left to its owner.
    this.withRolloutLease(rolloutPath, () => {
      appendFileSync(
        rolloutPath,
        serializeRolloutItem({
          type: "session_meta",
          payload,
        } as RolloutItem),
        "utf8",
      );
      this.indexRolloutFile(rolloutPath);
    });
  }

  /**
   * Run `fn` while holding the rollout's session lease. Returns undefined
   * without running it when a live process (this one included) already holds
   * the lease: the same check retention uses before deleting a session.
   */
  private withRolloutLease<T>(rolloutPath: string, fn: () => T): T | undefined {
    const lease = new SessionLock(`${rolloutPath}.lock`);
    try {
      lease.acquire();
    } catch (error) {
      if (error instanceof SessionLockedError) return undefined;
      throw error;
    }
    try {
      return fn();
    } finally {
      lease.release();
    }
  }

  private indexReadableRollout(entry: RegistryEntry): void {
    const live = this.liveRecorders.get(entry.threadId);
    if (live !== undefined) {
      live.flushDurable();
      this.indexRolloutFile(live.rolloutPath);
      return;
    }
    const rolloutPath = this.readableRolloutPath(entry);
    if (rolloutPath !== undefined && existsSync(rolloutPath)) {
      this.indexRolloutFile(rolloutPath);
    }
  }

  private indexRolloutFile(rolloutPath: string): void {
    backfillRolloutFile({
      rolloutPath,
      threads: this.threadIndex,
    });
  }

  /**
   * Register a live recorder and keep the SQLite mirror current as it
   * flushes. Sessions normally append via `RolloutStore` directly, so
   * without this hook the mirror only updates on explicit store calls
   * (`appendItems`, metadata patches, path lookups).
   */
  private bindLiveRecorder(threadId: ThreadId, rolloutStore: RolloutStore): void {
    rolloutStore.setOnRolloutCommitted((rolloutPath) => {
      if (this.closed) return;
      if (this.liveRecorders.get(threadId) !== rolloutStore) return;
      this.indexRolloutFile(rolloutPath);
    });
    this.liveRecorders.set(threadId, rolloutStore);
  }

  private prepareLiveRecorder(rolloutStore: RolloutStore): void {
    if (existsSync(rolloutStore.rolloutPath)) {
      this.indexRolloutFile(rolloutStore.rolloutPath);
    }
  }

  private unbindLiveRecorder(
    threadId: ThreadId,
    rolloutStore: RolloutStore,
  ): void {
    if (this.liveRecorders.get(threadId) === rolloutStore) {
      this.liveRecorders.delete(threadId);
    }
    rolloutStore.setOnRolloutCommitted(undefined);
  }

  private archiveRolloutFile(
    entry: RegistryEntry,
    options: { readonly ownedWriter?: boolean } = {},
  ): string | undefined {
    const rolloutPath = entry.rolloutPath;
    if (rolloutPath === undefined || !existsSync(rolloutPath)) {
      return entry.archivedRolloutPath;
    }
    const relocate = (): string => {
      const targetDir = join(this.archivedSessionsDir, entry.threadId);
      mkdirSync(targetDir, { recursive: true });
      let targetPath = join(targetDir, basename(rolloutPath));
      if (existsSync(targetPath) && targetPath !== rolloutPath) {
        targetPath = join(targetDir, `${Date.now()}-${basename(rolloutPath)}`);
      }
      this.relocateRolloutFile(rolloutPath, targetPath);
      return targetPath;
    };
    if (options.ownedWriter === true) return relocate();
    // A held lease means a live writer elsewhere still owns this file; a
    // rename now would split its journal across two paths (the writer keeps
    // appending by path) and leave the daemon snapshot pointing at the old
    // one. Record the archive in the registry only; the owner's
    // shutdownThread completes the move once it releases the lease.
    return this.withRolloutLease(rolloutPath, relocate) ?? entry.archivedRolloutPath;
  }

  private unarchiveRolloutFile(entry: RegistryEntry): string | undefined {
    const archivedPath = entry.archivedRolloutPath;
    if (archivedPath === undefined || !existsSync(archivedPath)) {
      return entry.rolloutPath;
    }
    const restoredPath =
      entry.rolloutPath ??
      join(this.projectDir, "sessions", entry.threadId, basename(archivedPath));
    mkdirSync(dirname(restoredPath), { recursive: true });
    this.relocateRolloutFile(archivedPath, restoredPath);
    return restoredPath;
  }

  private relocateRolloutFile(sourcePath: string, targetPath: string): void {
    renameSync(sourcePath, targetPath);
    try {
      this.threadIndex.relocateRolloutSource(sourcePath, targetPath);
    } catch (error) {
      try {
        renameSync(targetPath, sourcePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `rollout relocation failed and filesystem rollback could not restore ${sourcePath}`,
        );
      }
      throw error;
    }
  }

  private liveRecorderOrThrow(threadId: ThreadId): RolloutStore {
    const recorder = this.liveRecorders.get(threadId);
    if (recorder === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    return recorder;
  }

  private readRegistry(includeLegacy = true): Map<ThreadId, RegistryEntry> {
    // Index-only reads touch nothing but SQLite (which provides its own
    // consistency) — taking the exclusive directory lock here would let a
    // daemon writing a rollout stall a read-only caller (e.g. the /resume
    // picker) for up to the full 30s acquisition window
    // (audit finding #1).
    if (!includeLegacy) {
      return this.readRegistryUnlocked(false);
    }
    return this.withRegistryLock(() =>
      this.readRegistryUnlocked(includeLegacy),
    );
  }

  private updateRegistry(
    mutator: (registry: Map<ThreadId, RegistryEntry>) => void,
  ): void {
    this.withRegistryLock(() => {
      const registry = this.readRegistryUnlocked(true);
      mutator(registry);
      this.writeRegistryUnlocked(registry);
    });
  }

  private readRegistryUnlocked(
    includeLegacy: boolean,
  ): Map<ThreadId, RegistryEntry> {
    const result = new Map<ThreadId, RegistryEntry>();
    for (const entry of this.threadIndex.listThreads()) {
      const normalized = normalizeRegistryEntry(entry);
      if (normalized !== undefined) result.set(normalized.threadId, normalized);
    }
    if (!includeLegacy) {
      return result;
    }

    // The legacy import walks sessions/ + archived_sessions/ and stats every
    // rollout — and every imported entry is upserted into the SQLite index,
    // so later reads see it from `threadIndex.listThreads()` above. Running
    // it once per store instance is therefore sufficient; before this guard
    // it re-ran per readRegistry call (O(N²) directory walks when listing N
    // threads — audit finding #1).
    if (this.legacyImportDone) {
      return result;
    }
    for (const [threadId, entry] of this.importLegacyRegistry()) {
      const merged = mergeLegacyEntry(result.get(threadId), entry);
      result.set(threadId, merged);
      this.threadIndex.upsertThread(merged);
    }
    this.legacyImportDone = true;
    return result;
  }

  private writeRegistryUnlocked(registry: Map<ThreadId, RegistryEntry>): void {
    for (const entry of registry.values()) {
      this.threadIndex.upsertThread(entry);
    }
  }

  private withRegistryLock<T>(fn: () => T): T {
    const lock = new ThreadRegistryLock(this.projectDir);
    try { lock.acquire(); }
    catch (error) { throw new ThreadStoreConflictError((error as Error).message); }
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  private backupCorruptRegistry(): void {
    if (!existsSync(this.registryPath)) return;
    const hash = fileSha256(this.registryPath);
    const backupDir = join(this.projectDir, "state-corrupt");
    const backupPath = join(backupDir, `threads-${hash}.json`);
    if (existsSync(backupPath)) return;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    copyFileSync(this.registryPath, backupPath);
  }

  private importLegacyRegistry(): Map<ThreadId, RegistryEntry> {
    const result = new Map<ThreadId, RegistryEntry>();
    for (const [threadId, entry] of this.readLegacyThreadsJson()) {
      result.set(threadId, entry);
    }
    for (const session of listResumableSessions(this.projectDir)) {
      result.set(
        session.sessionId,
        mergeLegacyEntry(result.get(session.sessionId), {
          threadId: session.sessionId,
          createdAt: new Date(session.lastModified).toISOString(),
          updatedAt: new Date(session.lastModified).toISOString(),
          rolloutPath: session.rolloutPath,
        }),
      );
    }

    for (const rolloutPath of listRolloutFilesRecursive(
      this.archivedSessionsDir,
    )) {
      const imported = entryFromRolloutPath(rolloutPath, true);
      if (imported === undefined) continue;
      result.set(
        imported.threadId,
        mergeLegacyEntry(result.get(imported.threadId), imported),
      );
    }

    for (const [threadId, entry] of result) {
      const enriched = entryFromRolloutPath(
        entry.rolloutPath ?? entry.archivedRolloutPath ?? "",
        entry.archivedAt !== undefined,
      );
      if (enriched !== undefined) {
        result.set(threadId, mergeLegacyEntry(entry, enriched));
      }
    }
    return result;
  }

  private readLegacyThreadsJson(): Map<ThreadId, RegistryEntry> {
    const result = new Map<ThreadId, RegistryEntry>();
    if (!existsSync(this.registryPath)) return result;
    try {
      const raw = readFileSync(this.registryPath, "utf8");
      if (raw.trim().length === 0) return result;
      const parsed = JSON.parse(raw) as RegistrySnapshot;
      if (
        parsed.version !== REGISTRY_VERSION ||
        !Array.isArray(parsed.threads)
      ) {
        throw new Error("invalid registry shape");
      }
      for (const entry of parsed.threads) {
        const normalized = normalizeRegistryEntry(entry);
        if (normalized !== undefined) {
          result.set(normalized.threadId, normalized);
        }
      }
    } catch {
      this.backupCorruptRegistry();
    }
    return result;
  }
}

function toStoredThread(
  entry: RegistryEntry,
  defaultModelProviderId: string,
  history?: StoredThreadHistory,
): StoredThread {
  const rolloutPath =
    entry.archivedAt !== undefined
      ? (entry.archivedRolloutPath ?? entry.rolloutPath)
      : (entry.rolloutPath ?? entry.archivedRolloutPath);
  return {
    threadId: entry.threadId,
    ...(entry.parentThreadId !== undefined ? { parentThreadId: entry.parentThreadId } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    modelProvider: entry.modelProvider ?? defaultModelProviderId,
    ...(rolloutPath !== undefined ? { rolloutPath } : {}),
    ...(entry.forkedFromId !== undefined
      ? { forkedFromId: entry.forkedFromId }
      : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.memoryMode !== undefined ? { memoryMode: entry.memoryMode } : {}),
    ...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(entry.source !== undefined ? { source: entry.source } : {}),
    ...(history !== undefined ? { history } : {}),
  };
}

function latestSessionMeta(
  items: ReadonlyArray<RolloutItem>,
): SessionMetaLine | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "session_meta") {
      return item.payload;
    }
  }
  return undefined;
}

function buildFallbackSessionMeta(entry: RegistryEntry): SessionMetaLine {
  const serializedSource = serializeThreadSource(entry.source);
  return {
    sessionId: entry.threadId,
    timestamp: entry.updatedAt,
    cwd: entry.cwd ?? process.cwd(),
    originator: serializedSource ?? "thread-store",
    agencVersion: "unknown",
    rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.modelProvider !== undefined
      ? { modelProvider: entry.modelProvider }
      : {}),
    ...(serializedSource !== undefined ? { source: serializedSource } : {}),
  };
}

interface ListScope {
  readonly hash: string;
  readonly allowedSources?: ReadonlySet<string>;
  readonly modelProviders?: ReadonlySet<string>;
  readonly cwdFilters?: ReadonlySet<string>;
  readonly searchTerm?: string;
}

function validatePageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new ThreadStoreInvalidRequestError(
      "pageSize must be an integer between 1 and 500",
    );
  }
  return pageSize;
}

function normalizeListScope(params: ListThreadsParams): ListScope {
  const allowedSources =
    params.allowedSources === undefined || params.allowedSources.length === 0
      ? undefined
      : new Set(
          params.allowedSources.map((source) =>
            stableStringify(canonicalizeThreadSource(source)),
          ),
        );
  const modelProviders =
    params.modelProviders === undefined || params.modelProviders.length === 0
      ? undefined
      : new Set(
          params.modelProviders.filter((provider) => provider.length > 0),
        );
  const cwdFilters =
    params.cwdFilters === undefined
      ? undefined
      : new Set(params.cwdFilters.map((cwd) => canonicalPath(cwd)));
  const search = params.searchTerm?.trim().toLocaleLowerCase();
  const scopeShape = {
    archived: params.archived,
    sortKey: params.sortKey ?? "created_at",
    sortDirection: params.sortDirection ?? "desc",
    allowedSources:
      allowedSources === undefined ? undefined : [...allowedSources].sort(),
    modelProviders:
      modelProviders === undefined ? undefined : [...modelProviders].sort(),
    cwdFilters: cwdFilters === undefined ? undefined : [...cwdFilters].sort(),
    searchTerm: search === "" ? undefined : search,
    useStateDbOnly: params.useStateDbOnly === true,
  };
  return {
    hash: createHash("sha256")
      .update(stableStringify(scopeShape))
      .digest("hex"),
    ...(allowedSources !== undefined ? { allowedSources } : {}),
    ...(modelProviders !== undefined ? { modelProviders } : {}),
    ...(cwdFilters !== undefined ? { cwdFilters } : {}),
    ...(scopeShape.searchTerm !== undefined
      ? { searchTerm: scopeShape.searchTerm }
      : {}),
  };
}

function matchesListScope(
  entry: RegistryEntry,
  scope: ListScope,
  defaultModelProviderId: string,
): boolean {
  if (
    scope.allowedSources !== undefined &&
    (entry.source === undefined ||
      !scope.allowedSources.has(stableStringify(entry.source)))
  ) {
    return false;
  }
  if (
    scope.modelProviders !== undefined &&
    !scope.modelProviders.has(entry.modelProvider ?? defaultModelProviderId)
  ) {
    return false;
  }
  if (scope.cwdFilters !== undefined) {
    if (scope.cwdFilters.size === 0 || entry.cwd === undefined) return false;
    if (!scope.cwdFilters.has(canonicalPath(entry.cwd))) return false;
  }
  return true;
}

interface OffsetThreadCursor {
  readonly kind: "offset";
  readonly offset: number;
  readonly scopeHash: string;
}

interface KeysetThreadCursor {
  readonly kind: "keyset";
  readonly sortValue: string;
  readonly threadId: string;
  readonly scopeHash: string;
}

type ThreadCursor = OffsetThreadCursor | KeysetThreadCursor;

function parseThreadCursor(
  cursor: string | undefined,
  scopeHash: string,
): ThreadCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as {
      v?: unknown;
      offset?: unknown;
      sortValue?: unknown;
      threadId?: unknown;
      scopeHash?: unknown;
    };
    if (parsed.scopeHash !== scopeHash) {
      throw new Error("cursor scope mismatch");
    }
    if (
      parsed.v === 1 &&
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0 &&
      typeof parsed.scopeHash === "string"
    ) {
      return {
        kind: "offset",
        offset: parsed.offset,
        scopeHash: parsed.scopeHash,
      };
    }
    if (
      parsed.v === 2 &&
      typeof parsed.sortValue === "string" &&
      typeof parsed.threadId === "string" &&
      typeof parsed.scopeHash === "string"
    ) {
      return {
        kind: "keyset",
        sortValue: parsed.sortValue,
        threadId: parsed.threadId,
        scopeHash: parsed.scopeHash,
      };
    }
    throw new Error("invalid cursor shape");
  } catch (cause) {
    throw new ThreadStoreInvalidRequestError(
      `invalid list cursor: ${String((cause as Error).message ?? cause)}`,
    );
  }
}

function formatOffsetThreadCursor(cursor: OffsetThreadCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      offset: cursor.offset,
      scopeHash: cursor.scopeHash,
    }),
    "utf8",
  ).toString("base64url");
}

function formatKeysetThreadCursor(cursor: KeysetThreadCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      sortValue: cursor.sortValue,
      threadId: cursor.threadId,
      scopeHash: cursor.scopeHash,
    }),
    "utf8",
  ).toString("base64url");
}

function normalizeRegistryEntry(value: unknown): RegistryEntry | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string") {
    return undefined;
  }
  const source = normalizeThreadSource(value.source);
  return {
    threadId: value.threadId,
    ...(typeof value.parentThreadId === "string" ? { parentThreadId: value.parentThreadId } : {}),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString(),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.modelProvider === "string"
      ? { modelProvider: value.modelProvider }
      : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(value.memoryMode === "enabled" || value.memoryMode === "disabled"
      ? { memoryMode: value.memoryMode }
      : {}),
    ...(typeof value.archivedAt === "string"
      ? { archivedAt: value.archivedAt }
      : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(typeof value.forkedFromId === "string"
      ? { forkedFromId: value.forkedFromId }
      : {}),
    ...(typeof value.rolloutPath === "string"
      ? { rolloutPath: value.rolloutPath }
      : {}),
    ...(typeof value.archivedRolloutPath === "string"
      ? { archivedRolloutPath: value.archivedRolloutPath }
      : {}),
    ...(typeof value.archiveCleanupGeneration === "string"
      ? { archiveCleanupGeneration: value.archiveCleanupGeneration }
      : {}),
  };
}

function normalizeThreadSource(value: unknown): ThreadSource | undefined {
  try {
    return canonicalizeThreadSource(value);
  } catch {
    return undefined;
  }
}

function canonicalizeThreadSource(value: unknown): ThreadSource {
  if (typeof value === "string") return value;
  if (!isRecord(value)) {
    throw new ThreadStoreInvalidRequestError(
      "thread source must be a string or JSON object",
    );
  }
  return canonicalizeJsonObject(value) as ThreadSource;
}

function canonicalizeJsonObject(
  value: Readonly<Record<string, unknown>>,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (seen.has(value)) {
    throw new ThreadStoreInvalidRequestError("thread source contains a cycle");
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = canonicalizeJsonValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function canonicalizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ThreadStoreInvalidRequestError(
        "thread source contains a non-finite number",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ThreadStoreInvalidRequestError(
        "thread source contains a cycle",
      );
    }
    seen.add(value);
    const result = value.map((item) => canonicalizeJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) return canonicalizeJsonObject(value, seen);
  throw new ThreadStoreInvalidRequestError(
    "thread source contains a non-JSON value",
  );
}

function serializeThreadSource(
  source: ThreadSource | undefined,
): string | undefined {
  if (source === undefined) return undefined;
  if (typeof source === "string") return source;
  try {
    return JSON.stringify(source);
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function canonicalPath(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

function isRolloutJsonlPath(path: string): boolean {
  const name = basename(path);
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function isPathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function sameExistingPath(left: string, right: string): boolean {
  return canonicalExistingPath(left) === canonicalExistingPath(right);
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function firstSessionMetaFromRollout(
  rolloutPath: string,
): SessionMetaLine | undefined {
  return readFirstRolloutMatch(rolloutPath, (item) =>
    item.type === "session_meta" ? item.payload : undefined,
  );
}

function readFirstUserMessageFromRollout(
  rolloutPath: string,
): string | undefined {
  return readFirstRolloutMatch(rolloutPath, (item) => {
    if (item.type !== "response_item" || item.payload.role !== "user") {
      return undefined;
    }
    return textFromResponseContent(item.payload.content);
  });
}

function readFirstRolloutMatch<T>(
  rolloutPath: string,
  predicate: (item: RolloutItem) => T | undefined,
): T | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(rolloutPath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = "";
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += buffer.toString("utf8", 0, bytesRead);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const match = parseRolloutLineForMatch(line, predicate);
        if (match !== undefined) return match;
      }
      if (carry.length > 1024 * 1024) carry = carry.slice(-1024 * 1024);
    }
    return parseRolloutLineForMatch(carry, predicate);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseRolloutLineForMatch<T>(
  line: string,
  predicate: (item: RolloutItem) => T | undefined,
): T | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const parsed = parseRolloutLine(line);
    return parsed === null ? undefined : predicate(parsed);
  } catch {
    return undefined;
  }
}

function textFromResponseContent(
  content: ResponseItem["content"],
): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function mergeLegacyEntry(
  existing: RegistryEntry | undefined,
  legacy: RegistryEntry,
): RegistryEntry {
  if (existing === undefined) return legacy;
  if (existing.archivedAt !== undefined) {
    const archivedRolloutPath =
      existing.archivedRolloutPath ??
      legacy.archivedRolloutPath ??
      (legacy.archivedAt !== undefined ? legacy.rolloutPath : undefined);
    return {
      ...legacy,
      ...existing,
      archivedAt: existing.archivedAt,
      ...(archivedRolloutPath !== undefined ? { archivedRolloutPath } : {}),
    };
  }
  const existingActivePath =
    existing.archivedAt === undefined ? existing.rolloutPath : undefined;
  const legacyActivePath =
    legacy.archivedAt === undefined ? legacy.rolloutPath : undefined;
  const archivedRolloutPath =
    existing.archivedRolloutPath ??
    legacy.archivedRolloutPath ??
    (legacy.archivedAt !== undefined ? legacy.rolloutPath : undefined) ??
    (existing.archivedAt !== undefined ? existing.rolloutPath : undefined);
  const merged: RegistryEntry = {
    ...legacy,
    ...existing,
    ...((existingActivePath ?? legacyActivePath)
      ? { rolloutPath: existingActivePath ?? legacyActivePath }
      : {}),
    ...(archivedRolloutPath !== undefined ? { archivedRolloutPath } : {}),
  };
  if (existingActivePath ?? legacyActivePath) {
    const { archivedAt: _drop, ...active } = merged;
    void _drop;
    return active;
  }
  if (existing.archivedAt !== undefined) {
    return { ...merged, archivedAt: existing.archivedAt };
  }
  if (legacy.archivedAt !== undefined) {
    return { ...merged, archivedAt: legacy.archivedAt };
  }
  return merged;
}

function entryFromRolloutPath(
  rolloutPath: string,
  archived: boolean,
): RegistryEntry | undefined {
  if (!rolloutPath || !existsSync(rolloutPath)) return undefined;
  let meta: SessionMetaLine | null = null;
  try {
    meta = readAndValidateSchemaVersion(rolloutPath);
  } catch {
    meta = null;
  }
  const stats = statSync(rolloutPath);
  const updatedAt = new Date(stats.mtimeMs).toISOString();
  const createdAt = meta?.timestamp ?? updatedAt;
  const threadId = meta?.sessionId ?? threadIdFromRolloutPath(rolloutPath);
  if (threadId === undefined) return undefined;
  const source = normalizeThreadSource(meta?.source);
  const modelProvider =
    typeof meta?.modelProvider === "string" ? meta.modelProvider : undefined;
  return {
    threadId,
    createdAt,
    updatedAt,
    ...(archived
      ? { archivedAt: updatedAt, archivedRolloutPath: rolloutPath }
      : { rolloutPath }),
    ...(meta?.cwd !== undefined ? { cwd: meta.cwd } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(typeof meta?.model === "string" ? { model: meta.model } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
  };
}

function threadIdFromRolloutPath(rolloutPath: string): ThreadId | undefined {
  const fileName = basename(rolloutPath);
  const stem = fileName.endsWith(".jsonl")
    ? fileName.slice(0, -".jsonl".length)
    : fileName;
  const match = stem.match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)$/,
  );
  if (match?.[1]) return match[1];
  const dash = stem.lastIndexOf("-");
  if (dash === -1 || dash === stem.length - 1) return undefined;
  return stem.slice(dash + 1);
}

function listRolloutFilesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        result.push(path);
      }
    }
  }
  return result;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
