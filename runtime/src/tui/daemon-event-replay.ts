interface ReplaySubscriber {
  readonly callback: (event: unknown) => void;
  readonly pending: unknown[];
  draining: boolean;
  failure: DaemonEventReplayGapError | null;
}

export class DaemonEventReplayGapError extends Error {
  readonly code = "DAEMON_EVENT_REPLAY_GAP";

  constructor(readonly capacity: number) {
    super(`Daemon event replay exceeded its ${capacity}-event capacity. Reopen this conversation to reload durable history before subscribing again.`);
    this.name = "DaemonEventReplayGapError";
  }
}

export class DaemonEventReplay {
  readonly #history: unknown[] = [];
  readonly #subscribers = new Set<ReplaySubscriber>();
  #historyHasGap = false;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("Daemon event replay capacity must be a positive safe integer");
    }
  }

  get size(): number {
    return this.#subscribers.size;
  }

  publish(event: unknown): void {
    if (this.#history.length < this.capacity) this.#history.push(event);
    else this.#historyHasGap = true;
    const subscribers = [...this.#subscribers];
    for (const subscriber of subscribers) {
      if (subscriber.pending.length >= this.capacity) {
        subscriber.failure ??= new DaemonEventReplayGapError(this.capacity);
      } else if (subscriber.failure === null) {
        subscriber.pending.push(event);
      }
    }
    let failure: { readonly error: unknown } | undefined;
    for (const subscriber of subscribers) {
      try {
        this.#drain(subscriber);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure !== undefined) throw failure.error;
  }

  subscribe(callback: (event: unknown) => void): () => void {
    if (this.#historyHasGap) throw new DaemonEventReplayGapError(this.capacity);
    const subscriber: ReplaySubscriber = {
      callback, pending: [...this.#history], draining: false, failure: null,
    };
    this.#subscribers.add(subscriber);
    this.#drain(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
      subscriber.pending.length = 0;
    };
  }

  #drain(subscriber: ReplaySubscriber): void {
    if (subscriber.draining || !this.#subscribers.has(subscriber)) return;
    subscriber.draining = true;
    try {
      while (subscriber.pending.length > 0 || subscriber.failure !== null) {
        if (subscriber.failure !== null) throw subscriber.failure;
        subscriber.callback(subscriber.pending.shift());
      }
    } catch (error) {
      this.#subscribers.delete(subscriber);
      subscriber.pending.length = 0;
      throw error;
    } finally {
      subscriber.draining = false;
    }
  }
}
