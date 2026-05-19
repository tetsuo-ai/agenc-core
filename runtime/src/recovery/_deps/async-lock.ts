/**
 * Lean AsyncLock for the recovery subsystem.
 *
 * Mirrors the upstream `utils/async-lock.ts::AsyncLock` API surface
 * actually used by `recovery/fallback-ladder.ts`: `new AsyncLock<T>(v)`
 * and `lock.with(fn)`. Critical sections are serialized via a Promise
 * chain so concurrent callers await each other in arrival order.
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
}
