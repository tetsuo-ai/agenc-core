import { describe, expect, it } from "vitest";
import {
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

// session-transcript.ts:2771 (core-todo.md): the `append` reducer mutated the
// previous state's key Set in place. React StrictMode double-invokes reducers
// with the same prev state; the first invoke's mutation made the second invoke
// see the key as present and early-return, dropping the event from the render.

const ev = (seq: number): SessionTranscriptEvent =>
  ({ type: "test_event", seq }) as SessionTranscriptEvent;

describe("session-transcript append reducer purity", () => {
  it("does not mutate the previous state; StrictMode double-invoke keeps the event", () => {
    const s0 = createSessionTranscriptStateForTesting([ev(1)]);
    const keysBefore = [...s0.keys].sort();

    // StrictMode invokes the reducer twice with the SAME prev state.
    const first = appendSessionTranscriptEventForTesting(s0, ev(2));
    const second = appendSessionTranscriptEventForTesting(s0, ev(2));

    // Purity: the input state's key Set must be untouched, and the result must
    // be a fresh Set (not the same reference).
    expect([...s0.keys].sort()).toEqual(keysBefore);
    expect(first.keys).not.toBe(s0.keys);

    // Both invocations must commit the appended event — with the in-place
    // mutation the second invoke drops it (length 1).
    expect(first.events.length).toBe(2);
    expect(second.events.length).toBe(2);
  });
});
