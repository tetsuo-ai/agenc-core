/**
 * Per-dir AsyncLock for `runtime/src/permissions/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/async-lock.ts` API the
 * permissions modules use (mode + network-approval mutexes). Carved as
 * a local `_deps/` to cut the gut→AgenC crossing.
 */

export class AsyncLock<T> {
  private value: T;
  private chain: Promise<void> = Promise.resolve();

  constructor(initial: T) {
    this.value = initial;
  }

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

  async swap(next: T): Promise<T> {
    return this.with((current) => {
      this.value = next;
      return current;
    });
  }

  unsafePeek(): T {
    return this.value;
  }
}
