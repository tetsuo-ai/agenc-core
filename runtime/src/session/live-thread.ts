/**
 * LiveThread — handle for an active thread's persistence lifecycle.
 *
 * Hand-port of upstream codex runtime `thread-store/src/live_thread.rs`.
 * Upstream's `LiveThread` is a thin façade over a `ThreadStore` trait
 * (local + remote implementations), and session code calls into it for
 * turn-by-turn rollout appends, flush barriers, and thread-metadata
 * updates while a session is live.
 *
 * Gut's `ThreadStore` port (see `./thread-store.ts`) is partial but
 * covers the surface this module needs: the RESERVED methods below
 * (`discard`, `loadHistory`, `updateMemoryMode`) and the
 * `LiveThreadInitGuard` two-phase init rollback are now wired.
 *
 * Upstream method → gut port status:
 *
 *   create / resume           WIRED — `createLiveThread` /
 *                             `resumeLiveThread` factories take an
 *                             existing `RolloutStore` and an optional
 *                             `ThreadStore`. When a `ThreadStore` is
 *                             supplied, the factory calls
 *                             `threadStore.createThread(...)` /
 *                             `resumeThread(...)` so the store
 *                             registers the live writer.
 *   append_items              WIRED — appends `RolloutItem[]` through
 *                             `ThreadStore.appendItems` when the store
 *                             is bound; falls back to the direct
 *                             `RolloutStore.appendRollout` path
 *                             otherwise.
 *   persist                   WIRED (partial) — reduces to a synchronous
 *                             `flushDurable`. Upstream's `persist` also
 *                             materializes lazy in-memory state into a
 *                             rollout file; gut's `RolloutStore.open` is
 *                             eager, so there is no lazy file to create.
 *   flush                     WIRED.
 *   shutdown                  WIRED (partial) — flushes and marks the
 *                             handle shut down. When a `ThreadStore` is
 *                             bound, also calls `shutdownThread`.
 *   discard                   WIRED — when a `ThreadStore` is bound,
 *                             delegates to `ThreadStore.discardThread`.
 *                             Without a store, falls back to marking
 *                             the handle shut down (legacy behaviour).
 *   load_history              WIRED — requires a bound `ThreadStore`.
 *                             Throws `ThreadStoreInvalidRequestError`
 *                             when the store is absent.
 *   update_memory_mode        WIRED — requires a bound `ThreadStore`.
 *   local_rollout_path        WIRED — returns `rolloutStore.rolloutPath`.
 *
 * `LiveThreadInitGuard` is a real type below. Upstream uses Rust's
 * `Drop` trait to fire `ThreadStore::discard_thread` when the guard
 * goes out of scope after a failed init; TS has no deterministic
 * destructor, so we expose an explicit `commit()` / `discard()` API
 * and callers wrap their fallible init in a try/finally. This is the
 * documented pattern change.
 *
 * @module
 */

import type { ThreadId } from "../agents/registry.js";
import type { RolloutItem } from "./rollout-item.js";
import type { RolloutStore } from "./rollout-store.js";
import {
  ThreadStoreInvalidRequestError,
  type ThreadMemoryMode,
  type ThreadStore,
  type StoredThread,
  type StoredThreadHistory,
} from "./thread-store.js";

/**
 * Params for creating a new `LiveThread`. Mirrors upstream
 * `CreateThreadParams` (thread-store/src/types.rs:31) minus the
 * fields that have no gut-side consumer yet (`baseInstructions`,
 * `dynamicTools`). `eventPersistenceMode` is accepted for signature
 * parity but ignored by gut's default store.
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
  readonly source?: string;
  /** Optional cwd propagated to `ThreadStore.createThread`. */
  readonly cwd?: string;
}

/**
 * Params for resuming an existing thread. Mirrors upstream
 * `ResumeThreadParams` (thread-store/src/types.rs:48).
 */
export interface ResumeLiveThreadParams {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly history?: ReadonlyArray<RolloutItem>;
  readonly rolloutStore: RolloutStore;
  readonly threadStore?: ThreadStore;
  readonly includeArchived?: boolean;
}

/**
 * Handle for an active thread. Ported from upstream codex runtime
 * `thread-store/src/live_thread.rs`. Immutable construction; the
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
   * Append rollout items in order. Mirrors upstream
   * `LiveThread::append_items` (live_thread.rs:105). When a
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

  /** Force a durable flush barrier. Mirrors upstream `LiveThread::flush`. */
  flush(): void {
    if (this.threadStore !== undefined) {
      this.threadStore.flushThread(this.threadId);
      return;
    }
    this.store.flushDurable();
  }

  /**
   * Materialize any lazy persistence state. Mirrors upstream
   * `LiveThread::persist`. Gut's `RolloutStore` opens eagerly, so this
   * reduces to `flush`.
   */
  persist(): void {
    if (this.threadStore !== undefined) {
      this.threadStore.persistThread(this.threadId);
      return;
    }
    this.store.flushDurable();
  }

  /**
   * Tear down per-thread writer state. Mirrors upstream
   * `LiveThread::shutdown`. Does NOT close the `RolloutStore` because
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
   * Abandon the thread without flushing. Mirrors upstream
   * `LiveThread::discard` (live_thread.rs:126). When a `ThreadStore`
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
   * Return the durable rollout path for this thread. Mirrors upstream
   * `LiveThread::local_rollout_path` (live_thread.rs:163).
   */
  localRolloutPath(): string {
    return this.store.rolloutPath;
  }

  /** Whether the handle has been shut down. Not in upstream's API. */
  get isShutdown(): boolean {
    return this.shutdownCalled;
  }

  /**
   * Load rollout history for this thread. Mirrors upstream
   * `LiveThread::load_history` (live_thread.rs:130). Requires a bound
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
   * Update this thread's memory mode. Mirrors upstream
   * `LiveThread::update_memory_mode` (live_thread.rs:142). Requires a
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
 * Create a `LiveThread` for a new conversation. Mirrors upstream
 * `LiveThread::create` (live_thread.rs:81). When a `ThreadStore` is
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
 * Resume a `LiveThread` for an existing conversation. Mirrors upstream
 * `LiveThread::resume` (live_thread.rs:93). When a `ThreadStore` is
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
 * Two-phase init rollback guard. Ported from upstream
 * `LiveThreadInitGuard` (thread-store/src/live_thread.rs:36).
 *
 * Upstream uses Rust's `Drop` trait to fire
 * `ThreadStore::discard_thread` when the guard goes out of scope after
 * a failed session init. TypeScript has no deterministic destructor,
 * so this port uses an explicit `commit()` / `discard()` API:
 *
 *   const guard = new LiveThreadInitGuard(live);
 *   try {
 *     // ... fallible init steps that might throw ...
 *     guard.commit();
 *   } finally {
 *     guard.discard();  // no-op after commit; rolls back otherwise
 *   }
 *
 * Deviation from upstream: upstream's `Drop` implementation spawns the
 * discard on the current Tokio runtime handle and logs a warning if no
 * handle exists. Gut's `LiveThread.discard()` is synchronous (backed by
 * the in-memory live-writer map in `FileThreadStore`), so no runtime
 * handle is required and no async spawn is needed. If a future
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
   * Mirrors upstream `LiveThreadInitGuard::commit`
   * (live_thread.rs:49).
   */
  commit(): void {
    this.liveThread = undefined;
  }

  /**
   * Roll back the owned live thread by calling `LiveThread.discard()`.
   * Idempotent: subsequent calls are no-ops. Mirrors upstream
   * `LiveThreadInitGuard::discard` (live_thread.rs:53).
   */
  discard(): void {
    const thread = this.liveThread;
    if (thread === undefined) return;
    this.liveThread = undefined;
    try {
      thread.discard();
    } catch (err) {
      // Match upstream's `warn!` on discard failure — don't propagate.
      // Guard-driven discard happens on error paths where we don't
      // want to mask the original error with a cleanup failure.
      // eslint-disable-next-line no-console
      console.warn(
        `failed to discard thread persistence for failed session init: ${String(err)}`,
      );
    }
  }
}
