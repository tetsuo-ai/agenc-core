/**
 * LiveThread — handle for an active thread's persistence lifecycle.
 *
 * Partial hand-port of upstream codex `thread-store/src/live_thread.rs`
 * (176 LOC Rust). Upstream's LiveThread is a thin façade over a
 * `ThreadStore` trait (local + remote implementations), and session code
 * calls into it for turn-by-turn rollout appends, flush barriers, and
 * thread-metadata updates while a session is live.
 *
 * Gut has no `ThreadStore` subsystem: there is no shared trait object
 * that sessions consult, no remote-thread variant, no archived-thread
 * dimension, and no metadata-patch surface. Gut's `RolloutStore`
 * (`session.rolloutStore`) is the only durable rollout sink. This port
 * therefore integrates with `RolloutStore` directly and marks
 * every ThreadStore-dependent method as `RESERVED`.
 *
 * Upstream method → gut port status:
 *
 *   create / resume           WIRED — `createLiveThread` / `resumeLiveThread`
 *                             factories take an existing `RolloutStore`
 *                             instead of an `Arc<dyn ThreadStore>`.
 *   append_items              WIRED — appends `RolloutItem[]` through
 *                             `rolloutStore.appendRollout`.
 *   persist                   WIRED (partial) — reduces to a synchronous
 *                             `flushDurable`. Upstream's `persist` also
 *                             materializes lazy in-memory state into a
 *                             rollout file; gut's `RolloutStore.open` is
 *                             eager, so there is no lazy file to create.
 *   flush                     WIRED — `rolloutStore.flushDurable`.
 *   shutdown                  WIRED (partial) — flushes and optionally
 *                             closes the owned rollout store. Upstream's
 *                             shutdown also tears down per-thread writer
 *                             state; gut has none.
 *   discard                   RESERVED — upstream uses this to abandon a
 *                             freshly-created thread when session init
 *                             fails before commit; requires the
 *                             `LiveThreadInitGuard` two-phase pattern
 *                             which in turn requires ThreadStore support
 *                             for deleting a newly-created thread.
 *   load_history              RESERVED — requires ThreadStore port
 *                             (archived / include_archived dimension).
 *                             A local-only convenience variant reads
 *                             from the current RolloutStore instead.
 *   update_memory_mode        RESERVED — requires ThreadStore port
 *                             (ThreadMetadataPatch surface).
 *   local_rollout_path        WIRED — returns `rolloutStore.rolloutPath`.
 *
 * `LiveThreadInitGuard` (upstream) is also RESERVED: its init-failure
 * rollback semantics require ThreadStore.discard_thread, which gut does
 * not have.
 *
 * @module
 */

import type { ThreadId } from "../agents/registry.js";
import type { RolloutItem } from "./rollout-item.js";
import type { RolloutStore } from "./rollout-store.js";

/**
 * Params for creating a new `LiveThread`. Mirrors upstream
 * `CreateThreadParams` (thread-store/src/types.rs:31) minus the
 * ThreadStore-only fields (`source`, `baseInstructions`, `dynamicTools`,
 * `eventPersistenceMode`) that have no gut-side consumer yet. The
 * `forkedFromId` slot is kept so call sites can record fork ancestry
 * once gut grows a fork surface.
 */
export interface CreateLiveThreadParams {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  /**
   * Existing `RolloutStore` the thread should append into. The caller is
   * expected to have already opened the store (`store.open(...)`); this
   * factory never calls `open` itself because the rollout lifecycle in
   * gut is owned by `Session`, not the thread handle.
   */
  readonly rolloutStore: RolloutStore;
}

/**
 * Params for resuming an existing thread. Mirrors upstream
 * `ResumeThreadParams` (thread-store/src/types.rs:48) minus
 * `include_archived` and `event_persistence_mode` (RESERVED — requires
 * ThreadStore). `rolloutPath` and `history` are accepted for parity but
 * not consulted: gut's `RolloutStore` is the replay source and is
 * expected to already be `open(..., { resume: true })`.
 */
export interface ResumeLiveThreadParams {
  readonly threadId: ThreadId;
  readonly rolloutPath?: string;
  readonly history?: ReadonlyArray<RolloutItem>;
  readonly rolloutStore: RolloutStore;
}

/**
 * Handle for an active thread. Ported from upstream codex
 * `thread-store/src/live_thread.rs`. Immutable by construction; the
 * underlying `RolloutStore` owns all mutable state.
 */
export class LiveThread {
  readonly threadId: ThreadId;
  readonly forkedFromId?: ThreadId;
  private readonly store: RolloutStore;
  private shutdownCalled = false;

  /** @internal Use `createLiveThread` / `resumeLiveThread` factories. */
  constructor(params: {
    readonly threadId: ThreadId;
    readonly forkedFromId?: ThreadId;
    readonly rolloutStore: RolloutStore;
  }) {
    this.threadId = params.threadId;
    if (params.forkedFromId !== undefined) {
      this.forkedFromId = params.forkedFromId;
    }
    this.store = params.rolloutStore;
  }

  /** The `RolloutStore` this thread writes through. Readonly accessor. */
  get rolloutStore(): RolloutStore {
    return this.store;
  }

  /**
   * Append rollout items in order. Mirrors upstream
   * `LiveThread::append_items` (live_thread.rs:105). Upstream batches the
   * items into a single `AppendThreadItemsParams` call; gut loops
   * through `RolloutStore.appendRollout` because the store already owns
   * the batch-flush scheduler.
   *
   * Throws if the handle has been shut down.
   */
  appendItems(items: ReadonlyArray<RolloutItem>): void {
    if (this.shutdownCalled) {
      throw new Error(
        `LiveThread(${this.threadId}): appendItems called after shutdown`,
      );
    }
    for (const item of items) {
      this.store.appendRollout(item);
    }
  }

  /**
   * Force a durable flush barrier. Mirrors upstream
   * `LiveThread::flush` (live_thread.rs:118). Synchronous in gut
   * because `RolloutStore.flushDurable` is synchronous.
   */
  flush(): void {
    this.store.flushDurable();
  }

  /**
   * Materialize any lazy persistence state. Mirrors upstream
   * `LiveThread::persist` (live_thread.rs:114). Gut's `RolloutStore`
   * opens eagerly, so this reduces to `flush` — there is no lazy
   * in-memory state to spill out on demand.
   */
  persist(): void {
    this.store.flushDurable();
  }

  /**
   * Tear down per-thread writer state. Mirrors upstream
   * `LiveThread::shutdown` (live_thread.rs:122). Flushes durably and
   * marks the handle shut down so subsequent `appendItems` calls throw.
   * Does NOT close the `RolloutStore` because the store is owned by
   * `Session`, not the thread handle.
   */
  shutdown(): void {
    if (this.shutdownCalled) return;
    this.shutdownCalled = true;
    this.store.flushDurable();
  }

  /**
   * Abandon the thread without flushing. Upstream uses this when session
   * initialization fails before the thread is committed
   * (`LiveThreadInitGuard::discard`, live_thread.rs:53). Gut has no
   * two-phase init guard, so this RESERVED stub simply marks the handle
   * shut down; the underlying rollout-store content, if any was
   * appended before `discard`, is left for `Session` shutdown to clean
   * up.
   *
   * RESERVED: requires ThreadStore port to truly discard a new thread.
   */
  discard(): void {
    this.shutdownCalled = true;
  }

  /**
   * Return the durable rollout path for this thread when the underlying
   * store is local. Mirrors upstream `LiveThread::local_rollout_path`
   * (live_thread.rs:163). Gut's `RolloutStore` is always local, so this
   * always returns a path.
   */
  localRolloutPath(): string {
    return this.store.rolloutPath;
  }

  /**
   * Whether the handle has been shut down. Not in upstream's API;
   * exposed here for test introspection only.
   */
  get isShutdown(): boolean {
    return this.shutdownCalled;
  }

  // ─────────────────────────────────────────────────────────────────
  // RESERVED methods — require a ThreadStore port
  // ─────────────────────────────────────────────────────────────────

  /**
   * RESERVED: requires ThreadStore port.
   *
   * Upstream `LiveThread::load_history` (live_thread.rs:130) defers to
   * `ThreadStore::load_history`, which filters on the `include_archived`
   * flag and returns a full `StoredThreadHistory { thread_id, items }`
   * after consulting the thread-metadata archive bit. Gut has no
   * archive dimension.
   *
   * A caller that needs "replay items for this thread" can use the
   * underlying `RolloutStore.readAll()` directly; the filtering /
   * archive semantics are the missing piece.
   */
  loadHistory(_includeArchived: boolean): never {
    throw new Error(
      "LiveThread.loadHistory: RESERVED — requires ThreadStore port (include_archived / archive metadata).",
    );
  }

  /**
   * RESERVED: requires ThreadStore port.
   *
   * Upstream `LiveThread::update_memory_mode` (live_thread.rs:142)
   * patches thread metadata through `ThreadStore::update_thread_metadata`
   * with a `ThreadMetadataPatch { memory_mode: Some(mode), .. }`. Gut
   * has no `ThreadMetadataPatch` surface.
   */
  updateMemoryMode(_mode: unknown, _includeArchived: boolean): never {
    throw new Error(
      "LiveThread.updateMemoryMode: RESERVED — requires ThreadStore port (ThreadMetadataPatch).",
    );
  }
}

/**
 * Create a `LiveThread` for a new conversation. Mirrors upstream
 * `LiveThread::create` (live_thread.rs:81). Gut accepts an
 * already-opened `RolloutStore`; upstream additionally issues a
 * `ThreadStore::create_thread(params)` call, which is the step
 * gut does not have (RESERVED).
 */
export function createLiveThread(params: CreateLiveThreadParams): LiveThread {
  const handle: {
    readonly threadId: ThreadId;
    readonly rolloutStore: RolloutStore;
    forkedFromId?: ThreadId;
  } = {
    threadId: params.threadId,
    rolloutStore: params.rolloutStore,
  };
  if (params.forkedFromId !== undefined) {
    handle.forkedFromId = params.forkedFromId;
  }
  return new LiveThread(handle);
}

/**
 * Resume a `LiveThread` for an existing conversation. Mirrors upstream
 * `LiveThread::resume` (live_thread.rs:93). Gut's rollout replay
 * happens through `RolloutStore.open({ resume: true })` before this
 * factory is called, so this reduces to wrapping the store in a
 * handle with the resumed thread id.
 */
export function resumeLiveThread(params: ResumeLiveThreadParams): LiveThread {
  return new LiveThread({
    threadId: params.threadId,
    rolloutStore: params.rolloutStore,
  });
}
