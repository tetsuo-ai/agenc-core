/**
 * Unit tests for the SDK's shared bounded prompt-event queue
 * (`packages/agenc-sdk/src/prompt-event-queue.ts`): the one loss contract
 * behind both the socket and subprocess transports (#2090).
 */

import { describe, expect, it } from "vitest";
import {
  createPromptEventQueue,
  MAX_BUFFERED_PROMPT_EVENTS,
} from "../../../packages/agenc-sdk/src/prompt-event-queue";
import type { AgencPromptEvent } from "../../../packages/agenc-sdk/src/index";

function text(index: number, sequence = index): AgencPromptEvent {
  return {
    type: "text",
    delta: `d${index}`,
    eventId: `e${index}`,
    sequence,
    runId: "run_1",
  };
}

function drain(queue: { length: number; shift(): AgencPromptEvent | undefined }) {
  const out: AgencPromptEvent[] = [];
  while (queue.length > 0) out.push(queue.shift()!);
  return out;
}

describe("agenc-sdk prompt event queue", () => {
  it("preserves order and emits no marker at or below the cap", () => {
    const queue = createPromptEventQueue({ sessionId: () => "session_1" });
    for (let i = 1; i <= MAX_BUFFERED_PROMPT_EVENTS; i += 1) queue.push(text(i));
    expect(queue.length).toBe(MAX_BUFFERED_PROMPT_EVENTS);
    expect(queue.pendingLoss).toBe(0);

    const drained = drain(queue);
    expect(drained.map((event) => event.eventId)).toEqual(
      Array.from({ length: MAX_BUFFERED_PROMPT_EVENTS }, (_, i) => `e${i + 1}`),
    );
    expect(drained.some((event) => event.type === "gap")).toBe(false);
  });

  it("never lets event 1001 silently evict event 1", () => {
    const queue = createPromptEventQueue({ sessionId: () => "session_1" });
    for (let i = 1; i <= MAX_BUFFERED_PROMPT_EVENTS + 1; i += 1) queue.push(text(i));

    const first = queue.shift();
    expect(first).toEqual({
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      sessionId: "session_1",
      runId: "run_1",
      firstAvailableSequence: 2,
      retiredCount: 1,
    });
    expect(queue.shift()).toMatchObject({ eventId: "e2" });
  });

  it("keeps memory bounded and the loss count exact when nothing is ever drained", () => {
    const queue = createPromptEventQueue({ sessionId: () => "session_1" });
    const total = 25_000;
    for (let i = 1; i <= total; i += 1) {
      queue.push(text(i));
      // Buffered events plus at most one pending marker.
      expect(queue.length).toBeLessThanOrEqual(MAX_BUFFERED_PROMPT_EVENTS + 1);
    }
    expect(queue.pendingLoss).toBe(total - MAX_BUFFERED_PROMPT_EVENTS);

    const drained = drain(queue);
    expect(drained).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    expect(drained[0]).toMatchObject({
      type: "gap",
      reason: "local_overflow",
      retiredCount: total - MAX_BUFFERED_PROMPT_EVENTS,
      firstAvailableSequence: total - MAX_BUFFERED_PROMPT_EVENTS + 1,
    });
    expect(drained[0]).not.toHaveProperty("afterSequence");
    expect(drained.at(-1)).toMatchObject({ eventId: `e${total}` });
  });

  it("places the marker exactly where the loss happened for a slow consumer", () => {
    const queue = createPromptEventQueue({ sessionId: () => "session_1" });
    for (let i = 1; i <= 10; i += 1) queue.push(text(i));
    const consumedFirst = [queue.shift(), queue.shift(), queue.shift()];
    expect(consumedFirst.map((event) => event?.eventId)).toEqual(["e1", "e2", "e3"]);

    // 7 still buffered; 1,200 more overflow the cap by 207.
    for (let i = 11; i <= 1_210; i += 1) queue.push(text(i));

    const rest = drain(queue);
    expect(rest[0]).toEqual({
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      sessionId: "session_1",
      runId: "run_1",
      afterSequence: 3,
      firstAvailableSequence: 211,
      retiredCount: 207,
    });
    expect(rest).toHaveLength(MAX_BUFFERED_PROMPT_EVENTS + 1);
    expect(rest[1]).toMatchObject({ eventId: "e211" });
    expect(rest.at(-1)).toMatchObject({ eventId: "e1210" });
    expect(rest.filter((event) => event.type === "gap")).toHaveLength(1);
  });

  it("reports each distinct loss window with its own marker", () => {
    const queue = createPromptEventQueue({ sessionId: () => "session_1" });
    for (let i = 1; i <= MAX_BUFFERED_PROMPT_EVENTS + 5; i += 1) queue.push(text(i));
    expect(queue.shift()).toMatchObject({ type: "gap", retiredCount: 5 });
    expect(queue.shift()).toMatchObject({ eventId: "e6" });
    expect(queue.pendingLoss).toBe(0);

    // 999 buffered now; 4 more pushes overflow by 3.
    for (let i = MAX_BUFFERED_PROMPT_EVENTS + 6; i <= MAX_BUFFERED_PROMPT_EVENTS + 9; i += 1) {
      queue.push(text(i));
    }
    expect(queue.shift()).toMatchObject({
      type: "gap",
      afterSequence: 6,
      firstAvailableSequence: 10,
      retiredCount: 3,
    });
    expect(queue.shift()).toMatchObject({ eventId: "e10" });
  });

  it("omits session and sequence coordinates it cannot vouch for", () => {
    const queue = createPromptEventQueue();
    for (let i = 1; i <= MAX_BUFFERED_PROMPT_EVENTS + 2; i += 1) {
      queue.push({ type: "text", delta: `d${i}` });
    }
    const marker = queue.shift();
    expect(marker).toEqual({
      type: "gap",
      kind: "event_gap",
      reason: "local_overflow",
      retiredCount: 2,
    });
  });

  it("rejects a non-positive capacity", () => {
    expect(() => createPromptEventQueue({ capacity: 0 })).toThrow(RangeError);
  });
});
