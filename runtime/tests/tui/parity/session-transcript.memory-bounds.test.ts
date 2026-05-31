import { describe, expect, test } from "vitest";

import {
  adaptTranscriptEvents,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  makeToolResultMessage,
  type SessionTranscriptEvent,
} from "../session-transcript.js";

// Keep these in lockstep with the constants in session-transcript.ts. They are
// intentionally private to the module; the assertions below only depend on the
// observable bounds they enforce, not their exact values.
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_EVENTS = 4000;
const TRUNCATION_MARKER = /\[\d+ bytes truncated\]/;

function toolCompletedEvent(
  index: number,
  resultBytes: number,
): SessionTranscriptEvent {
  return {
    id: `tool-${index}`,
    seq: index,
    msg: {
      type: "tool_call_completed",
      payload: {
        callId: `call-${index}`,
        toolName: "Bash",
        result: "x".repeat(resultBytes),
      },
    },
  } as SessionTranscriptEvent;
}

/** Sum of UTF-8 bytes of every retained tool-result string in the store. */
function retainedResultBytes(events: readonly SessionTranscriptEvent[]): number {
  let total = 0;
  for (const event of events) {
    const payload = (event as { msg?: { payload?: { result?: unknown } } }).msg
      ?.payload;
    if (payload && typeof payload.result === "string") {
      total += Buffer.byteLength(payload.result, "utf8");
    }
  }
  return total;
}

describe("session transcript memory bounds", () => {
  test("clamps a single huge tool-result's stored content", () => {
    const state = createSessionTranscriptStateForTesting([
      toolCompletedEvent(1, 5 * 1024 * 1024), // 5 MB
    ]);

    const stored = (
      state.events[0] as { msg: { payload: { result: string } } }
    ).msg.payload.result;

    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 64,
    );
    expect(stored).toMatch(TRUNCATION_MARKER);
    // The kept head is the real prefix of the original output.
    expect(stored.startsWith("x".repeat(1024))).toBe(true);
  });

  test("event count and retained bytes stay bounded across many large events", () => {
    let state = createSessionTranscriptStateForTesting([]);
    const totalEvents = MAX_TRANSCRIPT_EVENTS + 2500;

    for (let index = 1; index <= totalEvents; index += 1) {
      state = appendSessionTranscriptEventForTesting(
        state,
        toolCompletedEvent(index, 1 * 1024 * 1024), // 1 MB each
      );
    }

    // Event array is ring-buffered to the cap.
    expect(state.events.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_EVENTS);

    // Dedup key set is pruned alongside the events (not growing unbounded).
    expect(state.keys.size).toBeLessThanOrEqual(MAX_TRANSCRIPT_EVENTS);

    // Total retained bytes are bounded: capped events x capped per-result bytes,
    // NOT totalEvents x 1 MB (which would be gigabytes).
    const bytes = retainedResultBytes(state.events);
    const upperBound = (MAX_TRANSCRIPT_EVENTS + 1) * (MAX_TOOL_RESULT_BYTES + 64);
    expect(bytes).toBeLessThanOrEqual(upperBound);
    // Sanity: the naive unbounded store would have held ~totalEvents MB.
    expect(bytes).toBeLessThan(totalEvents * 1024 * 1024);
  });

  test("recent events survive eviction and remain renderable", () => {
    let state = createSessionTranscriptStateForTesting([]);
    const totalEvents = MAX_TRANSCRIPT_EVENTS + 500;

    for (let index = 1; index <= totalEvents; index += 1) {
      state = appendSessionTranscriptEventForTesting(
        state,
        toolCompletedEvent(index, 4096),
      );
    }

    const seqs = state.events.map(
      (event) => (event as { seq: number }).seq,
    );
    // Oldest events were dropped; newest events were retained.
    expect(seqs).not.toContain(1);
    expect(seqs).toContain(totalEvents);
    expect(seqs).toContain(totalEvents - 1);
    // Order is preserved and contiguous at the tail.
    expect(seqs[seqs.length - 1]).toBe(totalEvents);

    // The retained tail still adapts into renderable messages.
    const transcript = adaptTranscriptEvents(state.events);
    expect(transcript.messages.length).toBeGreaterThan(0);
  });

  test("dedup still suppresses repeated events after capping", () => {
    let state = createSessionTranscriptStateForTesting([
      toolCompletedEvent(1, 128),
    ]);
    const before = state.events.length;

    // Re-appending the same event (same id/seq) is a no-op.
    state = appendSessionTranscriptEventForTesting(
      state,
      toolCompletedEvent(1, 128),
    );
    expect(state.events.length).toBe(before);

    // A genuinely new event still appends.
    state = appendSessionTranscriptEventForTesting(
      state,
      toolCompletedEvent(2, 128),
    );
    expect(state.events.length).toBe(before + 1);
  });

  test("small tool results are stored verbatim (no spurious truncation)", () => {
    const state = createSessionTranscriptStateForTesting([
      toolCompletedEvent(1, 256),
    ]);
    const stored = (
      state.events[0] as { msg: { payload: { result: string } } }
    ).msg.payload.result;
    expect(stored).toBe("x".repeat(256));
    expect(stored).not.toMatch(TRUNCATION_MARKER);
  });

  test("makeToolResultMessage clamps oversized string content", () => {
    const message = makeToolResultMessage("call-1", "y".repeat(2 * 1024 * 1024));
    const block = message.message.content[0];
    expect(typeof block.content).toBe("string");
    expect(Buffer.byteLength(block.content, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 64,
    );
    expect(block.content).toMatch(TRUNCATION_MARKER);
  });

  test("makeToolResultMessage clamps oversized structured text blocks", () => {
    const message = makeToolResultMessage("call-2", [
      { type: "text", text: "z".repeat(2 * 1024 * 1024) },
    ]);
    const block = message.message.content[0];
    const inner = block.content[0];
    expect(inner.type).toBe("text");
    expect(Buffer.byteLength(inner.text, "utf8")).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_BYTES + 64,
    );
    expect(inner.text).toMatch(TRUNCATION_MARKER);
  });

  test("history_replaced reset payload is never rewritten", () => {
    // Authoritative rollout snapshots must round-trip verbatim, even when large.
    const bigText = "h".repeat(2 * 1024 * 1024);
    const state = createSessionTranscriptStateForTesting([
      {
        id: "replace-1",
        seq: 1,
        type: "history_replaced",
        payload: {
          messages: [
            {
              type: "user",
              message: { role: "user", content: bigText },
            },
          ],
        },
      } as SessionTranscriptEvent,
    ]);

    const stored = state.events[0] as {
      payload: { messages: { message: { content: string } }[] };
    };
    expect(stored.payload.messages[0]!.message.content).toBe(bigText);
  });
});
