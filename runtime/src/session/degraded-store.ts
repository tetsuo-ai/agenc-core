/**
 * Degraded-mode ring buffer for sidecars that lose their disk backing.
 *
 * Invariants wired here:
 *   I-12 (filesystem error handling) — ENOSPC/EROFS/EACCES/EIO caught
 *        at the write boundary trigger degraded mode; events land
 *        here instead of disk.
 *   I-38 (fsync failure → degraded) — extends I-12; fsync failure
 *        after one retry also routes here.
 *   I-43 (sidecar degraded mode is per-sidecar) — each sidecar owns
 *        its own DegradedStore so ENOSPC in one doesn't starve
 *        another. The reserved 64KB error buffer lives in sidecar.ts.
 *
 * Behavior:
 *   - Ring buffer, fixed size (default 1000 events); eviction on
 *     overflow emits a one-shot warning.
 *   - Periodic retry every 30s attempts to flush the buffer back to
 *     disk by calling the caller-supplied `flushFn`. On success,
 *     clear the buffer and exit degraded mode. On failure, wait for
 *     the next interval.
 *   - Construction does NOT start the retry timer; call `start()`
 *     after installing `flushFn`. `stop()` clears the timer.
 *
 * @module
 */

import { monotonicMs } from "../utils/monotonic.js";

export const DEFAULT_DEGRADED_CAPACITY = 1000;
export const DEFAULT_DEGRADED_RETRY_MS = 30_000;

export interface DegradedStoreOptions<T> {
  /** Max events retained. Oldest-first eviction. Default 1000. */
  readonly capacity?: number;
  /** Retry interval in ms. Default 30_000. */
  readonly retryIntervalMs?: number;
  /**
   * Flush callback invoked on retry. Must return true on success
   * (store exits degraded mode, buffer cleared) or false on failure
   * (stay degraded, retry next interval). Throwing is treated as
   * false.
   */
  readonly flushFn: (events: ReadonlyArray<T>) => Promise<boolean>;
  /** Called on first-eviction and on enter/exit degraded transitions. */
  readonly onStatusChange?: (status: DegradedStatusChange) => void;
}

export type DegradedStatusChange =
  | { readonly kind: "entered"; readonly reason: string; readonly at: number }
  | { readonly kind: "exited"; readonly flushedCount: number; readonly at: number }
  | {
      readonly kind: "evicted";
      readonly evicted: number;
      readonly capacity: number;
      readonly at: number;
    };

export class DegradedStore<T> {
  private readonly capacity: number;
  private readonly retryIntervalMs: number;
  private readonly flushFn: (events: ReadonlyArray<T>) => Promise<boolean>;
  private readonly onStatusChange?: (c: DegradedStatusChange) => void;
  private buffer: T[] = [];
  private degraded = false;
  private enteredAtMs: number | null = null;
  private totalEvicted = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private stopped = false;

  constructor(opts: DegradedStoreOptions<T>) {
    this.capacity = opts.capacity ?? DEFAULT_DEGRADED_CAPACITY;
    this.retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_DEGRADED_RETRY_MS;
    this.flushFn = opts.flushFn;
    this.onStatusChange = opts.onStatusChange;
  }

  /** Start the periodic retry timer. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tryFlush();
    }, this.retryIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop the retry timer and prevent future restarts. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  get size(): number {
    return this.buffer.length;
  }

  get evictedCount(): number {
    return this.totalEvicted;
  }

  /**
   * Enter degraded mode. Idempotent. Caller invokes on catch of
   * ENOSPC/EROFS/EACCES/EIO/fsync-fail.
   */
  enterDegraded(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.enteredAtMs = monotonicMs();
    this.onStatusChange?.({
      kind: "entered",
      reason,
      at: this.enteredAtMs,
    });
  }

  /**
   * Append an event to the ring buffer. On overflow, evicts oldest
   * and fires a one-shot `evicted` status change.
   */
  append(event: T): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      const overflow = this.buffer.length - this.capacity;
      this.buffer.splice(0, overflow);
      this.totalEvicted += overflow;
      this.onStatusChange?.({
        kind: "evicted",
        evicted: overflow,
        capacity: this.capacity,
        at: monotonicMs(),
      });
    }
  }

  /**
   * Take a snapshot of the buffer for diagnostics. Does NOT drain.
   * `drain()` removes + returns.
   */
  snapshot(): ReadonlyArray<T> {
    return [...this.buffer];
  }

  /** Remove and return all buffered events. */
  drain(): T[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /**
   * Attempt to flush the buffer via `flushFn`. On success: clear
   * buffer, exit degraded mode, fire `exited` status change.
   * Retried by the interval timer on failure.
   */
  async tryFlush(): Promise<boolean> {
    if (!this.degraded || this.flushing) return false;
    if (this.buffer.length === 0) {
      this.exitDegraded(0);
      return true;
    }
    this.flushing = true;
    const toFlush = [...this.buffer];
    try {
      const ok = await this.flushFn(toFlush);
      if (ok) {
        // Only clear the portion we flushed — appends during the
        // async gap stay in the buffer.
        this.buffer.splice(0, toFlush.length);
        if (this.buffer.length === 0) {
          this.exitDegraded(toFlush.length);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      this.flushing = false;
    }
  }

  private exitDegraded(flushedCount: number): void {
    this.degraded = false;
    this.enteredAtMs = null;
    this.onStatusChange?.({
      kind: "exited",
      flushedCount,
      at: monotonicMs(),
    });
  }
}
