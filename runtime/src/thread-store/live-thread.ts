/** Handle for an active thread's persistence lifecycle. */

import type { ThreadId } from "../agents/registry.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { RolloutStore } from "../session/rollout-store.js";
import {
  ThreadStoreInvalidRequestError,
  type ThreadMemoryMode,
  type ThreadStore,
  type ThreadSource,
  type StoredThread,
  type StoredThreadHistory,
} from "./store.js";

/**
 * Params for creating a new `LiveThread`. A subset of
 * `CreateThreadParams` without the fields that have no consumer yet
 * (`baseInstructions`, `dynamicTools`). `eventPersistenceMode` is
 * accepted for signature stability but ignored by the default store.
 */
export interface CreateLiveThreadParams {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  /**
   * Existing `RolloutStore` the thread should append into. The caller is
   * expected to have already opened the store (`store.open(...)`).
   */
  readonly rolloutStore: RolloutStore;
  /**
   * Optional `ThreadStore` to register the live writer with. When
   * supplied, the factory calls `threadStore.createThread(...)` and
   * the RESERVED methods (`discard`, `loadHistory`, `updateMemoryMode`)
   * route through it. When omitted, the `LiveThread` still works for
   * append/flush/shutdown but the store-dependent methods throw.
   */
  readonly threadStore?: ThreadStore;
  /** Optional thread source label propagated to `ThreadStore.createThread`. */
  readonly source?: ThreadSource;
  readonly model?: string;
  readonly modelProvider?: string;
  /** Optional cwd propagated to `ThreadStore.createThread`. */
  readonly cwd?: string;
}

/**
 * Params for resuming an existing thread. A subset of
 * `ResumeThreadParams`.
 */
export interface ResumeLiveThreadParams {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly history?: ReadonlyArray<RolloutItem>;
  readonly rolloutStore: RolloutStore;
  readonly threadStore?: ThreadStore;
  readonly includeArchived?: boolean;
  readonly model?: string;
  readonly modelProvider?: string;
}

/**
 * Handle for an active thread. Immutable construction; the
 * underlying `RolloutStore` owns all mutable rollout state.
 */
export class LiveThread {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  private readonly store: RolloutStore;
  private readonly threadStore?: ThreadStore;
  private shutdownCalled = false;

  /** @internal Use `createLiveThread` / `resumeLiveThread` factories. */
  constructor(params: {
    readonly threadId: ThreadId;
    readonly forkedFromId?: ThreadId;
    readonly rolloutStore: RolloutStore;
    readonly threadStore?: ThreadStore;
  }) {
    this.threadId = params.threadId;
    if (params.forkedFromId !== undefined) {
      this.forkedFromId = params.forkedFromId;
    }
    this.store = params.rolloutStore;
    if (params.threadStore !== undefined) {
      this.threadStore = params.threadStore;
    }
  }

  /** The `RolloutStore` this thread writes through. */
  get rolloutStore(): RolloutStore {
    return this.store;
  }

  /**
   * Append rollout items in order. When a
   * `ThreadStore` is bound, the append is routed through
   * `ThreadStore.appendItems`; otherwise, the items go directly to the
   * `RolloutStore`. Throws if the handle has been shut down.
   */
  appendItems(items: ReadonlyArray<RolloutItem>): void {
    if (this.shutdownCalled) {
      throw new Error(
        `LiveThread(${this.threadId}): appendItems called after shutdown`,
      );
    }
    if (this.threadStore !== undefined) {
      this.threadStore.appendItems({ threadId: this.threadId, items });
      return;
    }
    for (const item of items) {
      this.store.appendRollout(item);
    }
  }

  /** Force a durable flush barrier. */
  flush(): void {
    if (this.threadStore !== undefined) {
      this.threadStore.flushThread(this.threadId);
      return;
    }
    this.store.flushDurable();
  }

  /**
   * Materialize any lazy persistence state. `RolloutStore` opens
   * eagerly, so this reduces to `flush`.
   */
  persist(): void {
    if (this.threadStore !== undefined) {
      this.threadStore.persistThread(this.threadId);
      return;
    }
    this.store.flushDurable();
  }

  /**
   * Tear down per-thread writer state. Does NOT close the `RolloutStore` because
   * the store lifecycle is owned by `Session`.
   */
  shutdown(): void {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    if (this.threadStore !== undefined) {
      this.threadStore.shutdownThread(this.threadId);
      return;
    }
    this.store.flushDurable();
  }

  /**
   * Abandon the thread without flushing. When a `ThreadStore`
   * is bound, delegates to `ThreadStore.discardThread` so the live
   * writer entry is dropped without forcing pending items durable.
   * Without a store, falls back to marking the handle shut down —
   * prior flushed writes remain in the rollout file.
   */
  discard(): void {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    if (this.threadStore !== undefined) {
      this.threadStore.discardThread(this.threadId);
    }
  }

  /**
   * Return the durable rollout path for this thread.
   */
  localRolloutPath(): string {
    return this.store.rolloutPath;
  }

  /** Whether the handle has been shut down. */
  get isShutdown(): boolean {
    return this.shutdownCalled;
  }

  /**
   * Load rollout history for this thread. Requires a bound
   * `ThreadStore`; throws `ThreadStoreInvalidRequestError` otherwise.
   */
  loadHistory(includeArchived: boolean): StoredThreadHistory {
    if (this.threadStore === undefined) {
      throw new ThreadStoreInvalidRequestError(
        `LiveThread(${this.threadId}): loadHistory requires a bound ThreadStore`,
      );
    }
    return this.threadStore.loadHistory({
      threadId: this.threadId,
      includeArchived,
    });
  }

  /**
   * Update this thread's memory mode. Requires a
   * bound `ThreadStore`; throws `ThreadStoreInvalidRequestError`
   * otherwise.
   */
  updateMemoryMode(
    mode: ThreadMemoryMode,
    includeArchived: boolean,
  ): StoredThread {
    if (this.threadStore === undefined) {
      throw new ThreadStoreInvalidRequestError(
        `LiveThread(${this.threadId}): updateMemoryMode requires a bound ThreadStore`,
      );
    }
    return this.threadStore.updateThreadMetadata({
      threadId: this.threadId,
      patch: { memoryMode: mode },
      includeArchived,
    });
  }
}

/**
 * Create a `LiveThread` for a new conversation. When a `ThreadStore` is
 * supplied, the factory calls `threadStore.createThread(...)` so the
 * store records the live writer; otherwise the handle is returned
 * without any store-side registration.
 */
export function createLiveThread(params: CreateLiveThreadParams): LiveThread {
  if (params.threadStore !== undefined) {
    params.threadStore.createThread({
      threadId: params.threadId,
      rolloutStore: params.rolloutStore,
      ...(params.forkedFromId !== undefined
        ? { forkedFromId: params.forkedFromId }
        : {}),
      ...(params.source !== undefined ? { source: params.source } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.modelProvider !== undefined
        ? { modelProvider: params.modelProvider }
        : {}),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });
  }
  const handle: {
    readonly threadId: ThreadId;
    readonly rolloutStore: RolloutStore;
    forkedFromId?: ThreadId;
    threadStore?: ThreadStore;
  } = {
    threadId: params.threadId,
    rolloutStore: params.rolloutStore,
  };
  if (params.forkedFromId !== undefined) {
    handle.forkedFromId = params.forkedFromId;
  }
  if (params.threadStore !== undefined) {
    handle.threadStore = params.threadStore;
  }
  return new LiveThread(handle);
}

/**
 * Resume a `LiveThread` for an existing conversation. When a `ThreadStore` is
 * supplied, the factory calls `threadStore.resumeThread(...)`.
 */
export function resumeLiveThread(params: ResumeLiveThreadParams): LiveThread {
  if (params.threadStore !== undefined) {
    params.threadStore.resumeThread({
      threadId: params.threadId,
      rolloutStore: params.rolloutStore,
      ...(params.rolloutPath !== undefined
        ? { rolloutPath: params.rolloutPath }
        : {}),
      ...(params.history !== undefined ? { history: params.history } : {}),
      ...(params.includeArchived !== undefined
        ? { includeArchived: params.includeArchived }
        : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.modelProvider !== undefined
        ? { modelProvider: params.modelProvider }
        : {}),
    });
  }
  const handle: {
    readonly threadId: ThreadId;
    readonly rolloutStore: RolloutStore;
    threadStore?: ThreadStore;
  } = {
    threadId: params.threadId,
    rolloutStore: params.rolloutStore,
  };
  if (params.threadStore !== undefined) {
    handle.threadStore = params.threadStore;
  }
  return new LiveThread(handle);
}

/**
 * Two-phase init rollback guard.
 *
 * Discards the owned live thread after a failed session init.
 * TypeScript has no deterministic destructor, so the guard uses an
 * explicit `commit()` / `discard()` API:
 *
 *   const guard = new LiveThreadInitGuard(live);
 *   try {
 *     // ... fallible init steps that might throw ...
 *     guard.commit();
 *   } finally {
 *     guard.discard();  // no-op after commit; rolls back otherwise
 *   }
 *
 * `LiveThread.discard()` is synchronous (backed by the in-memory
 * live-writer map in `FileThreadStore`), so no async spawn is needed.
 * If a future
 * `ThreadStore` implementation is asynchronous, the caller should
 * `await` its own `commit/discard` lifecycle instead of relying on a
 * destructor analog.
 */
export class LiveThreadInitGuard {
  private liveThread: LiveThread | undefined;

  constructor(liveThread: LiveThread | undefined) {
    this.liveThread = liveThread;
  }

  /** Return the wrapped `LiveThread` if one was supplied. */
  asRef(): LiveThread | undefined {
    return this.liveThread;
  }

  /**
   * Release ownership. After `commit()`, `discard()` is a no-op.
   */
  commit(): void {
    this.liveThread = undefined;
  }

  /**
   * Roll back the owned live thread by calling `LiveThread.discard()`.
   * Idempotent: subsequent calls are no-ops.
   */
  discard(): void {
    const thread = this.liveThread;
    if (thread === undefined) return;
    this.liveThread = undefined;
    try {
      thread.discard();
    } catch (err) {
      // Warn on discard failure; don't propagate.
      // Guard-driven discard happens on error paths where we don't
      // want to mask the original error with a cleanup failure.
      // eslint-disable-next-line no-console
      console.warn(
        `failed to discard thread persistence for failed session init: ${String(err)}`,
      );
    }
  }
}
