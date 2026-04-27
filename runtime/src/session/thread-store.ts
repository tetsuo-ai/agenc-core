/**
 * ThreadStore — storage-neutral thread persistence boundary.
 *
 * Partial hand-port of upstream AgenC runtime `thread-store/` crate
 * (`AgenC runtime-rs/thread-store/src/store.rs` trait + `local/` default impl).
 * Upstream is a large subsystem with two back-ends (filesystem + remote
 * RPC), a SQLite `AgenC runtime-state` metadata DB, paging/cursor listing, cwd
 * filters, search-term filters, Git-info patches, `ThreadNameUpdated`
 * rollout events, and an `archived_sessions/` subdir convention. Gut
 * has none of that scaffolding yet. This port therefore covers only
 * the surface that `LiveThread` (see `./live-thread.ts`) requires to
 * unblock its RESERVED methods (`discard`, `loadHistory`,
 * `updateMemoryMode`) plus a small, well-documented companion surface
 * (create/resume/append/flush/shutdown + listThreads + archive/unarchive)
 * so the interface matches the upstream shape. Deviations and omitted
 * methods are listed at the bottom.
 *
 * Location choice: new file `runtime/src/session/thread-store.ts`.
 *
 *   - `session-store.ts` is already 1600 LOC and owns a different
 *     concept (single on-disk rollout for one session). A thread-store
 *     tracks *multiple* threads and their lifecycle metadata.
 *   - The existing `LocalThreadStore` name in `session.ts` (lines 434)
 *     is a narrower legacy stub interface with only two methods
 *     (`threadName`/`setThreadName`), wired to no-ops in
 *     `bin/bootstrap.ts`. We keep it untouched for now and add the new
 *     `ThreadStore` interface alongside. The two do not collide.
 *   - The default implementation is named `FileThreadStore` (not
 *     `LocalThreadStore`) to avoid the name collision described above.
 *
 * On-disk layout (gut-specific, deviates from upstream):
 *
 *   ~/.agenc/projects/<slug>/
 *     threads.json                   — registry index (this file)
 *     sessions/<threadId>/
 *       rollout-<ts>-<threadId>.jsonl    — rollout file (owned by
 *                                          existing `RolloutStore`)
 *
 * The thread id equals the session id in gut; there is no separate
 * thread/session split.
 *
 * Upstream method → gut port status:
 *
 *   create_thread             WIRED — records in registry + tracks a
 *                             live `RolloutStore` in-memory. Caller
 *                             must have already opened the
 *                             `RolloutStore`; see `createThread`.
 *   resume_thread             WIRED — registers the (already-opened)
 *                             `RolloutStore` as live for this thread
 *                             id. `includeArchived` is honoured against
 *                             the registry.
 *   append_items              WIRED — routes to the live
 *                             `RolloutStore.appendRollout`.
 *   persist_thread            WIRED — flushes durably.
 *   flush_thread              WIRED — flushes durably.
 *   shutdown_thread           WIRED — flushes and drops the live entry.
 *                             The `RolloutStore` is NOT closed here
 *                             because the store lifecycle is owned by
 *                             `Session`, not the thread store.
 *   discard_thread            WIRED — drops the live entry without
 *                             flushing. Gut has no
 *                             `LiveThreadInitGuard::Drop` analog; the
 *                             TS `LiveThreadInitGuard` below uses an
 *                             explicit `commit`/`discard` pattern.
 *   load_history              WIRED (partial) — reads `RolloutItem[]`
 *                             from the live store's `readAll()` (or
 *                             the rollout file directly for non-live
 *                             threads). `includeArchived` is honoured
 *                             against the registry.
 *   update_thread_metadata    WIRED (partial) — persists `name` and
 *                             `memoryMode` to the registry and appends
 *                             a fresh `session_meta` rollout row with
 *                             the new mode, matching upstream's
 *                             append-not-rewrite behavior. Name
 *                             updates go to the registry; no rollout
 *                             row is appended.
 *   archive_thread            WIRED — sets `archivedAt` in the
 *                             registry. Non-live rollouts move under
 *                             `archived_sessions/`; live rollouts keep
 *                             their current path until shutdown so the
 *                             open writer never recreates the active
 *                             file behind the store.
 *   unarchive_thread          WIRED — clears `archivedAt`.
 *   list_threads              WIRED (partial) — returns entries sorted
 *                             by the registry timestamps, honouring
 *                             `archived`. Cursor paging, cwd filters,
 *                             search terms, and allowed-sources
 *                             filtering are NOT ported; they are listed
 *                             in `ListThreadsParams` for signature
 *                             parity but ignored by `FileThreadStore`.
 *   read_thread               WIRED (partial) — returns registry
 *                             metadata and, when requested, rollout
 *                             history from live or non-live files.
 *                             Upstream's SQLite-derived preview,
 *                             token totals, and git metadata remain
 *                             deferred.
 *
 * @module
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThreadId } from "../agents/registry.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type RolloutItem,
} from "./rollout-item.js";
import type { RolloutStore } from "./rollout-store.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type SessionMetaLine,
} from "./event-log.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
} from "./session-store.js";

// ─────────────────────────────────────────────────────────────────────
// Params + types — mirrored from AgenC runtime `thread-store/src/types.rs`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Thread memory mode. Mirrors upstream
 * `ThreadMemoryMode` (`protocol/src/protocol.rs:811`). Serialized to
 * the registry as the lowercase string form, matching upstream's
 * `#[serde(rename_all = "lowercase")]`.
 */
export type ThreadMemoryMode = "enabled" | "disabled";

/**
 * Controls how many event variants should be persisted for future
 * replay. Mirrors upstream `ThreadEventPersistenceMode`
 * (`thread-store/src/types.rs:21`). Currently unused by gut's
 * `FileThreadStore` (kept for signature parity) because gut has a
 * single event-persistence policy.
 */
export type ThreadEventPersistenceMode = "limited" | "extended";

/** Runtime source for the thread. Free-form string; upstream uses an
 *  enum (`SessionSource`) but gut has no runtime consumer yet. */
export type ThreadSource = string;

/** Mirror of upstream `CreateThreadParams` (`types.rs:31`). */
export interface CreateThreadParams {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  readonly source?: ThreadSource;
  readonly eventPersistenceMode?: ThreadEventPersistenceMode;
  readonly cwd?: string;
  /**
   * The already-opened `RolloutStore` this thread will append into.
   * The upstream `LocalThreadStore` opens its own `RolloutRecorder`
   * from `CreateThreadParams + RolloutConfig`; gut keeps the
   * `RolloutStore` lifecycle with `Session`, so the caller must pass
   * an opened store in.
   */
  readonly rolloutStore: RolloutStore;
}

/** Mirror of upstream `ResumeThreadParams` (`types.rs:48`). */
export interface ResumeThreadParams {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly history?: ReadonlyArray<RolloutItem>;
  readonly includeArchived?: boolean;
  readonly eventPersistenceMode?: ThreadEventPersistenceMode;
  readonly rolloutStore: RolloutStore;
}

/** Mirror of upstream `AppendThreadItemsParams` (`types.rs:63`). */
export interface AppendThreadItemsParams {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<RolloutItem>;
}

/** Mirror of upstream `LoadThreadHistoryParams` (`types.rs:72`). */
export interface LoadThreadHistoryParams {
  readonly threadId: ThreadId;
  readonly includeArchived: boolean;
}

/** Mirror of upstream `StoredThreadHistory` (`types.rs:81`). */
export interface StoredThreadHistory {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<RolloutItem>;
}

/** Mirror of upstream `ReadThreadParams` (`types.rs:90`). */
export interface ReadThreadParams {
  readonly threadId: ThreadId;
  readonly includeArchived: boolean;
  readonly includeHistory: boolean;
}

/** Mirror of upstream `ThreadSortKey` (`types.rs:101`). */
export type ThreadSortKey = "created_at" | "updated_at";

/** Mirror of upstream `SortDirection` (`types.rs:111`). */
export type SortDirection = "asc" | "desc";

/** Mirror of upstream `ListThreadsParams` (`types.rs:121`). The
 *  filter/paging fields marked "(deferred)" below are accepted for
 *  signature parity but ignored by `FileThreadStore`. */
export interface ListThreadsParams {
  readonly pageSize: number;
  readonly cursor?: string; // (deferred)
  readonly sortKey?: ThreadSortKey;
  readonly sortDirection?: SortDirection;
  readonly allowedSources?: ReadonlyArray<ThreadSource>; // (deferred)
  readonly modelProviders?: ReadonlyArray<string>; // (deferred)
  readonly cwdFilters?: ReadonlyArray<string>; // (deferred)
  readonly archived: boolean;
  readonly searchTerm?: string; // (deferred)
  readonly useStateDbOnly?: boolean; // (deferred)
}

/** Mirror of upstream `StoredThread` (`types.rs:157`), narrowed to the
 *  fields gut actually persists in the registry. Fields upstream
 *  reconstructs from a `AgenC runtime-state` SQLite row (token usage,
 *  reasoning effort, approval mode, sandbox policy, git info, full
 *  preview, cli version) are not populated. */
export interface StoredThread {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly forkedFromId?: ThreadId;
  readonly name?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
  readonly archivedAt?: string; // ISO-8601 when archived
  readonly cwd?: string;
  readonly source?: ThreadSource;
  readonly history?: StoredThreadHistory;
}

/** Mirror of upstream `ThreadPage` (`types.rs:148`). */
export interface ThreadPage {
  readonly items: ReadonlyArray<StoredThread>;
  /** Always `undefined` in `FileThreadStore` (cursor paging deferred). */
  readonly nextCursor?: string;
}

/** Mirror of upstream `OptionalStringPatch` (`types.rs:207`). */
export type OptionalStringPatch = string | null | undefined;

/** Mirror of upstream `GitInfoPatch` (`types.rs:211`). Accepted for
 *  signature parity; `FileThreadStore.updateThreadMetadata` does NOT
 *  persist git info (matches upstream's documented behaviour that the
 *  local store rejects git-info patches). */
export interface GitInfoPatch {
  readonly sha?: OptionalStringPatch;
  readonly branch?: OptionalStringPatch;
  readonly originUrl?: OptionalStringPatch;
}

/** Mirror of upstream `ThreadMetadataPatch` (`types.rs:222`). */
export interface ThreadMetadataPatch {
  readonly name?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly gitInfo?: GitInfoPatch;
}

/** Mirror of upstream `UpdateThreadMetadataParams` (`types.rs:233`). */
export interface UpdateThreadMetadataParams {
  readonly threadId: ThreadId;
  readonly patch: ThreadMetadataPatch;
  readonly includeArchived: boolean;
}

/** Mirror of upstream `ArchiveThreadParams` (`types.rs:244`). */
export interface ArchiveThreadParams {
  readonly threadId: ThreadId;
}

// ─────────────────────────────────────────────────────────────────────
// Error types — mirror of upstream `thread-store/src/error.rs`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a requested thread does not exist in the store.
 * Upstream: `ThreadStoreError::ThreadNotFound`.
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
 * Upstream: `ThreadStoreError::InvalidRequest`.
 */
export class ThreadStoreInvalidRequestError extends Error {
  constructor(message: string) {
    super(`invalid thread-store request: ${message}`);
    this.name = "ThreadStoreInvalidRequestError";
  }
}

/**
 * Error thrown on state conflicts.
 * Upstream: `ThreadStoreError::Conflict`.
 */
export class ThreadStoreConflictError extends Error {
  constructor(message: string) {
    super(`thread-store conflict: ${message}`);
    this.name = "ThreadStoreConflictError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// ThreadStore interface — upstream `trait ThreadStore`.
// ─────────────────────────────────────────────────────────────────────

/**
 * Storage-neutral thread persistence boundary.
 *
 * Matches the upstream `ThreadStore` trait
 * (`AgenC runtime-rs/thread-store/src/store.rs:20`) method for method. Method
 * names are lower-camel-cased per `docs/plan/translation-conventions.md`;
 * parameter shapes match upstream.
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
  listThreads(params: ListThreadsParams): ThreadPage;
  updateThreadMetadata(params: UpdateThreadMetadataParams): StoredThread;
  archiveThread(params: ArchiveThreadParams): void;
  unarchiveThread(params: ArchiveThreadParams): StoredThread;
}

// ─────────────────────────────────────────────────────────────────────
// FileThreadStore — default filesystem-backed implementation.
// ─────────────────────────────────────────────────────────────────────

interface RegistryEntry {
  readonly threadId: ThreadId;
  readonly name?: string;
  readonly memoryMode?: ThreadMemoryMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly cwd?: string;
  readonly source?: ThreadSource;
  readonly forkedFromId?: ThreadId;
  readonly rolloutPath?: string;
  readonly archivedRolloutPath?: string;
}

interface RegistrySnapshot {
  readonly version: number;
  readonly threads: ReadonlyArray<RegistryEntry>;
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILENAME = "threads.json";

export interface FileThreadStoreOpts {
  /**
   * The cwd used to resolve the per-project registry path
   * (`getProjectDir(cwd, projectRootMarkers) / threads.json`). Defaults
   * to `process.cwd()` if omitted.
   */
  readonly cwd?: string;
  /**
   * Optional project-root markers, matching `RolloutStore`/`SessionStore`.
   */
  readonly projectRootMarkers?: readonly string[];
}

/**
 * Default filesystem-backed `ThreadStore`. Tracks live thread writers
 * (via the caller-supplied `RolloutStore` per thread) in memory, and
 * persists a sidecar registry at
 * `~/.agenc/projects/<slug>/threads.json` with one entry per known
 * thread id.
 *
 * Wire-format deviations from upstream:
 *   - No `AgenC runtime-state` SQLite db: metadata lives in the JSON registry.
 *   - Live archives defer the `archived_sessions/` move until the writer is
 *     no longer registered, preserving the open `RolloutStore` path.
 *   - No on-disk `ThreadNameUpdated` rows: name updates only rewrite the
 *     registry. Memory-mode updates append a new `session_meta` row.
 */
export class FileThreadStore implements ThreadStore {
  private readonly registryPath: string;
  private readonly projectDir: string;
  private readonly archivedSessionsDir: string;
  private readonly liveRecorders = new Map<ThreadId, RolloutStore>();

  constructor(opts: FileThreadStoreOpts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const markers = opts.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS;
    const projectDir = getProjectDir(cwd, markers);
    this.projectDir = projectDir;
    this.registryPath = join(projectDir, REGISTRY_FILENAME);
    this.archivedSessionsDir = join(projectDir, "archived_sessions");
  }

  /** The sidecar registry path used by this store. Exposed for tests. */
  get registryFilePath(): string {
    return this.registryPath;
  }

  // ── ThreadStore trait implementation ────────────────────────────────

  createThread(params: CreateThreadParams): void {
    const threadId = params.threadId;
    if (this.liveRecorders.has(threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${threadId} already has a live local writer`,
      );
    }
    this.liveRecorders.set(threadId, params.rolloutStore);

    const registry = this.readRegistry();
    const now = new Date().toISOString();
    const existing = registry.get(threadId);
    const entry: RegistryEntry = {
      threadId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.name !== undefined ? { name: existing.name } : {}),
      ...(existing?.memoryMode !== undefined
        ? { memoryMode: existing.memoryMode }
        : {}),
      ...(existing?.archivedAt !== undefined
        ? { archivedAt: existing.archivedAt }
        : {}),
      ...(params.cwd !== undefined
        ? { cwd: params.cwd }
        : existing?.cwd !== undefined
          ? { cwd: existing.cwd }
          : {}),
      ...(params.source !== undefined
        ? { source: params.source }
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
      rolloutPath: params.rolloutStore.rolloutPath,
    };
    registry.set(threadId, entry);
    this.writeRegistry(registry);
  }

  resumeThread(params: ResumeThreadParams): void {
    const threadId = params.threadId;
    if (this.liveRecorders.has(threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${threadId} already has a live local writer`,
      );
    }
    const registry = this.readRegistry();
    const existing = registry.get(threadId);
    if (
      existing?.archivedAt !== undefined &&
      params.includeArchived !== true
    ) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${threadId} is archived; pass includeArchived=true to resume`,
      );
    }

    this.liveRecorders.set(threadId, params.rolloutStore);

    const now = new Date().toISOString();
    const entry: RegistryEntry = {
      threadId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.name !== undefined ? { name: existing.name } : {}),
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
      rolloutPath:
        params.rolloutPath ??
        existing?.rolloutPath ??
        params.rolloutStore.rolloutPath,
    };
    registry.set(threadId, entry);
    this.writeRegistry(registry);
  }

  appendItems(params: AppendThreadItemsParams): void {
    const recorder = this.liveRecorderOrThrow(params.threadId);
    for (const item of params.items) {
      recorder.appendRollout(item);
    }
  }

  persistThread(threadId: ThreadId): void {
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
  }

  flushThread(threadId: ThreadId): void {
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
  }

  shutdownThread(threadId: ThreadId): void {
    const recorder = this.liveRecorderOrThrow(threadId);
    recorder.flushDurable();
    this.liveRecorders.delete(threadId);
  }

  discardThread(threadId: ThreadId): void {
    // Upstream drops the live entry without flushing. Matches that
    // contract here: we do NOT call flushDurable.
    if (!this.liveRecorders.has(threadId)) {
      throw new ThreadNotFoundError(threadId);
    }
    this.liveRecorders.delete(threadId);
  }

  loadHistory(params: LoadThreadHistoryParams): StoredThreadHistory {
    const registry = this.readRegistry();
    const entry = registry.get(params.threadId);
    if (
      entry?.archivedAt !== undefined &&
      params.includeArchived !== true
    ) {
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
    return {
      threadId: params.threadId,
      items: this.readRolloutItems(rolloutPath),
    };
  }

  readThread(params: ReadThreadParams): StoredThread {
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
    return toStoredThread(entry, history);
  }

  listThreads(params: ListThreadsParams): ThreadPage {
    const registry = this.readRegistry();
    const wantArchived = params.archived;
    const entries = Array.from(registry.values()).filter((e) => {
      const isArchived = e.archivedAt !== undefined;
      return wantArchived ? isArchived : !isArchived;
    });
    const sortKey: ThreadSortKey = params.sortKey ?? "created_at";
    const sortDir: SortDirection = params.sortDirection ?? "desc";
    entries.sort((a, b) => {
      const aKey = sortKey === "created_at" ? a.createdAt : a.updatedAt;
      const bKey = sortKey === "created_at" ? b.createdAt : b.updatedAt;
      const cmp = aKey.localeCompare(bKey);
      return sortDir === "asc" ? cmp : -cmp;
    });
    const pageSize = Math.max(0, params.pageSize);
    const sliced = pageSize > 0 ? entries.slice(0, pageSize) : entries;
    return {
      items: sliced.map((e) => toStoredThread(e)),
    };
  }

  updateThreadMetadata(
    params: UpdateThreadMetadataParams,
  ): StoredThread {
    if (params.patch.gitInfo !== undefined) {
      // Match upstream behaviour: the local store rejects git-info
      // patches in this slice (`local/update_thread_metadata.rs:33`).
      throw new ThreadStoreInvalidRequestError(
        "FileThreadStore does not implement git metadata updates",
      );
    }
    if (
      params.patch.name !== undefined &&
      params.patch.memoryMode !== undefined
    ) {
      // Match upstream behaviour: one field per patch
      // (`local/update_thread_metadata.rs:39`).
      throw new ThreadStoreInvalidRequestError(
        "FileThreadStore applies one metadata field per patch",
      );
    }
    const registry = this.readRegistry();
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
    }
    registry.set(params.threadId, updated);
    this.writeRegistry(registry);
    return toStoredThread(updated);
  }

  archiveThread(params: ArchiveThreadParams): void {
    const registry = this.readRegistry();
    const existing = registry.get(params.threadId);
    if (existing === undefined) {
      throw new ThreadNotFoundError(params.threadId);
    }
    if (existing.archivedAt !== undefined) {
      return; // already archived
    }
    const now = new Date().toISOString();
    const archivedRolloutPath = this.liveRecorders.has(params.threadId)
      ? existing.archivedRolloutPath
      : this.archiveRolloutFile(existing);
    registry.set(params.threadId, {
      ...existing,
      updatedAt: now,
      archivedAt: now,
      ...(archivedRolloutPath !== undefined ? { archivedRolloutPath } : {}),
    });
    this.writeRegistry(registry);
  }

  unarchiveThread(params: ArchiveThreadParams): StoredThread {
    const registry = this.readRegistry();
    const existing = registry.get(params.threadId);
    if (existing === undefined) {
      throw new ThreadNotFoundError(params.threadId);
    }
    const now = new Date().toISOString();
    const restoredRolloutPath = this.liveRecorders.has(params.threadId)
      ? existing.rolloutPath
      : this.unarchiveRolloutFile(existing);
    const {
      archivedAt: _drop,
      archivedRolloutPath: _archivedRolloutPath,
      ...rest
    } = existing;
    void _drop;
    void _archivedRolloutPath;
    const updated: RegistryEntry = {
      ...rest,
      updatedAt: now,
      ...(restoredRolloutPath !== undefined
        ? { rolloutPath: restoredRolloutPath }
        : {}),
    };
    registry.set(params.threadId, updated);
    this.writeRegistry(registry);
    return toStoredThread(updated);
  }

  // ── internal helpers ────────────────────────────────────────────────

  private readableRolloutPath(entry: RegistryEntry): string | undefined {
    return entry.archivedRolloutPath ?? entry.rolloutPath;
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
      const parsed = parseRolloutLine(line);
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

  private archiveRolloutFile(entry: RegistryEntry): string | undefined {
    if (entry.rolloutPath === undefined || !existsSync(entry.rolloutPath)) {
      return entry.archivedRolloutPath;
    }
    const targetDir = join(this.archivedSessionsDir, entry.threadId);
    mkdirSync(targetDir, { recursive: true });
    let targetPath = join(targetDir, basename(entry.rolloutPath));
    if (existsSync(targetPath) && targetPath !== entry.rolloutPath) {
      targetPath = join(
        targetDir,
        `${Date.now()}-${basename(entry.rolloutPath)}`,
      );
    }
    renameSync(entry.rolloutPath, targetPath);
    return targetPath;
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
    renameSync(archivedPath, restoredPath);
    return restoredPath;
  }

  private liveRecorderOrThrow(threadId: ThreadId): RolloutStore {
    const recorder = this.liveRecorders.get(threadId);
    if (recorder === undefined) {
      throw new ThreadNotFoundError(threadId);
    }
    return recorder;
  }

  private readRegistry(): Map<ThreadId, RegistryEntry> {
    if (!existsSync(this.registryPath)) {
      return new Map();
    }
    const raw = readFileSync(this.registryPath, "utf8");
    if (raw.trim().length === 0) return new Map();
    const parsed = JSON.parse(raw) as RegistrySnapshot;
    if (
      parsed.version !== REGISTRY_VERSION ||
      !Array.isArray(parsed.threads)
    ) {
      throw new Error(
        `invalid thread-store registry at ${this.registryPath}`,
      );
    }
    const result = new Map<ThreadId, RegistryEntry>();
    for (const entry of parsed.threads) {
      if (typeof entry.threadId !== "string") {
        continue;
      }
      result.set(entry.threadId, entry);
    }
    return result;
  }

  private writeRegistry(registry: Map<ThreadId, RegistryEntry>): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const snapshot: RegistrySnapshot = {
      version: REGISTRY_VERSION,
      threads: Array.from(registry.values()),
    };
    writeFileSync(
      this.registryPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
  }
}

function toStoredThread(
  entry: RegistryEntry,
  history?: StoredThreadHistory,
): StoredThread {
  return {
    threadId: entry.threadId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.archivedRolloutPath !== undefined
      ? { rolloutPath: entry.archivedRolloutPath }
      : entry.rolloutPath !== undefined
        ? { rolloutPath: entry.rolloutPath }
        : {}),
    ...(entry.forkedFromId !== undefined
      ? { forkedFromId: entry.forkedFromId }
      : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
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
  return {
    sessionId: entry.threadId,
    timestamp: entry.updatedAt,
    cwd: entry.cwd ?? process.cwd(),
    originator: entry.source ?? "thread-store",
    agencVersion: "unknown",
    rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    ...(entry.source !== undefined ? { source: entry.source } : {}),
  };
}
