import { jsonStringify } from "../utils/slowOperations.js";

export class RetryableError extends Error {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SerialBatchEventUploaderConfig<T> {
  readonly maxBatchSize: number;
  readonly maxBatchBytes?: number;
  readonly maxQueueSize: number;
  readonly send: (batch: T[]) => Promise<void>;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
  readonly maxConsecutiveFailures?: number;
  readonly onBatchDropped?: (batchSize: number, failures: number) => void;
}

export class SerialBatchEventUploader<T> {
  private pending: T[] = [];
  private pendingAtClose = 0;
  private draining = false;
  private closed = false;
  private backpressureResolvers: Array<() => void> = [];
  private flushResolvers: Array<() => void> = [];
  private droppedBatches = 0;
  private sleepResolve: (() => void) | null = null;
  private readonly config: SerialBatchEventUploaderConfig<T>;

  constructor(config: SerialBatchEventUploaderConfig<T>) {
    this.config = config;
  }

  get droppedBatchCount(): number {
    return this.droppedBatches;
  }

  get pendingCount(): number {
    return this.closed ? this.pendingAtClose : this.pending.length;
  }

  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return;
    const items = Array.isArray(events) ? events : [events];
    if (items.length === 0) return;

    while (
      this.pending.length + items.length > this.config.maxQueueSize &&
      !this.closed
    ) {
      await new Promise<void>((resolve) => {
        this.backpressureResolvers.push(resolve);
      });
    }

    if (this.closed) return;
    this.pending.push(...items);
    void this.drain();
  }

  flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) {
      return Promise.resolve();
    }
    void this.drain();
    return new Promise<void>((resolve) => {
      this.flushResolvers.push(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingAtClose = this.pending.length;
    this.pending = [];
    this.sleepResolve?.();
    this.sleepResolve = null;
    this.releaseBackpressure();
    this.resolveFlushes();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    let failures = 0;

    try {
      while (this.pending.length > 0 && !this.closed) {
        const batch = this.takeBatch();
        if (batch.length === 0) continue;

        try {
          await this.config.send(batch);
          failures = 0;
        } catch (error) {
          failures += 1;
          if (
            this.config.maxConsecutiveFailures !== undefined &&
            failures >= this.config.maxConsecutiveFailures
          ) {
            this.droppedBatches += 1;
            this.config.onBatchDropped?.(batch.length, failures);
            failures = 0;
            this.releaseBackpressure();
            continue;
          }
          this.pending = batch.concat(this.pending);
          const retryAfterMs =
            error instanceof RetryableError ? error.retryAfterMs : undefined;
          await this.sleep(this.retryDelay(failures, retryAfterMs));
          continue;
        }

        this.releaseBackpressure();
      }
    } finally {
      this.draining = false;
      if (this.pending.length === 0) {
        this.resolveFlushes();
      }
    }
  }

  private takeBatch(): T[] {
    const { maxBatchSize, maxBatchBytes } = this.config;
    if (maxBatchBytes === undefined) {
      return this.pending.splice(0, maxBatchSize);
    }

    let bytes = 0;
    let count = 0;
    while (count < this.pending.length && count < maxBatchSize) {
      let itemBytes: number;
      try {
        itemBytes = Buffer.byteLength(jsonStringify(this.pending[count]));
      } catch {
        this.pending.splice(count, 1);
        continue;
      }
      if (count > 0 && bytes + itemBytes > maxBatchBytes) break;
      bytes += itemBytes;
      count += 1;
    }
    return this.pending.splice(0, count);
  }

  private retryDelay(failures: number, retryAfterMs?: number): number {
    const jitter = Math.random() * this.config.jitterMs;
    if (retryAfterMs !== undefined) {
      const clamped = Math.max(
        this.config.baseDelayMs,
        Math.min(retryAfterMs, this.config.maxDelayMs),
      );
      return clamped + jitter;
    }
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    );
    return exponential + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepResolve = resolve;
      setTimeout(
        (self, nextResolve) => {
          self.sleepResolve = null;
          nextResolve();
        },
        ms,
        this,
        resolve,
      );
    });
  }

  private releaseBackpressure(): void {
    const resolvers = this.backpressureResolvers;
    this.backpressureResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private resolveFlushes(): void {
    const resolvers = this.flushResolvers;
    this.flushResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
