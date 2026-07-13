import { describe, expect, test } from "vitest";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
} from "../../src/tui/session-transcript.js";

// Coalescing streaming deltas into one appendBatch must be BEHAVIOURALLY
// identical to dispatching them one-by-one — same stored events, same rendered
// transcript, same dedup — while doing one array copy + one projection instead
// of O(n²). This guards the OOM fix from regressing the streaming semantics.
describe("transcript delta coalescing (appendBatch)", () => {
  const delta = (seq: number, text: string) => ({
    type: "agent_message_delta" as const,
    seq,
    payload: { delta: text },
  });

  test("batched appends equal sequential appends (events + projection)", () => {
    const deltas = Array.from({ length: 50 }, (_, i) => delta(i, `t${i} `));

    let sequential = createSessionTranscriptStateForTesting([]);
    for (const d of deltas) {
      sequential = appendSessionTranscriptEventForTesting(sequential, d as never);
    }

    const batched = appendSessionTranscriptBatchForTesting(
      createSessionTranscriptStateForTesting([]),
      deltas as never,
    );

    expect(batched.events.length).toBe(sequential.events.length);
    expect(adaptTranscriptEvents(batched.events)).toEqual(
      adaptTranscriptEvents(sequential.events),
    );
    // The concatenated streaming text survives intact.
    const text = JSON.stringify(adaptTranscriptEvents(batched.events));
    expect(text).toContain("t0 ");
    expect(text).toContain("t49 ");
  });

  test("dedups within a batch and against existing events", () => {
    const base = appendSessionTranscriptBatchForTesting(
      createSessionTranscriptStateForTesting([]),
      [delta(0, "a "), delta(1, "b ")] as never,
    );
    // Re-send seq 1 plus a new seq 2 — seq 1 must not duplicate.
    const next = appendSessionTranscriptBatchForTesting(base, [
      delta(1, "b "),
      delta(2, "c "),
    ] as never);
    expect(next.events.length).toBe(3);
  });

  test("an empty batch is a no-op (same state reference)", () => {
    const state = createSessionTranscriptStateForTesting([delta(0, "x ") as never]);
    expect(appendSessionTranscriptBatchForTesting(state, [])).toBe(state);
  });
});
