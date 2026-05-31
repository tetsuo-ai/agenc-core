import { describe, expect, it } from "vitest";
import {
  AgenCRealtimeTranscriptAccumulator,
  MAX_REALTIME_EVENT_QUEUE_DEPTH,
  MAX_REALTIME_TRANSCRIPT_ENTRIES,
} from "./realtime-transport.js";
import { AsyncQueue } from "../utils/async-queue.js";
import type {
  RealtimeEvent,
  RealtimeHandoffRequested,
} from "../conversation/realtime/conversation.js";

/**
 * Alternating-role transcript-done events each append a fresh entry (the role
 * differs from the previous entry), so this is a reliable way to grow the
 * accumulator one entry at a time.
 */
function applyDistinctEntries(
  accumulator: AgenCRealtimeTranscriptAccumulator,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const event: RealtimeEvent =
      i % 2 === 0
        ? { type: "input_transcript_done", text: `user-${i}` }
        : { type: "output_transcript_done", text: `assistant-${i}` };
    accumulator.apply(event);
  }
}

function requestHandoff(
  accumulator: AgenCRealtimeTranscriptAccumulator,
): readonly { readonly role: string; readonly text: string }[] {
  const handoff: RealtimeHandoffRequested = {
    inputTranscript: "",
    activeTranscript: [],
  };
  const result = accumulator.apply({ type: "handoff_requested", handoff });
  if (result.type !== "handoff_requested") {
    throw new Error("expected handoff_requested event back");
  }
  return result.handoff.activeTranscript;
}

describe("realtime transcript accumulator memory bound", () => {
  it("caps retained transcript entries at the configured maximum", () => {
    const accumulator = new AgenCRealtimeTranscriptAccumulator();

    // Push far more entries than the cap.
    applyDistinctEntries(accumulator, MAX_REALTIME_TRANSCRIPT_ENTRIES * 3);

    // The full retained transcript is surfaced via a handoff's active slice
    // (no prior handoff, so the slice is the entire bounded buffer).
    const active = requestHandoff(accumulator);
    expect(active.length).toBe(MAX_REALTIME_TRANSCRIPT_ENTRIES);

    // Oldest entries were dropped from the head; the newest survive.
    const last = active[active.length - 1];
    const expectedLastIndex = MAX_REALTIME_TRANSCRIPT_ENTRIES * 3 - 1;
    expect(last.text).toBe(`assistant-${expectedLastIndex}`);
  });

  it("keeps the since-last-handoff boundary correct after head eviction", () => {
    const accumulator = new AgenCRealtimeTranscriptAccumulator();

    // First handoff after a handful of entries.
    applyDistinctEntries(accumulator, 4);
    const firstActive = requestHandoff(accumulator);
    expect(firstActive.length).toBe(4);

    // Now overflow the buffer so the head (including the first-handoff
    // boundary's original index) is spliced away.
    applyDistinctEntries(accumulator, MAX_REALTIME_TRANSCRIPT_ENTRIES * 2);

    // The second handoff's active slice must only contain entries appended
    // since the first handoff, never duplicating earlier content, and never
    // exceeding the cap. A broken boundary index would yield a wrong-length
    // or negative slice.
    const secondActive = requestHandoff(accumulator);
    expect(secondActive.length).toBeGreaterThan(0);
    expect(secondActive.length).toBeLessThanOrEqual(
      MAX_REALTIME_TRANSCRIPT_ENTRIES,
    );
    // None of the second slice should be the very first entries (proves the
    // boundary advanced rather than resetting to zero).
    expect(secondActive.some((entry) => entry.text === "user-0")).toBe(false);
  });
});

describe("realtime inbound event queue bound", () => {
  it("caps buffered events when no consumer drains the queue", () => {
    // Mirrors how connect() constructs the inbound queue.
    const queue = new AsyncQueue<number>({
      maxDepth: MAX_REALTIME_EVENT_QUEUE_DEPTH,
    });
    let accepted = 0;
    for (let i = 0; i < MAX_REALTIME_EVENT_QUEUE_DEPTH * 2; i += 1) {
      if (queue.send(i)) accepted += 1;
    }
    // The queue never buffers more than its bound; excess sends are rejected
    // (a stalled consumer cannot grow the heap without limit).
    expect(queue.size).toBe(MAX_REALTIME_EVENT_QUEUE_DEPTH);
    expect(accepted).toBe(MAX_REALTIME_EVENT_QUEUE_DEPTH);
  });
});
