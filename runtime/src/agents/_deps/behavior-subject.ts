/**
 * Per-dir BehaviorSubject for `runtime/src/agents/**`.
 *
 * Mirrors the AgenC implementation `runtime/src/utils/behavior-subject.ts`
 * API used by `status.ts` (agent-status watch) and `mailbox.ts`
 * (sequence counter). Carved as a local `_deps/` to cut the gut→
 * AgenC crossing.
 */

type Listener<T> = (value: T) => void;

export class BehaviorSubject<T> {
  private currentValue: T;
  private readonly listeners = new Set<Listener<T>>();
  private readonly completionListeners = new Set<() => void>();
  private closed = false;

  constructor(initial: T) {
    this.currentValue = initial;
  }

  get value(): T {
    return this.currentValue;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  next(value: T): void {
    if (this.closed) return;
    this.currentValue = value;
    for (const l of this.listeners) l(value);
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    fn(this.currentValue);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async *changes(): AsyncIterable<T> {
    if (this.closed) return;
    const queue: T[] = [];
    let resolve: (() => void) | null = null;

    const valueListener: Listener<T> = (v) => {
      queue.push(v);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };
    this.listeners.add(valueListener);

    const completionListener = (): void => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };
    this.completionListeners.add(completionListener);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as T;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      this.listeners.delete(valueListener);
      this.completionListeners.delete(completionListener);
    }
  }

  complete(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.completionListeners) c();
  }
}
