/**
 * Bounded, loss-reporting buffer for not-yet-consumed prompt events.
 *
 * Shared by the socket-backed (`client.ts`) and subprocess-backed
 * (`subprocess.ts`) prompt runs so both transports honour one public loss
 * contract: memory stays bounded at {@link MAX_BUFFERED_PROMPT_EVENTS}
 * entries, and every event this process discards is accounted for by a
 * `gap` event with `reason: "local_overflow"` that the consumer receives in
 * the position of the discarded events. The marker is derived from a running
 * loss counter rather than stored as a queue entry, so no amount of further
 * overflow can evict it.
 */

import type { AgencPromptEvent } from "./events.js";

/** Cap on internally buffered, not-yet-consumed prompt events. */
export const MAX_BUFFERED_PROMPT_EVENTS = 1_000;

export type AgencLocalOverflowGapEvent = Extract<
  AgencPromptEvent,
  { type: "gap"; reason: "local_overflow" }
>;

export interface PromptEventQueue {
  /** Entries the consumer has not received yet, including a pending overflow marker. */
  readonly length: number;
  /** Events discarded since the last overflow marker was delivered. */
  readonly pendingLoss: number;
  /**
   * Buffer one event. Past the cap the oldest buffered event is discarded
   * and counted towards the next overflow marker.
   */
  push(event: AgencPromptEvent): void;
  /**
   * Next event for the consumer: a pending overflow marker first, otherwise
   * the oldest buffered event. `undefined` when nothing is pending.
   */
  shift(): AgencPromptEvent | undefined;
}

export interface PromptEventQueueOptions {
  /** Session the run belongs to, when known at delivery time. */
  readonly sessionId?: () => string | undefined;
  readonly capacity?: number;
}

export function createPromptEventQueue(
  options: PromptEventQueueOptions = {},
): PromptEventQueue {
  const capacity = options.capacity ?? MAX_BUFFERED_PROMPT_EVENTS;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("prompt event queue capacity must be a positive integer");
  }
  const buffered: AgencPromptEvent[] = [];
  let lost = 0;
  // Highest daemon sequence handed to the consumer so far. A local gap tells
  // the consumer exactly which durable range it must replay, so this must
  // only ever advance on delivered events, never on evicted ones.
  let deliveredSequence: number | undefined;

  const overflowMarker = (): AgencLocalOverflowGapEvent => {
    const next = buffered[0];
    const sessionId = options.sessionId?.();
    return {
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(next?.runId !== undefined ? { runId: next.runId } : {}),
      ...(deliveredSequence !== undefined
        ? { afterSequence: deliveredSequence }
        : {}),
      ...(next?.sequence !== undefined
        ? { firstAvailableSequence: next.sequence }
        : {}),
      retiredCount: lost,
    };
  };

  return {
    get length() {
      return buffered.length + (lost > 0 ? 1 : 0);
    },
    get pendingLoss() {
      return lost;
    },
    push(event) {
      buffered.push(event);
      while (buffered.length > capacity) {
        buffered.shift();
        lost += 1;
      }
    },
    shift() {
      if (lost > 0) {
        const marker = overflowMarker();
        lost = 0;
        return marker;
      }
      const event = buffered.shift();
      if (event?.sequence !== undefined) deliveredSequence = event.sequence;
      return event;
    },
  };
}
