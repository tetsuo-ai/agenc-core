/**
 * AsyncRwLock — multi-reader / single-writer lock around a value.
 *
 * Translation of Rust `Arc<RwLock<T>>` per `docs/plan/translation-conventions.md`.
 * Multiple `withRead` callers run concurrently. `withWrite` blocks until
 * all current readers complete, then runs exclusively. New readers
 * arriving while a writer is queued yield to the writer to prevent
 * writer-starvation.
 *
 * Used by the four-class concurrency contract (T7): SharedRead tools
 * acquire read locks; Exclusive tools acquire write locks. See I-61
 * for SharedServer per-id semaphore variant.
 *
 * @module
 */

export class AsyncRwLock<T> {
  private value: T;
  private readers = 0;
  private writerChain: Promise<void> = Promise.resolve();
  private pendingReadGate: Promise<void> = Promise.resolve();

  constructor(initial: T) {
    this.value = initial;
  }

  /**
   * Run `fn` with shared read access. Concurrent `withRead` callers run
   * in parallel. If a writer is queued (`withWrite` already called and
   * waiting for readers to drain), new readers wait for the writer to
   * complete first — this prevents writer-starvation under heavy read
   * load.
   */
  async withRead<R>(fn: (value: T) => Promise<R> | R): Promise<R> {
    await this.pendingReadGate;
    this.readers++;
    try {
      return await fn(this.value);
    } finally {
      this.readers--;
    }
  }

  /**
   * Run `fn` with exclusive write access. Queues behind any in-flight
   * writer, then waits for all current readers to drain, then runs
   * exclusively. Subsequent reads + writes wait for this to complete.
   */
  async withWrite<R>(fn: (value: T) => Promise<R> | R): Promise<R> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const previous = this.writerChain;
    this.writerChain = gate;
    this.pendingReadGate = gate;
    await previous;
    // Drain readers that started before we acquired the chain.
    while (this.readers > 0) {
      await new Promise((r) => setImmediate(r));
    }
    try {
      return await fn(this.value);
    } finally {
      release();
    }
  }
}
