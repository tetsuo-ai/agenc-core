/**
 * ThreadStore — storage-neutral thread persistence boundary.
 *
 * Partial hand-port of upstream codex `thread-store/` crate
 * (`codex-rs/thread-store/src/store.rs` trait + `local/` default impl).
 * Upstream is a large subsystem with two back-ends (filesystem + remote
 * RPC), a SQLite `codex-state` metadata DB, paging/cursor listing, cwd
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
 *                             `memoryMode` to the registry. Upstream
 *                             additionally appends a
 *                             `ThreadNameUpdatedEvent` rollout row and
 *                             rewrites the `SessionMeta` row with the
 *                             new memory mode. Gut's `SessionMetaLine`
 *                             has no `memoryMode` field (see
 *                             `./event-log.ts:66`), so the memory mode
 *                             lives in the registry sidecar instead of
 *                             the rollout. Name updates go to the
 *                             registry; no rollout row is appended.
 *   archive_thread            WIRED (partial) — sets `archivedAt` in
 *                             the registry. Upstream moves the
 *                             rollout file to
 *                             `~/.agenc/<home>/archived_sessions/`;
 *                             gut does NOT move the file because the
 *                             `RolloutStore` session-dir resolver used
 *                             by the live writer does not understand
 *                             the archived dir. Flagged as a deviation.
 *   unarchive_thread          WIRED — clears `archivedAt`.
 *   list_threads              WIRED (partial) — returns entries sorted
 *                             by the registry timestamps, honouring
 *                             `archived`. Cursor paging, cwd filters,
 *                             search terms, and allowed-sources
 *                             filtering are NOT ported; they are listed
 *                             in `ListThreadsParams` for signature
 *                             parity but ignored by `FileThreadStore`.
 *   read_thread               RESERVED — upstream reconstructs the full
 *                             `StoredThread` by scanning the rollout
 *                             file's `SessionMeta` row, last observed
 *                             model, token usage, etc. Gut's
 *                             `SessionMetaLine` is missing several of
 *                             those fields, so a faithful port would
 *                             be misleading. The `readThread` method
 *                             on the store returns the registry entry
 *                             only.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ThreadId } from "../agents/registry.js";
import type { RolloutItem } from "./rollout-item.js";
import type { RolloutStore } from "./rollout-store.js";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
} from "./session-store.js";

// ─────────────────────────────────────────────────────────────────────
// Params + types — mirrored from codex `thread-store/src/types.rs`.
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
 *  reconstructs from a `codex-state` SQLite row (token usage,
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
 * (`codex-rs/thread-store/src/store.rs:20`) method for method. Method
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
 *   - No `codex-state` SQLite db: metadata lives in the JSON registry.
 *   - No `archived_sessions/` dir move on archive: `archivedAt` is a
 *     registry flag only. The rollout file stays in place.
 *   - No on-disk `ThreadNameUpdated` or `SessionMeta`-rewrite rows:
 *     `updateThreadMetadata` only rewrites the registry.
 */
export class FileThreadStore implements ThreadStore {
  private readonly registryPath: string;
  private readonly liveRecorders = new Map<ThreadId, RolloutStore>();

  constructor(opts: FileThreadStoreOpts = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const markers = opts.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS;
    const projectDir = getProjectDir(cwd, markers);
    this.registryPath = join(projectDir, REGISTRY_FILENAME);
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
    // Non-live thread: no way to read history without the
    // RolloutStore open (schema-version check + flock). We could
    // scan the file directly but that sidesteps the store's invariants.
    // Keep it simple: require the thread to be live. Upstream is able
    // to reopen because `RolloutRecorder::new(..., resume)` is cheap;
    // gut's `SessionStore.open()` grabs a flock.
    throw new ThreadStoreInvalidRequestError(
      `thread ${params.threadId} is not live; resume it before loading history`,
    );
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
    const history =
      params.includeHistory && this.liveRecorders.has(params.threadId)
        ? {
            threadId: params.threadId,
            items: this.liveRecorders.get(params.threadId)!.readAll(),
          }
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
    registry.set(params.threadId, {
      ...existing,
      updatedAt: now,
      archivedAt: now,
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
    const { archivedAt: _drop, ...rest } = existing;
    void _drop;
    const updated: RegistryEntry = {
      ...rest,
      updatedAt: now,
    };
    registry.set(params.threadId, updated);
    this.writeRegistry(registry);
    return toStoredThread(updated);
  }

  // ── internal helpers ────────────────────────────────────────────────

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
    ...(entry.rolloutPath !== undefined ? { rolloutPath: entry.rolloutPath } : {}),
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
