/**
 * Mailbox — bidirectional typed queue for inter-agent communication.
 *
 * Hand-port of codex runtime `core/src/agent/mailbox.rs` (161 LOC) adapted
 * for AgenC's bounded + backpressure model. The codex implementation uses
 * `mpsc::unbounded_channel` and relies on tokio backpressure semantics;
 * Node has no equivalent OS-level backpressure signal, so AgenC runs
 * a bounded queue with an overflow salvage window instead.
 *
 * AgenC's mailbox is:
 *   - **Bidirectional** (I-5) — each message carries a
 *     `direction: 'up' | 'down'`. Session holds both `inbox`
 *     (from children) and `childInboxes: Map<threadId, Mailbox>`
 *     (to children).
 *   - **Bounded with salvage window** (I-16) —
 *     `MAX_MAILBOX_DEPTH=1000`. On overflow `send()` still returns
 *     synchronously (I-64) but parks the new message in a single
 *     `overflow` slot and arms a `MAX_MAILBOX_BLOCK_MS=5000` timer.
 *     If a `drain()` frees space inside that window, the overflow
 *     slot is promoted without dropping anything. If the timer
 *     fires first, the oldest message is dropped, the overflow is
 *     promoted, and the I-8 backpressure warning fires.
 *   - **Receiver-closed sentinel** (I-31) — after `close()`, the
 *     next `drain()` returns a single `agent_exited` sentinel then
 *     permanently empty. Sender rejects sends with
 *     `MailboxClosedError`.
 *   - **Non-blocking send** (I-64) — `send()` is synchronous.
 *     Callers never await.
 *
 * @module
 */

import { BehaviorSubject } from "./_deps/behavior-subject.js";

// ─────────────────────────────────────────────────────────────────────
// Constants (I-16)
// ─────────────────────────────────────────────────────────────────────

export const MAX_MAILBOX_DEPTH = 1_000;
export const MAX_MAILBOX_BLOCK_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** Direction of travel: up = child→parent, down = parent→child. */
export type MailboxDirection = "up" | "down";

export interface InterAgentCommunication {
  readonly author: string;
  readonly recipient: string;
  readonly content: string;
  /** When true, recipient should wake + process at next opportunity. */
  readonly triggerTurn: boolean;
  readonly direction: MailboxDirection;
  readonly seq: number;
  /** Optional free-form metadata (e.g. interrupt reason, task id). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SendResult = "sent" | "dropped";

/** Synthetic sentinel returned by `drain()` after `close()`. */
export interface AgentExitedSentinel {
  readonly type: "agent_exited";
  readonly threadId: string;
  readonly finalStatus?: string;
  readonly seq: number;
}

export type MailboxItem = InterAgentCommunication | AgentExitedSentinel;

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class MailboxClosedError extends Error {
  constructor(public readonly threadId: string) {
    super(`mailbox for ${threadId} is closed`);
    this.name = "MailboxClosedError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Mailbox
// ─────────────────────────────────────────────────────────────────────

export interface MailboxOpts {
  readonly threadId: string;
  readonly maxDepth?: number;
  /** Called when backpressure drops a message (I-16). */
  readonly onDrop?: (dropped: InterAgentCommunication) => void;
  /** Called once per drop streak for I-8 warning. */
  readonly onBackpressureStreak?: (count: number) => void;
}

export class Mailbox {
  readonly threadId: string;
  readonly seqWatch: BehaviorSubject<number>;
  private readonly maxDepth: number;
  private readonly onDrop?: (dropped: InterAgentCommunication) => void;
  private readonly onBackpressureStreak?: (count: number) => void;
  private queue: InterAgentCommunication[] = [];
  private nextSeq = 0;
  private closed = false;
  private finalStatus: string | undefined;
  private sentinelEmitted = false;
  private droppedStreak = 0;
  private _droppedTotal = 0;
  /**
   * I-16 overflow salvage slot. When `send()` is called while the
   * main queue is at `maxDepth`, the NEW message parks here instead
   * of being immediately dropped. A `MAX_MAILBOX_BLOCK_MS` timer
   * arms — if a `drain()` frees space first, the slot is promoted
   * into the main queue (FIFO preserved) and nothing is dropped.
   * If the timer fires first, the oldest message in the main queue
   * is dropped, the overflow message is promoted, and the I-8
   * backpressure warning fires.
   */
  private overflow: InterAgentCommunication | null = null;
  private overflowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MailboxOpts) {
    this.threadId = opts.threadId;
    this.maxDepth = opts.maxDepth ?? MAX_MAILBOX_DEPTH;
    this.onDrop = opts.onDrop;
    this.onBackpressureStreak = opts.onBackpressureStreak;
    this.seqWatch = new BehaviorSubject<number>(0);
  }

  /**
   * I-64: non-blocking synchronous send. Returns a SendResult
   * immediately. I-16 adds a `MAX_MAILBOX_BLOCK_MS` overflow
   * salvage window: when the main queue is full, the NEW message
   * parks in `overflow` and a 5s timer arms. A `drain()` within
   * the window promotes the overflow without any drop; if the
   * timer fires first the oldest is dropped, the overflow is
   * promoted, and the I-8 warning fires.
   *
   * A closed mailbox throws `MailboxClosedError`. In every other case
   * the message is accepted — either into the main queue or into
   * the overflow slot — so `send()` never returns `'dropped'` today;
   * any drop happens later when the timer fires or a later overflow
   * displaces the earlier one.
   */
  send(msg: Omit<InterAgentCommunication, "seq">): SendResult {
    if (this.closed) {
      throw new MailboxClosedError(this.threadId);
    }
    this.nextSeq += 1;
    const seq = this.nextSeq;
    const next: InterAgentCommunication = { ...msg, seq };

    if (this.queue.length >= this.maxDepth) {
      // Overflow salvage path (I-16). If overflow is already
      // occupied, the earlier overflow message is displaced
      // (FIFO on overflow): it counts as a dropped message
      // right now, because it lost its salvage seat.
      if (this.overflow !== null) {
        this.dropMessage(this.overflow);
      }
      this.overflow = next;
      this.armOverflowTimer();
      this.seqWatch.next(seq);
      return "sent";
    }

    if (this.droppedStreak > 0) {
      // Recovery: drop streak broken.
      this.droppedStreak = 0;
    }
    this.queue.push(next);
    this.seqWatch.next(seq);
    return "sent";
  }

  /** I-16 bookkeeping for a dropped message (async I-8 warning). */
  private dropMessage(dropped: InterAgentCommunication): void {
    const wasFirstDropInStreak = this.droppedStreak === 0;
    this._droppedTotal += 1;
    this.droppedStreak += 1;
    const totalAtDrop = this._droppedTotal;
    queueMicrotask(() => {
      this.onDrop?.(dropped);
      if (wasFirstDropInStreak) {
        this.onBackpressureStreak?.(totalAtDrop);
      }
    });
  }

  private armOverflowTimer(): void {
    if (this.overflowTimer !== null) {
      clearTimeout(this.overflowTimer);
    }
    this.overflowTimer = setTimeout(() => {
      this.overflowTimer = null;
      if (this.closed || this.overflow === null) return;
      // Timer fired before any drain salvaged us: drop oldest,
      // promote the overflow slot into the main queue.
      const oldest = this.queue.shift();
      if (oldest) this.dropMessage(oldest);
      const promoted = this.overflow;
      this.overflow = null;
      this.queue.push(promoted);
      this.seqWatch.next(promoted.seq);
    }, MAX_MAILBOX_BLOCK_MS);
    // Let the Node process exit even if a salvage window is open.
    const timer = this.overflowTimer as { unref?: () => void };
    timer.unref?.();
  }

  private clearOverflowTimer(): void {
    if (this.overflowTimer !== null) {
      clearTimeout(this.overflowTimer);
      this.overflowTimer = null;
    }
  }

  /** Non-mutating peek — true iff any queued items are present. */
  hasPending(): boolean {
    return this.queue.length > 0 || (this.closed && !this.sentinelEmitted);
  }

  hasPendingTriggerTurn(): boolean {
    return this.queue.some((m) => m.triggerTurn);
  }

  /**
   * Remove + return all queued items in FIFO order. I-31: after the
   * mailbox is closed, the first drain returns the `agent_exited`
   * sentinel (exactly once); subsequent drains return [].
   */
  drain(): ReadonlyArray<MailboxItem> {
    const items: MailboxItem[] = this.queue.splice(0);
    // I-16: drain just freed space — salvage the overflow slot
    // (if any) rather than dropping it when the timer fires.
    // The salvaged message joins this drain at the tail to
    // preserve FIFO vs. the just-drained items.
    if (this.overflow !== null) {
      const salvaged = this.overflow;
      this.overflow = null;
      this.clearOverflowTimer();
      items.push(salvaged);
      // drop streak ends on successful salvage
      this.droppedStreak = 0;
    }
    if (this.closed && !this.sentinelEmitted) {
      this.sentinelEmitted = true;
      this.nextSeq += 1;
      const sentinel: AgentExitedSentinel = {
        type: "agent_exited",
        threadId: this.threadId,
        seq: this.nextSeq,
        ...(this.finalStatus !== undefined ? { finalStatus: this.finalStatus } : {}),
      };
      items.push(sentinel);
    }
    return items;
  }

  /**
   * Close the mailbox. Subsequent sends are rejected; the next drain
   * emits the agent_exited sentinel.
   */
  close(finalStatus?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.finalStatus = finalStatus;
    // I-16: any pending salvage timer must not fire post-close.
    // Also drop the overflow slot so the sentinel is the last
    // non-empty result a drain ever sees.
    this.clearOverflowTimer();
    this.overflow = null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.queue.length;
  }

  get droppedTotal(): number {
    return this._droppedTotal;
  }

  /**
   * Async iterator that yields new arrivals. Terminates after the
   * sentinel is emitted. Used by parent-side consumers (e.g. TUI
   * progress rendering + session shutdown drain).
   */
  async *watch(): AsyncIterable<MailboxItem> {
    let lastYieldedSeq = 0;
    const seqIter = this.seqWatch.changes()[Symbol.asyncIterator]();
    while (true) {
      // Drain everything above lastYieldedSeq.
      const batch = this.drain();
      for (const item of batch) {
        yield item;
        lastYieldedSeq = Math.max(lastYieldedSeq, item.seq);
      }
      if (this.closed && this.sentinelEmitted) return;
      const step = await seqIter.next();
      if (step.done) return;
    }
  }
}

/** AgentExitedSentinel type-guard. */
export function isAgentExitedSentinel(
  item: MailboxItem,
): item is AgentExitedSentinel {
  return (item as { type?: string }).type === "agent_exited";
}
