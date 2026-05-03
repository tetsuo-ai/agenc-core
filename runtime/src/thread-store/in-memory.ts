import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ThreadId } from "../agents/registry.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type {
  AppendThreadItemsParams,
  ArchiveThreadParams,
  CreateThreadParams,
  ListThreadsParams,
  LoadThreadHistoryParams,
  ReadThreadByRolloutPathParams,
  ReadThreadParams,
  ResumeThreadParams,
  StoredThread,
  StoredThreadHistory,
  ThreadPage,
  ThreadSource,
  ThreadStore,
  UpdateThreadMetadataParams,
} from "./store.js";
import {
  ThreadNotFoundError,
  ThreadStoreInvalidRequestError,
} from "./store.js";

export interface InMemoryThreadStoreCallCounts {
  createThread: number;
  resumeThread: number;
  appendItems: number;
  persistThread: number;
  flushThread: number;
  shutdownThread: number;
  discardThread: number;
  loadHistory: number;
  readThread: number;
  readThreadByRolloutPath: number;
  listThreads: number;
  updateThreadMetadata: number;
  archiveThread: number;
  unarchiveThread: number;
}

interface InMemoryRecord {
  readonly thread: StoredThread;
  readonly archivedRolloutPath?: string;
}

export class InMemoryThreadStore implements ThreadStore {
  readonly callCounts: InMemoryThreadStoreCallCounts = {
    createThread: 0,
    resumeThread: 0,
    appendItems: 0,
    persistThread: 0,
    flushThread: 0,
    shutdownThread: 0,
    discardThread: 0,
    loadHistory: 0,
    readThread: 0,
    readThreadByRolloutPath: 0,
    listThreads: 0,
    updateThreadMetadata: 0,
    archiveThread: 0,
    unarchiveThread: 0,
  };

  private readonly records = new Map<ThreadId, InMemoryRecord>();
  private readonly histories = new Map<ThreadId, RolloutItem[]>();
  private readonly live = new Map<ThreadId, CreateThreadParams["rolloutStore"]>();
  private closed = false;

  constructor(private readonly defaultModelProviderId = "unknown") {}

  createThread(params: CreateThreadParams): void {
    this.assertOpen();
    this.callCounts.createThread += 1;
    if (this.live.has(params.threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${params.threadId} already has a live local writer`,
      );
    }
    this.live.set(params.threadId, params.rolloutStore);
    const now = new Date().toISOString();
    const existing = this.records.get(params.threadId)?.thread;
    this.records.set(params.threadId, {
      thread: {
        threadId: params.threadId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        modelProvider:
          params.modelProvider ??
          existing?.modelProvider ??
          this.defaultModelProviderId,
        rolloutPath: params.rolloutStore.rolloutPath,
        ...(existing?.name !== undefined ? { name: existing.name } : {}),
        ...(params.model !== undefined
          ? { model: params.model }
          : existing?.model !== undefined
            ? { model: existing.model }
            : {}),
        ...(existing?.memoryMode !== undefined
          ? { memoryMode: existing.memoryMode }
          : {}),
        ...(params.forkedFromId !== undefined
          ? { forkedFromId: params.forkedFromId }
          : existing?.forkedFromId !== undefined
            ? { forkedFromId: existing.forkedFromId }
            : {}),
        ...(params.cwd !== undefined
          ? { cwd: params.cwd }
          : existing?.cwd !== undefined
            ? { cwd: existing.cwd }
            : {}),
        ...(params.source !== undefined
          ? { source: cloneThreadSource(params.source) }
          : existing?.source !== undefined
            ? { source: existing.source }
            : {}),
      },
    });
  }

  resumeThread(params: ResumeThreadParams): void {
    this.assertOpen();
    this.callCounts.resumeThread += 1;
    const existing = this.records.get(params.threadId);
    if (existing?.thread.archivedAt !== undefined && !params.includeArchived) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${params.threadId} is archived; pass includeArchived=true to resume`,
      );
    }
    if (this.live.has(params.threadId)) {
      throw new ThreadStoreInvalidRequestError(
        `thread ${params.threadId} already has a live local writer`,
      );
    }
    this.live.set(params.threadId, params.rolloutStore);
    if (params.history !== undefined) {
      this.histories.set(params.threadId, [...params.history]);
    }
    const now = new Date().toISOString();
    this.records.set(params.threadId, {
      archivedRolloutPath: existing?.archivedRolloutPath,
      thread: {
        ...(existing?.thread ?? {
          threadId: params.threadId,
          createdAt: now,
          updatedAt: now,
          modelProvider: this.defaultModelProviderId,
        }),
        updatedAt: now,
        modelProvider:
          params.modelProvider ??
          existing?.thread.modelProvider ??
          this.defaultModelProviderId,
        rolloutPath: params.rolloutPath ?? params.rolloutStore.rolloutPath,
        ...(params.model !== undefined
          ? { model: params.model }
          : existing?.thread.model !== undefined
            ? { model: existing.thread.model }
            : {}),
      },
    });
  }

  appendItems(params: AppendThreadItemsParams): void {
    this.assertOpen();
    this.callCounts.appendItems += 1;
    const rolloutStore = this.live.get(params.threadId);
    if (rolloutStore === undefined) throw new ThreadNotFoundError(params.threadId);
    const history = this.histories.get(params.threadId) ?? [];
    history.push(...params.items);
    this.histories.set(params.threadId, history);
    for (const item of params.items) {
      rolloutStore.appendRollout(item);
    }
    rolloutStore.flushDurable();
    this.touch(params.threadId);
  }

  persistThread(threadId: ThreadId): void {
    this.assertOpen();
    this.callCounts.persistThread += 1;
    this.liveOrThrow(threadId).flushDurable();
  }

  flushThread(threadId: ThreadId): void {
    this.assertOpen();
    this.callCounts.flushThread += 1;
    this.liveOrThrow(threadId).flushDurable();
  }

  shutdownThread(threadId: ThreadId): void {
    this.assertOpen();
    this.callCounts.shutdownThread += 1;
    this.liveOrThrow(threadId).flushDurable();
    this.live.delete(threadId);
  }

  discardThread(threadId: ThreadId): void {
    this.assertOpen();
    this.callCounts.discardThread += 1;
    if (!this.live.delete(threadId)) throw new ThreadNotFoundError(threadId);
  }

  loadHistory(params: LoadThreadHistoryParams): StoredThreadHistory {
    this.assertOpen();
    this.callCounts.loadHistory += 1;
    const record = this.recordOrThrow(params.threadId, params.includeArchived);
    return {
      threadId: record.thread.threadId,
      items: [...(this.histories.get(params.threadId) ?? [])],
    };
  }

  readThread(params: ReadThreadParams): StoredThread {
    this.assertOpen();
    this.callCounts.readThread += 1;
    const record = this.recordOrThrow(params.threadId, params.includeArchived);
    return {
      ...record.thread,
      ...(params.includeHistory
        ? {
            history: {
              threadId: params.threadId,
              items: [...(this.histories.get(params.threadId) ?? [])],
            },
          }
        : {}),
    };
  }

  readThreadByRolloutPath(params: ReadThreadByRolloutPathParams): StoredThread {
    this.assertOpen();
    this.callCounts.readThreadByRolloutPath += 1;
    const target = resolve(params.rolloutPath);
    for (const record of this.records.values()) {
      if (
        (record.thread.rolloutPath !== undefined &&
          resolve(record.thread.rolloutPath) === target) ||
        (record.archivedRolloutPath !== undefined &&
          resolve(record.archivedRolloutPath) === target)
      ) {
        return this.readThread({
          threadId: record.thread.threadId,
          includeArchived: params.includeArchived,
          includeHistory: params.includeHistory,
        });
      }
    }
    throw new ThreadStoreInvalidRequestError(
      `unknown rollout path: ${params.rolloutPath}`,
    );
  }

  listThreads(params: ListThreadsParams): ThreadPage {
    this.assertOpen();
    this.callCounts.listThreads += 1;
    const pageSize = validatePageSize(params.pageSize);
    const scopeHash = listScopeHash(params);
    const offset = parseCursor(params.cursor, scopeHash);
    const searchTerm = params.searchTerm?.trim().toLocaleLowerCase();
    const sorted = [...this.records.values()]
      .map((record) => record.thread)
      .filter((thread) => {
        const archived = thread.archivedAt !== undefined;
        return (
          (params.archived ? archived : !archived) &&
          matchesAllowedSource(thread, params.allowedSources) &&
          matchesModelProvider(thread, params.modelProviders) &&
          matchesCwd(thread, params.cwdFilters) &&
          matchesSearch(thread, this.histories.get(thread.threadId), searchTerm)
        );
      })
      .sort((a, b) => {
        const key = params.sortKey ?? "created_at";
        const dir = params.sortDirection ?? "desc";
        const aValue = key === "created_at" ? a.createdAt : a.updatedAt;
        const bValue = key === "created_at" ? b.createdAt : b.updatedAt;
        const cmp = aValue.localeCompare(bValue) || a.threadId.localeCompare(b.threadId);
        return dir === "asc" ? cmp : -cmp;
      });
    const items = sorted.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items: items.map((thread) => ({ ...thread })),
      ...(nextOffset < sorted.length
        ? { nextCursor: formatCursor(nextOffset, scopeHash) }
        : {}),
    };
  }

  updateThreadMetadata(params: UpdateThreadMetadataParams): StoredThread {
    this.assertOpen();
    this.callCounts.updateThreadMetadata += 1;
    if (params.patch.gitInfo !== undefined) {
      throw new ThreadStoreInvalidRequestError(
        "InMemoryThreadStore does not implement git metadata updates",
      );
    }
    if (
      params.patch.name !== undefined &&
      params.patch.memoryMode !== undefined
    ) {
      throw new ThreadStoreInvalidRequestError(
        "InMemoryThreadStore applies one metadata field per patch",
      );
    }
    const record = this.recordOrThrow(params.threadId, params.includeArchived);
    const updated: StoredThread = {
      ...record.thread,
      updatedAt: new Date().toISOString(),
      ...(params.patch.name !== undefined ? { name: params.patch.name } : {}),
      ...(params.patch.memoryMode !== undefined
        ? { memoryMode: params.patch.memoryMode }
        : {}),
    };
    this.records.set(params.threadId, {
      ...record,
      thread: updated,
    });
    return updated;
  }

  archiveThread(params: ArchiveThreadParams): void {
    this.assertOpen();
    this.callCounts.archiveThread += 1;
    const record = this.recordOrThrow(params.threadId, true);
    if (record.thread.archivedAt !== undefined) return;
    const now = new Date().toISOString();
    this.records.set(params.threadId, {
      archivedRolloutPath: record.archivedRolloutPath,
      thread: {
        ...record.thread,
        archivedAt: now,
        updatedAt: now,
      },
    });
  }

  unarchiveThread(params: ArchiveThreadParams): StoredThread {
    this.assertOpen();
    this.callCounts.unarchiveThread += 1;
    const record = this.recordOrThrow(params.threadId, true);
    const { archivedAt: _drop, ...active } = record.thread;
    void _drop;
    const updated: StoredThread = {
      ...active,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(params.threadId, {
      archivedRolloutPath: record.archivedRolloutPath,
      thread: updated,
    });
    return updated;
  }

  forId(threadId: ThreadId): StoredThread | undefined {
    return this.records.get(threadId)?.thread;
  }

  removeId(threadId: ThreadId): void {
    this.records.delete(threadId);
    this.histories.delete(threadId);
    this.live.delete(threadId);
  }

  close(): void {
    this.closed = true;
    this.live.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ThreadStoreInvalidRequestError("InMemoryThreadStore is closed");
    }
  }

  private liveOrThrow(threadId: ThreadId): CreateThreadParams["rolloutStore"] {
    const live = this.live.get(threadId);
    if (live === undefined) throw new ThreadNotFoundError(threadId);
    return live;
  }

  private recordOrThrow(
    threadId: ThreadId,
    includeArchived: boolean,
  ): InMemoryRecord {
    const record = this.records.get(threadId);
    if (record === undefined) throw new ThreadNotFoundError(threadId);
    if (record.thread.archivedAt !== undefined && !includeArchived) {
      throw new ThreadNotFoundError(threadId);
    }
    return record;
  }

  private touch(threadId: ThreadId): void {
    const record = this.records.get(threadId);
    if (record === undefined) return;
    this.records.set(threadId, {
      ...record,
      thread: {
        ...record.thread,
        updatedAt: new Date().toISOString(),
      },
    });
  }
}

function validatePageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new ThreadStoreInvalidRequestError(
      "pageSize must be an integer between 1 and 500",
    );
  }
  return pageSize;
}

function cloneThreadSource(source: ThreadSource): ThreadSource {
  if (typeof source === "string") return source;
  return cloneJsonObject(source);
}

function cloneJsonObject(
  source: Readonly<Record<string, unknown>>,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (seen.has(source)) {
    throw new ThreadStoreInvalidRequestError("thread source contains a cycle");
  }
  seen.add(source);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = cloneJsonValue(value, seen);
  }
  seen.delete(source);
  return result;
}

function cloneJsonValue(value: unknown, seen: WeakSet<object>): unknown {
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
      throw new ThreadStoreInvalidRequestError("thread source contains a cycle");
    }
    seen.add(value);
    const result = value.map((item) => cloneJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object" && value !== null) {
    return cloneJsonObject(value as Record<string, unknown>, seen);
  }
  throw new ThreadStoreInvalidRequestError(
    "thread source contains a non-JSON value",
  );
}

function listScopeHash(params: ListThreadsParams): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        archived: params.archived,
        sortKey: params.sortKey ?? "created_at",
        sortDirection: params.sortDirection ?? "desc",
        allowedSources: params.allowedSources?.map(cloneThreadSource) ?? [],
        modelProviders: params.modelProviders ?? [],
        cwdFilters: params.cwdFilters?.map((cwd) => resolve(cwd)),
        searchTerm: params.searchTerm?.trim().toLocaleLowerCase() || undefined,
        useStateDbOnly: params.useStateDbOnly === true,
      }),
    )
    .digest("hex");
}

function parseCursor(cursor: string | undefined, scopeHash: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      offset?: unknown;
      scopeHash?: unknown;
    };
    const offset = parsed.offset;
    if (
      parsed.v !== 1 ||
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      parsed.scopeHash !== scopeHash
    ) {
      throw new Error("cursor shape or scope mismatch");
    }
    return offset;
  } catch (cause) {
    throw new ThreadStoreInvalidRequestError(
      `invalid list cursor: ${String((cause as Error).message ?? cause)}`,
    );
  }
}

function formatCursor(offset: number, scopeHash: string): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, scopeHash }), "utf8").toString(
    "base64url",
  );
}

function matchesAllowedSource(
  thread: StoredThread,
  allowedSources: ReadonlyArray<ThreadSource> | undefined,
): boolean {
  if (allowedSources === undefined || allowedSources.length === 0) return true;
  if (thread.source === undefined) return false;
  const serialized = JSON.stringify(cloneThreadSource(thread.source));
  return allowedSources.some(
    (source) => JSON.stringify(cloneThreadSource(source)) === serialized,
  );
}

function matchesModelProvider(
  thread: StoredThread,
  providers: ReadonlyArray<string> | undefined,
): boolean {
  return providers === undefined || providers.length === 0
    ? true
    : providers.includes(thread.modelProvider);
}

function matchesCwd(
  thread: StoredThread,
  cwdFilters: ReadonlyArray<string> | undefined,
): boolean {
  if (cwdFilters === undefined) return true;
  if (cwdFilters.length === 0 || thread.cwd === undefined) return false;
  const cwd = resolve(thread.cwd);
  return cwdFilters.some((filter) => resolve(filter) === cwd);
}

function matchesSearch(
  thread: StoredThread,
  history: ReadonlyArray<RolloutItem> | undefined,
  searchTerm: string | undefined,
): boolean {
  if (searchTerm === undefined || searchTerm.length === 0) return true;
  if (thread.name?.toLocaleLowerCase().includes(searchTerm)) return true;
  for (const item of history ?? []) {
    if (item.type !== "response_item" || item.payload.role !== "user") continue;
    const text = responseText(item.payload.content).toLocaleLowerCase();
    return text.includes(searchTerm);
  }
  return false;
}

function responseText(
  content: string | ReadonlyArray<{ readonly text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join(" ");
}
