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

import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { join } from "node:path";
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
  ThreadStoreInvalidRequestError,
  ThreadNotFoundError,
} from "./store.js";

const BOUNDED_MULTI_PROJECT_CURSOR_PREFIX = "mp:bounded-v1:";

interface BoundedMultiProjectCursor {
  readonly projectDir: string;
  readonly scope: string;
  readonly threadCursor?: string;
}

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
  readonly #knownProjectDirs = new Set<string>();
  #sortedProjectDirs: readonly string[] | undefined;
  #projectIndexByDir: ReadonlyMap<string, number> | undefined;
  #projectsDirectoryMtimeMs: number | null | undefined;

  constructor(opts: MultiProjectFileThreadStoreOpts) {
    this.#agencHome = opts.agencHome;
    this.#primaryCwd = opts.primaryCwd;
    this.#defaultModelProviderId = opts.defaultModelProviderId;
    this.#primary = this.#openForCwd(opts.primaryCwd);
    // Pay the one-time project-directory discovery cost at daemon/store
    // construction. Steady-state session.list calls only stat the parent
    // directory and page the cached project order.
    this.#refreshDiscoveredProjectDirs(true);
    this.#ensureProjectOrder();
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
    if (isBoundedStateDbListing(params)) {
      return this.#listThreadsBounded(params);
    }
    if (params.cursor?.startsWith(BOUNDED_MULTI_PROJECT_CURSOR_PREFIX)) {
      throw new ThreadStoreInvalidRequestError(
        "bounded multi-project cursor cannot be used with filtered listing",
      );
    }
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

  countThreads(params: {
    readonly archived: boolean;
    readonly excludeThreadIds?: ReadonlySet<string>;
  }): number {
    let count = 0;
    for (const projectDir of this.#boundedProjectDirs()) {
      count += this.#openForProjectDir(projectDir).countThreads(params);
    }
    return count;
  }

  /**
   * Page across project databases without opening and draining every project
   * store. Session-list ordering is deterministic (primary project first,
   * then project directory) and the cursor carries the active project's own
   * thread cursor. At most `pageSize` project databases are visited per call,
   * so an empty-history fan-out is bounded too.
   */
  #listThreadsBounded(params: ListThreadsParams): ThreadPage {
    const pageSize = Math.min(Math.max(params.pageSize, 1), 500);
    const scope = boundedMultiProjectScope(params);
    const cursor = parseBoundedMultiProjectCursor(params.cursor, scope);
    const projectDirs = this.#boundedProjectDirs();
    if (projectDirs.length === 0) return { items: [] };

    let projectIndex = 0;
    let threadCursor = cursor?.threadCursor;
    if (cursor !== undefined) {
      projectIndex = this.#projectIndexByDir?.get(cursor.projectDir) ?? -1;
      if (projectIndex < 0 || projectDirs[projectIndex] !== cursor.projectDir) {
        throw new ThreadStoreInvalidRequestError(
          "multi-project list cursor references an unavailable project",
        );
      }
    }

    const items: StoredThread[] = [];
    let projectsVisited = 0;
    while (
      projectIndex < projectDirs.length &&
      items.length < pageSize &&
      projectsVisited < pageSize
    ) {
      const projectDir = projectDirs[projectIndex]!;
      const store = this.#openForProjectDir(projectDir);
      const page = store.listThreads({
        pageSize: pageSize - items.length,
        archived: params.archived,
        useStateDbOnly: true,
        ...(params.sortKey !== undefined ? { sortKey: params.sortKey } : {}),
        ...(params.sortDirection !== undefined
          ? { sortDirection: params.sortDirection }
          : {}),
        ...(threadCursor !== undefined ? { cursor: threadCursor } : {}),
      });
      items.push(...page.items);
      projectsVisited += 1;

      if (page.nextCursor !== undefined) {
        return {
          items,
          nextCursor: formatBoundedMultiProjectCursor({
            projectDir,
            scope,
            threadCursor: page.nextCursor,
          }),
        };
      }

      projectIndex += 1;
      threadCursor = undefined;
    }

    return {
      items,
      ...(projectIndex < projectDirs.length
        ? {
            nextCursor: formatBoundedMultiProjectCursor({
              projectDir: projectDirs[projectIndex]!,
              scope,
            }),
          }
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
    this.#refreshDiscoveredProjectDirs();
    for (const projectDir of this.#knownProjectDirs) {
      this.#openForProjectDir(projectDir);
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
    this.#rememberProjectDir(projectDir);
    return store;
  }

  #openForProjectDir(projectDir: string): FileThreadStore {
    const existing = this.#byProjectDir.get(projectDir);
    if (existing !== undefined) return existing;
    const store = new FileThreadStore({
      projectDir,
      agencHome: this.#agencHome,
      ...(this.#defaultModelProviderId !== undefined
        ? { defaultModelProviderId: this.#defaultModelProviderId }
        : {}),
    });
    this.#byProjectDir.set(projectDir, store);
    this.#rememberProjectDir(projectDir);
    return store;
  }

  #boundedProjectDirs(): readonly string[] {
    this.#refreshDiscoveredProjectDirs();
    this.#ensureProjectOrder();
    return this.#sortedProjectDirs!;
  }

  #rememberProjectDir(projectDir: string): void {
    if (this.#knownProjectDirs.has(projectDir)) return;
    this.#knownProjectDirs.add(projectDir);
    this.#sortedProjectDirs = undefined;
    this.#projectIndexByDir = undefined;
  }

  #refreshDiscoveredProjectDirs(force = false): void {
    const projectsDir = join(this.#agencHome, "projects");
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(projectsDir).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mtimeMs = null;
    }
    if (!force && this.#projectsDirectoryMtimeMs === mtimeMs) return;
    for (const paths of discoverStateDatabasePaths(this.#agencHome)) {
      this.#rememberProjectDir(paths.projectDir);
    }
    this.#projectsDirectoryMtimeMs = mtimeMs;
  }

  #ensureProjectOrder(): void {
    if (
      this.#sortedProjectDirs !== undefined &&
      this.#projectIndexByDir !== undefined
    ) {
      return;
    }
    const primaryDir = this.#primary.getProjectDir();
    this.#rememberProjectDir(primaryDir);
    const sorted = [...this.#knownProjectDirs].sort((a, b) => {
      if (a === primaryDir) return -1;
      if (b === primaryDir) return 1;
      return a.localeCompare(b);
    });
    this.#sortedProjectDirs = sorted;
    this.#projectIndexByDir = new Map(
      sorted.map((projectDir, index) => [projectDir, index]),
    );
  }
}

function isBoundedStateDbListing(params: ListThreadsParams): boolean {
  return (
    params.useStateDbOnly === true &&
    params.allowedSources === undefined &&
    params.modelProviders === undefined &&
    params.cwdFilters === undefined &&
    params.searchTerm === undefined &&
    (params.cursor === undefined ||
      params.cursor.startsWith(BOUNDED_MULTI_PROJECT_CURSOR_PREFIX))
  );
}

function parseBoundedMultiProjectCursor(
  cursor: string | undefined,
  expectedScope: string,
): BoundedMultiProjectCursor | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(BOUNDED_MULTI_PROJECT_CURSOR_PREFIX)) {
    throw new ThreadStoreInvalidRequestError(
      "invalid bounded multi-project list cursor",
    );
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(
        cursor.slice(BOUNDED_MULTI_PROJECT_CURSOR_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as {
      readonly v?: unknown;
      readonly projectDir?: unknown;
      readonly scope?: unknown;
      readonly threadCursor?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.projectDir !== "string" ||
      parsed.projectDir.length === 0 ||
      parsed.scope !== expectedScope ||
      (parsed.threadCursor !== undefined &&
        typeof parsed.threadCursor !== "string")
    ) {
      throw new Error("invalid cursor shape");
    }
    return {
      projectDir: parsed.projectDir,
      scope: expectedScope,
      ...(typeof parsed.threadCursor === "string"
        ? { threadCursor: parsed.threadCursor }
        : {}),
    };
  } catch (error) {
    if (error instanceof ThreadStoreInvalidRequestError) throw error;
    throw new ThreadStoreInvalidRequestError(
      `invalid bounded multi-project list cursor: ${String(error)}`,
    );
  }
}

function formatBoundedMultiProjectCursor(
  cursor: BoundedMultiProjectCursor,
): string {
  return `${BOUNDED_MULTI_PROJECT_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      projectDir: cursor.projectDir,
      scope: cursor.scope,
      ...(cursor.threadCursor !== undefined
        ? { threadCursor: cursor.threadCursor }
        : {}),
    }),
    "utf8",
  ).toString("base64url")}`;
}

function boundedMultiProjectScope(params: ListThreadsParams): string {
  return JSON.stringify({
    archived: params.archived,
    sortKey: params.sortKey ?? "created_at",
    sortDirection: params.sortDirection ?? "desc",
    useStateDbOnly: true,
  });
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
