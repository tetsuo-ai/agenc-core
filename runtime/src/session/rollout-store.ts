/**
 * Rollout-store — the publicly-consumed handle on the session rollout.
 *
 * SessionStore owns the on-disk state (flock, file handle, index);
 * RolloutStore is the event-log-facing facade that phases, sidecars,
 * and session.ts call into. Keeping them separate lets us swap
 * backends (file → S3-for-remote-agents) without touching callers.
 *
 * Also owns the 100ms batch flush scheduler. I-25 (snapshot is
 * best-effort, rollout is source of truth) is honored by treating
 * every snapshot write as advisory: if it fails, the rollout itself
 * still contains the truth.
 *
 * @module
 */

import type { Event } from "./event-log.js";
import type { RolloutItem } from "./rollout-item.js";
import {
  SessionStore,
  SessionStoreFlushScheduler,
  type AppendOptions,
  type SessionStoreOpts,
} from "./session-store.js";

export interface RolloutStoreOpts extends SessionStoreOpts {
  /** Flush interval in ms. Default 100. */
  readonly flushIntervalMs?: number;
  /** Whether to auto-start the background flush scheduler. Default true. */
  readonly autoStartScheduler?: boolean;
}

export class RolloutStore {
  readonly store: SessionStore;
  private readonly scheduler: SessionStoreFlushScheduler;
  private readonly startScheduler: boolean;

  constructor(opts: RolloutStoreOpts) {
    this.store = new SessionStore(opts);
    this.scheduler = new SessionStoreFlushScheduler(
      this.store,
      opts.flushIntervalMs ?? 100,
    );
    this.startScheduler = opts.autoStartScheduler !== false;
  }

  open(meta: Parameters<SessionStore["open"]>[0]): void {
    this.store.open(meta);
    if (this.startScheduler) this.scheduler.start();
  }

  append(event: Event, opts: AppendOptions = {}): void {
    this.store.append(event, opts);
  }

  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    this.store.appendRollout(item, opts);
  }

  readAll(): RolloutItem[] {
    return this.store.readAll();
  }

  get rolloutPath(): string {
    return this.store.rolloutPath;
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  get isDegraded(): boolean {
    return this.store.isDegraded;
  }

  /** I-88 — read the per-turn tool-result-bytes index. */
  getToolResultBytes(turnId: string): number {
    return this.store.getToolResultBytes(turnId);
  }

  /** I-88 — snapshot the full index (used by compaction). */
  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getToolResultBytesIndexSnapshot();
  }

  /** Force an immediate flush (durable=true). */
  flushDurable(): void {
    this.store.flushBatch(true);
  }

  close(): void {
    this.scheduler.stop();
    this.store.close();
  }
}
