/**
 * AsyncLock — single-reader/single-writer mutex around a value.
 *
 * Translation of Rust `Arc<Mutex<T>>` per `docs/plan/translation-conventions.md`.
 * Critical sections are serialized via a Promise chain. Concurrent callers
 * await each other's completion in arrival order.
 *
 * @module
 */

/**
 * Async mutex guarding a value of type `T`. All access goes through `with`
 * which serializes critical sections.
 */
export class AsyncLock<T> {
  private value: T;
  private chain: Promise<void> = Promise.resolve();

  constructor(initial: T) {
    this.value = initial;
  }

  /**
   * Run `fn` with exclusive access to the guarded value. Subsequent
   * `with` calls queue behind this one and resolve in arrival order.
   *
   * The value reference passed to `fn` MUST NOT escape the callback;
   * otherwise the lock guarantees are void.
   */
  async with<R>(fn: (value: T) => Promise<R> | R): Promise<R> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const previous = this.chain;
    this.chain = gate;
    await previous;
    try {
      return await fn(this.value);
    } finally {
      release();
    }
  }

  /**
   * Replace the guarded value atomically. Equivalent to
   * `lock.with(() => { /* assign *\/ })` but more ergonomic for the
   * common "swap state" case.
   */
  async swap(next: T): Promise<T> {
    return this.with((current) => {
      this.value = next;
      return current;
    });
  }

  /**
   * Atomically derive a replacement value from the current value and
   * return a caller-defined result from the same critical section.
   */
  async update<R>(
    fn: (current: T) => { readonly next: T; readonly result: R } | Promise<{
      readonly next: T;
      readonly result: R;
    }>,
  ): Promise<R> {
    return this.with(async (current) => {
      const { next, result } = await fn(current);
      this.value = next;
      return result;
    });
  }

  /**
   * Read the guarded value without taking the lock. Use only when you
   * KNOW no concurrent writer can run (e.g. during single-threaded
   * setup or post-shutdown cleanup). For all other reads, use `with`.
   */
  unsafePeek(): T {
    return this.value;
  }
}
