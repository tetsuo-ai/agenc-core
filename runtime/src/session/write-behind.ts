import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";

type WriteBehindJob = { readonly kind: string; readonly run: () => void };
const currentQueue = new AsyncLocalStorage<SessionWriteBehindQueue>();
const writers = new Map<string, { project: string; queue: SessionWriteBehindQueue }>();

export function registerSessionWriteBehind(rolloutPath: string, queue: SessionWriteBehindQueue): () => void {
  const path = resolve(rolloutPath);
  const entry = { project: dirname(dirname(dirname(path))), queue };
  writers.set(path, entry);
  return () => { if (writers.get(path) === entry) writers.delete(path); };
}

export function drainRolloutWriteBehind(rolloutPath: string): void {
  const queue = writers.get(resolve(rolloutPath))?.queue;
  if (queue !== undefined && !queue.draining) queue.drain();
}

export function drainProjectWriteBehind(projectDir: string): void {
  const project = resolve(projectDir);
  for (const entry of writers.values()) {
    if (entry.project === project && !entry.queue.draining) entry.queue.drain();
  }
}

/** One session's ordered persistence work. Jobs must capture their inputs. */
export class SessionWriteBehindQueue {
  private jobs: WriteBehindJob[] = [];
  private enabled = false;
  private runInOwnerScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
  private depth = 0;
  private failed = false;
  private failure: unknown;

  get pending(): number { return this.jobs.length; }
  get deferring(): boolean { return this.enabled && this.depth === 0; }
  get draining(): boolean { return this.depth !== 0; }

  /** Start one loss window; the preceding step must have been flushed. */
  beginStep(): void {
    this.drain();
    this.runInOwnerScope = AsyncLocalStorage.snapshot();
    this.enabled = true;
  }

  /** Returns false when the caller must perform the work synchronously. */
  defer(kind: string, run: () => void): boolean {
    this.assertHealthy();
    if (!this.deferring) return false;
    this.jobs.push({ kind, run });
    return true;
  }

  /** Readers and terminal paths call this before observing durable state. */
  drain(): void {
    this.assertHealthy();
    this.depth += 1;
    try {
      while (this.jobs.length > 0) {
        // Retain a failed job and all successors. They remain
        // owned by this failed session; they are never silently discarded.
        const job = this.jobs.shift()!;
        try {
          if (this.runInOwnerScope) this.runInOwnerScope(job.run);
          else job.run();
        }
        catch (error) {
          this.jobs.unshift(job);
          this.failed = true;
          this.failure = error;
          throw error;
        }
      }
    } finally { this.depth -= 1; }
  }

  finish(): void {
    this.enabled = false;
    this.drain();
  }

  assertHealthy(): void {
    if (this.failed) throw this.failure;
  }
}

/** Async scope is explicit; there is no process-wide session fallback. */
export function withSessionWriteBehind<T>(queue: SessionWriteBehindQueue, run: () => T): T {
  return currentQueue.run(queue, run);
}

export function currentSessionWriteBehind(): SessionWriteBehindQueue | undefined {
  return currentQueue.getStore();
}
