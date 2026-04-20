/**
 * BehaviorSubject — observable carrying a current value, replays on subscribe.
 *
 * Translation of Rust `tokio::sync::watch::channel` per
 * `docs/plan/translation-conventions.md`. Subscribers receive the current
 * value immediately on subscribe, then every subsequent `next(value)`.
 * The async iterator `changes()` yields each new value (skipping the
 * initial replay).
 *
 * Used for `Session.agentStatus` (T9), `Session.outOfBandElicitationPaused`
 * (codex parity), and `Mailbox.seqWatch` (T9, mailbox sequence counter).
 *
 * @module
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

  /**
   * Current value. Always defined; reads cheap.
   */
  get value(): T {
    return this.currentValue;
  }

  /**
   * Whether `complete()` has been called.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Push a new value. All current subscribers receive it. No-op if
   * `complete()` has been called.
   */
  next(value: T): void {
    if (this.closed) return;
    this.currentValue = value;
    for (const l of this.listeners) l(value);
  }

  /**
   * Subscribe to value changes. The current value is delivered
   * synchronously before this returns. Returns an unsubscribe function.
   */
  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    fn(this.currentValue);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Async iterator yielding each new value AFTER subscription. Does not
   * replay the current value (use `value` for that). Terminates when
   * `complete()` is called.
   */
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

  /**
   * Mark the subject complete. Future `next` calls are no-ops.
   * Pending `changes()` iterators terminate cleanly. Synchronous
   * `subscribe` listeners are NOT re-fired with the current value.
   */
  complete(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.completionListeners) c();
  }
}
