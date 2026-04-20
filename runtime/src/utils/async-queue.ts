/**
 * AsyncQueue — async FIFO with `send` / `recv` / `close` / `stream`.
 *
 * Translation of Rust `tokio::sync::mpsc::channel` per
 * `docs/plan/translation-conventions.md`. Multi-producer, single-consumer.
 * `send` is non-blocking by default; backpressure is controlled per-call
 * via `bounded` semantics or by wrapping with a higher-level limiter
 * (e.g. the `Mailbox` per I-16).
 *
 * Used by Session.txEvent (T6 sidecars) and Mailbox (T9). The `recv()`
 * returns `null` once the queue is closed AND empty, signalling normal
 * termination to async iteration.
 *
 * @module
 */

export interface AsyncQueueOptions {
  /**
   * Maximum number of buffered items. When the queue is full, `send`
   * returns `false` (caller may drop or wait); `sendBlocking` waits
   * for space. `0` (default) means unbounded.
   *
   * I-16 (bounded mailbox) wraps this primitive with a 1000-cap +
   * backpressure policy; see `runtime/src/agents/mailbox.ts` (T9).
   */
  readonly maxDepth?: number;
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T | null) => void> = [];
  private closed = false;
  private readonly maxDepth: number;

  constructor(options: AsyncQueueOptions = {}) {
    this.maxDepth = options.maxDepth ?? 0;
  }

  /**
   * Enqueue an item. Returns `true` if accepted, `false` if rejected
   * because the queue is bounded and full or already closed.
   */
  send(item: T): boolean {
    if (this.closed) return false;
    if (this.maxDepth > 0 && this.items.length >= this.maxDepth) {
      // Even when full, a waiter (consumer ready before producer) accepts the item.
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(item);
        return true;
      }
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
    return true;
  }

  /**
   * Enqueue an item, awaiting space if the queue is full. On close,
   * resolves to `false`.
   */
  async sendBlocking(item: T, signal?: AbortSignal): Promise<boolean> {
    if (this.send(item)) return true;
    while (!this.closed) {
      if (signal?.aborted) return false;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if (this.closed || this.items.length < (this.maxDepth || Infinity)) {
            resolve();
          } else {
            setImmediate(tick);
          }
        };
        tick();
      });
      if (this.send(item)) return true;
    }
    return false;
  }

  /**
   * Receive the next item, awaiting until one is available. Returns
   * `null` when the queue is closed AND empty (normal termination).
   */
  async recv(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Try to receive without awaiting. Returns the item if one is buffered,
   * `null` if the queue is closed and empty, `undefined` if the queue is
   * open but empty (caller should `await recv()` to wait).
   */
  tryRecv(): T | null | undefined {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return null;
    return undefined;
  }

  /**
   * Close the queue. Subsequent `send` returns `false`. Pending `recv`
   * callers receive `null`. Already-buffered items remain available
   * until drained.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w(null);
    }
  }

  /**
   * Number of buffered items not yet consumed.
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * `true` if `close()` was called.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Async iterator that yields items in FIFO order until the queue is
   * closed and drained.
   */
  async *stream(): AsyncIterable<T> {
    while (true) {
      const item = await this.recv();
      if (item === null) return;
      yield item;
    }
  }
}
