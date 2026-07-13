/**
 * DAE-03: ThreadStore facade that unions list/read across every project
 * under AGENC_HOME/projects (plus the daemon start cwd project).
 *
 * Write-ish operations (create/resume/append/…) still target the primary
 * store for the daemon-start cwd so existing writers keep a stable home;
 * multi-project agents already use per-cwd RolloutStore paths for live
 * sessions. The main bug was session.list / attach discovery only seeing
 * one project's registry.
 */

import type { ThreadId } from "../agents/registry.js";
import { discoverStateDatabasePaths } from "../state/sqlite-driver.js";
import {
  FileThreadStore,
  type AppendThreadItemsParams,
  type ArchiveThreadParams,
  type CreateThreadParams,
  type ListThreadsParams,
  type LoadThreadHistoryParams,
  type ReadThreadByRolloutPathParams,
  type ReadThreadParams,
  type ResumeThreadParams,
  type StoredThread,
  type ThreadPage,
  type ThreadStore,
  type UpdateThreadMetadataParams,
  ThreadNotFoundError,
} from "./store.js";

export interface MultiProjectFileThreadStoreOpts {
  readonly primaryCwd: string;
  readonly agencHome: string;
  readonly defaultModelProviderId?: string;
}

export class MultiProjectFileThreadStore implements ThreadStore {
  readonly #agencHome: string;
  readonly #primaryCwd: string;
  readonly #defaultModelProviderId?: string;
  readonly #primary: FileThreadStore;
  readonly #byProjectDir = new Map<string, FileThreadStore>();

  constructor(opts: MultiProjectFileThreadStoreOpts) {
    this.#agencHome = opts.agencHome;
    this.#primaryCwd = opts.primaryCwd;
    this.#defaultModelProviderId = opts.defaultModelProviderId;
    this.#primary = this.#openForCwd(opts.primaryCwd);
  }

  createThread(params: CreateThreadParams): void {
    this.#storeForWrite(params.cwd).createThread(params);
  }

  resumeThread(params: ResumeThreadParams): void {
    this.#primary.resumeThread(params);
  }

  appendItems(params: AppendThreadItemsParams): void {
    this.#primary.appendItems(params);
  }

  persistThread(threadId: ThreadId): void {
    this.#primary.persistThread(threadId);
  }

  flushThread(threadId: ThreadId): void {
    this.#primary.flushThread(threadId);
  }

  shutdownThread(threadId: ThreadId): void {
    this.#primary.shutdownThread(threadId);
  }

  discardThread(threadId: ThreadId): void {
    this.#primary.discardThread(threadId);
  }

  loadHistory(params: LoadThreadHistoryParams) {
    return this.#storeHolding(params.threadId).loadHistory(params);
  }

  readThread(params: ReadThreadParams): StoredThread {
    return this.#storeHolding(params.threadId).readThread(params);
  }

  readThreadByRolloutPath(params: ReadThreadByRolloutPathParams): StoredThread {
    for (const store of this.#allStores()) {
      try {
        return store.readThreadByRolloutPath(params);
      } catch (error) {
        if (error instanceof ThreadNotFoundError) continue;
        throw error;
      }
    }
    throw new ThreadNotFoundError(`rollout:${params.rolloutPath}`);
  }

  listThreads(params: ListThreadsParams): ThreadPage {
    // Gather full filtered sets from each project, then re-sort/page.
    // Project counts are typically small; recovery already scans all DBs.
    const items: StoredThread[] = [];
    const seen = new Set<string>();
    for (const store of this.#allStores()) {
      let cursor: string | undefined;
      do {
        const page = store.listThreads({
          pageSize: 500,
          archived: params.archived,
          ...(params.useStateDbOnly !== undefined
            ? { useStateDbOnly: params.useStateDbOnly }
            : {}),
          ...(params.sortKey !== undefined ? { sortKey: params.sortKey } : {}),
          ...(params.sortDirection !== undefined
            ? { sortDirection: params.sortDirection }
            : {}),
          ...(params.searchTerm !== undefined
            ? { searchTerm: params.searchTerm }
            : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const item of page.items) {
          if (seen.has(item.threadId)) continue;
          seen.add(item.threadId);
          items.push(item);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    }

    const sortKey = params.sortKey ?? "created_at";
    const sortDir = params.sortDirection ?? "desc";
    items.sort((a, b) => {
      const aKey = sortKey === "created_at" ? a.createdAt : a.updatedAt;
      const bKey = sortKey === "created_at" ? b.createdAt : b.updatedAt;
      const cmp =
        aKey.localeCompare(bKey) || a.threadId.localeCompare(b.threadId);
      return sortDir === "asc" ? cmp : -cmp;
    });

    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 500);
    const offset = parseOuterOffset(params.cursor);
    const sliced = items.slice(offset, offset + pageSize);
    const nextOffset = offset + sliced.length;
    return {
      items: sliced,
      ...(nextOffset < items.length
        ? { nextCursor: `mp:${nextOffset}` }
        : {}),
    };
  }

  updateThreadMetadata(params: UpdateThreadMetadataParams): StoredThread {
    return this.#storeHolding(params.threadId).updateThreadMetadata(params);
  }

  archiveThread(params: ArchiveThreadParams): void {
    this.#storeHolding(params.threadId).archiveThread(params);
  }

  unarchiveThread(params: ArchiveThreadParams): StoredThread {
    return this.#storeHolding(params.threadId).unarchiveThread(params);
  }

  close(): void {
    for (const store of this.#byProjectDir.values()) {
      store.close();
    }
    this.#byProjectDir.clear();
  }

  #storeForWrite(cwd: string | undefined): FileThreadStore {
    if (cwd !== undefined && cwd.trim().length > 0) {
      return this.#openForCwd(cwd.trim());
    }
    return this.#primary;
  }

  #storeHolding(threadId: ThreadId): FileThreadStore {
    for (const store of this.#allStores()) {
      try {
        store.readThread({
          threadId,
          includeArchived: true,
          includeHistory: false,
        });
        return store;
      } catch (error) {
        if (error instanceof ThreadNotFoundError) continue;
        throw error;
      }
    }
    throw new ThreadNotFoundError(threadId);
  }

  #allStores(): FileThreadStore[] {
    this.#refreshDiscovered();
    const primaryDir = this.#primary.getProjectDir();
    return [...this.#byProjectDir.values()].sort((a, b) => {
      if (a.getProjectDir() === primaryDir) return -1;
      if (b.getProjectDir() === primaryDir) return 1;
      return a.getProjectDir().localeCompare(b.getProjectDir());
    });
  }

  #refreshDiscovered(): void {
    const discovered = discoverStateDatabasePaths(this.#agencHome);
    for (const paths of discovered) {
      if (this.#byProjectDir.has(paths.projectDir)) continue;
      this.#byProjectDir.set(
        paths.projectDir,
        new FileThreadStore({
          projectDir: paths.projectDir,
          agencHome: this.#agencHome,
          ...(this.#defaultModelProviderId !== undefined
            ? { defaultModelProviderId: this.#defaultModelProviderId }
            : {}),
        }),
      );
    }
    // Always keep primary cwd project present.
    this.#openForCwd(this.#primaryCwd);
  }

  #openForCwd(cwd: string): FileThreadStore {
    const store = new FileThreadStore({
      cwd,
      agencHome: this.#agencHome,
      ...(this.#defaultModelProviderId !== undefined
        ? { defaultModelProviderId: this.#defaultModelProviderId }
        : {}),
    });
    const projectDir = store.getProjectDir();
    const existing = this.#byProjectDir.get(projectDir);
    if (existing !== undefined) {
      store.close();
      return existing;
    }
    this.#byProjectDir.set(projectDir, store);
    return store;
  }
}

function parseOuterOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  if (cursor.startsWith("mp:")) {
    const n = Number(cursor.slice(3));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  // Unknown cursor shape: start from beginning (safe).
  return 0;
}
