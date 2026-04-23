/**
 * Per-dir AsyncLock for `runtime/src/prompts/**`.
 *
 * Mirrors the openclaude-port `runtime/src/utils/async-lock.ts` API the
 * memory loader uses (per-key write mutex). Carved as a local `_deps/`
 * to cut the gut→openclaude crossing.
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
