/**
 * Mailbox — bidirectional typed queue for inter-agent communication.
 *
 * Hand-port of reference runtime `core/src/agent/mailbox.rs` (161 LOC) adapted
 * for AgenC's bounded + backpressure model. The reference implementation uses
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
 *     fires first, the oldest passive message is dropped, the overflow is
 *     promoted, and the I-8 backpressure warning fires. Turn-triggering
 *     messages are control records: once accepted they are never displaced
 *     by later traffic or timer eviction.
 *   - **Receiver-closed sentinel** (I-31) — after `close()`, already accepted
 *     queue and salvage-window records drain in FIFO order before one
 *     `agent_exited` sentinel. Sender rejects new sends with
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
/**
 * Aggregate serialized passive envelopes retained before the next task.
 * Later passive messages are rejected with a visible omission marker rather
 * than allowing unbounded content or metadata to accumulate.
 */
export const MAX_MAILBOX_PASSIVE_BYTES = 1_048_576;
export const MAX_MAILBOX_TRIGGER_BYTES = 65_536;
export const MAX_MAILBOX_TRIGGER_ENVELOPE_BYTES =
  MAX_MAILBOX_TRIGGER_BYTES * 2 + 16_384;
const MAX_MAILBOX_OMISSION_RANGES = 128;

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

/** Normalize bounded Mailbox and legacy session-mailbox send contracts. */
export function isMailboxSendAccepted(result: unknown): boolean {
  if (typeof result === "number") return result >= 0;
  return result === "sent";
}

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

/** The bounded mailbox could not safely admit a turn-triggering message. */
export class MailboxCapacityError extends Error {
  constructor(public readonly threadId: string) {
    super(`mailbox for ${threadId} has no safe capacity for a turn trigger`);
    this.name = "MailboxCapacityError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Mailbox
// ─────────────────────────────────────────────────────────────────────

export interface MailboxOpts {
  readonly threadId: string;
  readonly maxDepth?: number;
  readonly maxPassiveBytes?: number;
  /** Called when backpressure drops a message (I-16). */
  readonly onDrop?: (dropped: InterAgentCommunication) => void;
  /** Called once per drop streak for I-8 warning. */
  readonly onBackpressureStreak?: (count: number) => void;
}

export class Mailbox {
  readonly threadId: string;
  readonly seqWatch: BehaviorSubject<number>;
  private readonly maxDepth: number;
  private readonly maxPassiveBytes: number;
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
  private queuedPassiveBytes = 0;
  private readonly passiveBytesBySeq = new Map<number, number>();
  private readonly passiveOmissions: Array<{
    firstSeq: number;
    lastSeq: number;
    count: number;
    bytes: number;
    recipient: string;
  }> = [];

  constructor(opts: MailboxOpts) {
    this.threadId = opts.threadId;
    this.maxDepth = opts.maxDepth ?? MAX_MAILBOX_DEPTH;
    this.maxPassiveBytes = opts.maxPassiveBytes ?? MAX_MAILBOX_PASSIVE_BYTES;
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
   * A closed mailbox throws `MailboxClosedError`. Passive traffic may be
   * dropped under pressure. Turn triggers are admitted only when they can be
   * retained until drain: an accepted trigger is never displaced by a later
   * send or by the overflow timer. If no such capacity exists, the trigger is
   * rejected synchronously with `'dropped'`, allowing its caller to roll back
   * any admission state.
   */
  send(msg: Omit<InterAgentCommunication, "seq">): SendResult {
    if (this.closed) {
      throw new MailboxClosedError(this.threadId);
    }
    this.nextSeq += 1;
    const seq = this.nextSeq;
    const normalized = normalizeMailboxMessage(msg, seq);
    if (normalized === null) {
      const rejected: InterAgentCommunication = { ...msg, seq };
      this.dropMessage(rejected);
      return "dropped";
    }
    const { message: next, bytes: nextPayloadBytes } = normalized;
    const nextPassiveBytes = next.triggerTurn ? 0 : nextPayloadBytes;
    if (
      next.triggerTurn &&
      (mailboxTriggerInputBytes(next) > MAX_MAILBOX_TRIGGER_BYTES ||
        nextPayloadBytes > MAX_MAILBOX_TRIGGER_ENVELOPE_BYTES)
    ) {
      this.dropMessage(next);
      return "dropped";
    }
    if (
      !next.triggerTurn &&
      (nextPassiveBytes > this.maxPassiveBytes ||
        this.queuedPassiveBytes + nextPassiveBytes > this.maxPassiveBytes)
    ) {
      this.recordPassiveOmission(next, nextPassiveBytes);
      this.dropMessage(next, true);
      return "dropped";
    }

    if (this.queue.length >= this.maxDepth) {
      const hasDroppableQueuedMessage = this.queue.some(
        (message) => !message.triggerTurn,
      );

      if (this.overflow !== null) {
        // Preserve the single overflow seat and FIFO for passive traffic.
        // A later trigger may replace a passive overflow entry only when a
        // passive queue entry can eventually make room for it. An accepted
        // trigger in overflow is never displaced.
        if (
          next.triggerTurn &&
          !this.overflow.triggerTurn &&
          hasDroppableQueuedMessage
        ) {
          this.dropMessage(this.overflow);
          this.overflow = next;
          this.retainPassiveBytes(next, nextPassiveBytes);
          this.armOverflowTimer();
          this.seqWatch.next(seq);
          return "sent";
        }
        this.dropMessage(next);
        return "dropped";
      }

      // A trigger parked in overflow needs one passive queue entry that the
      // timer may evict. If every queued entry is itself a trigger, accepting
      // another would create an undeliverable control record.
      if (next.triggerTurn && !hasDroppableQueuedMessage) {
        this.dropMessage(next);
        return "dropped";
      }

      this.overflow = next;
      this.retainPassiveBytes(next, nextPassiveBytes);
      this.armOverflowTimer();
      this.seqWatch.next(seq);
      return "sent";
    }

    if (this.droppedStreak > 0) {
      // Recovery: drop streak broken.
      this.droppedStreak = 0;
    }
    this.queue.push(next);
    this.retainPassiveBytes(next, nextPassiveBytes);
    this.seqWatch.next(seq);
    return "sent";
  }

  /** I-16 bookkeeping for a dropped message (async I-8 warning). */
  private dropMessage(
    dropped: InterAgentCommunication,
    omissionAlreadyRecorded = false,
  ): void {
    if (!dropped.triggerTurn && !omissionAlreadyRecorded) {
      this.recordPassiveOmission(
        dropped,
        this.passiveBytesBySeq.get(dropped.seq) ??
          mailboxInputPayloadBytes(dropped),
      );
    }
    this.releasePassiveBytes(dropped);
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

  private retainPassiveBytes(
    message: InterAgentCommunication,
    bytes = mailboxInputPayloadBytes(message),
  ): void {
    if (message.triggerTurn || this.passiveBytesBySeq.has(message.seq)) return;
    this.passiveBytesBySeq.set(message.seq, bytes);
    this.queuedPassiveBytes += bytes;
  }

  private releasePassiveBytes(message: InterAgentCommunication): void {
    const retainedBytes = this.passiveBytesBySeq.get(message.seq);
    if (retainedBytes === undefined) return;
    this.passiveBytesBySeq.delete(message.seq);
    this.queuedPassiveBytes = Math.max(
      0,
      this.queuedPassiveBytes - retainedBytes,
    );
  }

  private recordPassiveOmission(
    message: InterAgentCommunication,
    bytes: number,
  ): void {
    const containing = this.passiveOmissions.find(
      (omission) =>
        omission.firstSeq <= message.seq && omission.lastSeq >= message.seq,
    );
    if (containing !== undefined) {
      containing.count += 1;
      containing.bytes += bytes;
      return;
    }
    const insertionIndex = this.passiveOmissions.findIndex(
      (omission) => omission.firstSeq > message.seq,
    );
    const index =
      insertionIndex < 0 ? this.passiveOmissions.length : insertionIndex;
    const previous = this.passiveOmissions[index - 1];
    const next = this.passiveOmissions[index];
    if (previous !== undefined && previous.lastSeq + 1 === message.seq) {
      previous.lastSeq = message.seq;
      previous.count += 1;
      previous.bytes += bytes;
      if (next !== undefined && previous.lastSeq + 1 === next.firstSeq) {
        previous.lastSeq = next.lastSeq;
        previous.count += next.count;
        previous.bytes += next.bytes;
        this.passiveOmissions.splice(index, 1);
      }
      return;
    }
    if (next !== undefined && message.seq + 1 === next.firstSeq) {
      next.firstSeq = message.seq;
      next.count += 1;
      next.bytes += bytes;
      return;
    }
    this.passiveOmissions.splice(index, 0, {
      firstSeq: message.seq,
      lastSeq: message.seq,
      count: 1,
      bytes,
      recipient: message.recipient,
    });
    if (this.passiveOmissions.length > MAX_MAILBOX_OMISSION_RANGES) {
      const first = this.passiveOmissions[0]!;
      const second = this.passiveOmissions[1]!;
      first.lastSeq = second.lastSeq;
      first.count += second.count;
      first.bytes += second.bytes;
      this.passiveOmissions.splice(1, 1);
    }
  }

  private appendPassiveOmissionIfReady(items: InterAgentCommunication[]): void {
    if (this.passiveOmissions.length === 0 || items.length === 0) return;
    const highestSeq = items.reduce(
      (highest, item) => Math.max(highest, item.seq),
      0,
    );
    const ready = this.passiveOmissions.filter(
      (omission) => omission.lastSeq <= highestSeq,
    );
    if (ready.length === 0) return;
    for (const omission of ready) {
      const marker: InterAgentCommunication = {
        author: "mailbox",
        recipient: omission.recipient,
        content:
          `[mailbox_backpressure: omitted ${omission.count} passive ` +
          `message(s), ${omission.bytes} UTF-8 byte(s), before this task]`,
        triggerTurn: false,
        direction: "down",
        seq: omission.firstSeq,
        metadata: {
          kind: "mailbox_omission",
          omittedCount: omission.count,
          omittedBytes: omission.bytes,
        },
      };
      const insertionIndex = items.findIndex(
        (item) => item.seq > omission.firstSeq,
      );
      if (insertionIndex < 0) items.push(marker);
      else items.splice(insertionIndex, 0, marker);
    }
    this.passiveOmissions.splice(0, ready.length);
  }

  private armOverflowTimer(): void {
    if (this.overflowTimer !== null) {
      clearTimeout(this.overflowTimer);
    }
    this.overflowTimer = setTimeout(() => {
      this.overflowTimer = null;
      if (this.closed || this.overflow === null) return;
      // Timer fired before any drain salvaged us. Never evict a turn trigger:
      // remove the oldest passive entry and retain FIFO among survivors.
      const droppableIndex = this.queue.findIndex(
        (message) => !message.triggerTurn,
      );
      if (droppableIndex < 0) {
        // A passive overflow message can be sacrificed. A triggering overflow
        // should be unreachable by admission, but retaining it is the
        // fail-closed behavior if queue state ever violates that invariant.
        if (!this.overflow.triggerTurn) {
          const dropped = this.overflow;
          this.overflow = null;
          this.dropMessage(dropped);
        }
        return;
      }
      const [dropped] = this.queue.splice(droppableIndex, 1);
      if (dropped) this.dropMessage(dropped);
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
    return (
      this.queue.some((m) => m.triggerTurn) ||
      this.overflow?.triggerTurn === true
    );
  }

  /**
   * Drain only the bounded FIFO prefix through the first turn-triggering
   * message. Passive context after that trigger remains in this Mailbox, where
   * normal depth/backpressure limits continue to apply until a later task.
   *
   * If the mailbox closes before a trigger arrives, drain the remaining
   * context plus the exit sentinel so a parked worker can tear down cleanly.
   */
  drainThroughFirstTrigger(): ReadonlyArray<MailboxItem> {
    const triggerIndex = this.queue.findIndex((item) => item.triggerTurn);
    let items: InterAgentCommunication[];
    if (triggerIndex >= 0) {
      items = this.queue.splice(0, triggerIndex + 1);
      for (const item of items) this.releasePassiveBytes(item);
      this.appendPassiveOmissionIfReady(items);
      this.promoteOverflowAfterPartialDrain();
    } else if (this.overflow?.triggerTurn === true) {
      items = this.queue.splice(0);
      for (const item of items) this.releasePassiveBytes(item);
      const trigger = this.overflow;
      this.overflow = null;
      this.clearOverflowTimer();
      items.push(trigger);
      this.appendPassiveOmissionIfReady(items);
      this.droppedStreak = 0;
    } else if (this.closed) {
      items = this.queue.splice(0);
      for (const item of items) this.releasePassiveBytes(item);
      if (this.overflow !== null) {
        const salvaged = this.overflow;
        this.overflow = null;
        this.clearOverflowTimer();
        items.push(salvaged);
        this.releasePassiveBytes(salvaged);
        this.droppedStreak = 0;
      }
      this.appendPassiveOmissionIfReady(items);
    } else {
      return [];
    }
    this.appendCloseSentinelIfReady(items);
    return items;
  }

  private promoteOverflowAfterPartialDrain(): void {
    if (this.overflow === null || this.queue.length >= this.maxDepth) return;
    const promoted = this.overflow;
    this.overflow = null;
    this.clearOverflowTimer();
    this.queue.push(promoted);
    this.droppedStreak = 0;
  }

  private appendCloseSentinelIfReady(items: MailboxItem[]): void {
    if (
      !this.closed ||
      this.sentinelEmitted ||
      this.queue.length > 0 ||
      this.overflow !== null
    ) {
      return;
    }
    this.sentinelEmitted = true;
    this.nextSeq += 1;
    items.push({
      type: "agent_exited",
      threadId: this.threadId,
      seq: this.nextSeq,
      ...(this.finalStatus !== undefined
        ? { finalStatus: this.finalStatus }
        : {}),
    });
  }

  /**
   * Remove + return all queued items in FIFO order. I-31: after the
   * mailbox is closed, the first drain returns the `agent_exited`
   * sentinel (exactly once); subsequent drains return [].
   */
  drain(): ReadonlyArray<MailboxItem> {
    const items: InterAgentCommunication[] = this.queue.splice(0);
    for (const item of items) this.releasePassiveBytes(item);
    // I-16: drain just freed space — salvage the overflow slot
    // (if any) rather than dropping it when the timer fires.
    // The salvaged message joins this drain at the tail to
    // preserve FIFO vs. the just-drained items.
    if (this.overflow !== null) {
      const salvaged = this.overflow;
      this.overflow = null;
      this.clearOverflowTimer();
      items.push(salvaged);
      this.releasePassiveBytes(salvaged);
      // drop streak ends on successful salvage
      this.droppedStreak = 0;
    }
    this.appendPassiveOmissionIfReady(items as InterAgentCommunication[]);
    this.appendCloseSentinelIfReady(items);
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
    // I-16: any pending salvage timer must not fire post-close. The accepted
    // overflow record remains retained and is drained before the sentinel.
    this.clearOverflowTimer();
    // Closing is itself a receiver-visible transition. Wake sequence waiters
    // so they can drain the sentinel instead of parking until an unrelated
    // abort or timeout. The sentinel will claim this next sequence number.
    this.seqWatch.next(this.nextSeq + 1);
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

  get passiveBytes(): number {
    return this.queuedPassiveBytes;
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

function mailboxInputPayloadBytes(
  message: Pick<
    InterAgentCommunication,
    | "author"
    | "recipient"
    | "content"
    | "triggerTurn"
    | "direction"
    | "metadata"
  >,
): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function mailboxTriggerInputBytes(
  message: Pick<InterAgentCommunication, "content" | "metadata">,
): number {
  const contentBytes = Buffer.byteLength(message.content, "utf8");
  const inputContent = message.metadata?.inputContent;
  if (typeof inputContent === "string") {
    return Math.max(contentBytes, Buffer.byteLength(inputContent, "utf8"));
  }
  if (Array.isArray(inputContent)) {
    let partBytes = 0;
    for (const part of inputContent) {
      partBytes += mailboxStringLeafBytes(part);
    }
    return Math.max(contentBytes, partBytes);
  }
  return contentBytes;
}

function mailboxStringLeafBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry) => total + mailboxStringLeafBytes(entry),
      0,
    );
  }
  return Object.values(value).reduce(
    (total, entry) => total + mailboxStringLeafBytes(entry),
    0,
  );
}

function normalizeMailboxMessage(
  message: Omit<InterAgentCommunication, "seq">,
  seq: number,
): {
  readonly message: InterAgentCommunication;
  readonly bytes: number;
} | null {
  if (!isJsonMailboxValue(message, new WeakSet<object>())) return null;
  try {
    const serialized = JSON.stringify(message);
    const bytes = Buffer.byteLength(serialized, "utf8");
    return {
      message: {
        ...(JSON.parse(serialized) as Omit<InterAgentCommunication, "seq">),
        seq,
      },
      bytes,
    };
  } catch {
    return null;
  }
}

function isJsonMailboxValue(value: unknown, seen: WeakSet<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (value === undefined) return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    if (!isJsonMailboxValue(entry, seen)) return false;
  }
  seen.delete(value);
  return true;
}
