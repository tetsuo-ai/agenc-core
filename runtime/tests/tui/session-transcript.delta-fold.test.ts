import { describe, expect, test } from "vitest";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
} from "../../src/tui/session-transcript.js";

// A max-effort turn streams tens of thousands of reasoning deltas. Each one
// used to take a slot in the 4000-event transcript window, so a long think
// evicted the conversation itself: the screen kept only the last rows and
// went blank above the working line. Deltas now fold into one stored event
// per run, and the projection must not change.

type Event = { type: string; seq: number; payload: Record<string, unknown> };

const at = (seq: number, type: string, payload: Record<string, unknown>): Event => ({
  type,
  seq,
  payload,
});

function conversationThenLongThink(deltaCount: number): Event[] {
  const events: Event[] = [
    at(1, "user_message", { message: "first prompt" }),
    at(2, "turn_started", { turnId: "turn-1" }),
    at(3, "agent_message", { message: "First answer." }),
    at(4, "turn_complete", { turnId: "turn-1", lastAgentMessage: "First answer." }),
    at(5, "user_message", { message: "think hard" }),
    at(6, "turn_started", { turnId: "turn-2" }),
    at(7, "assistant_thinking_block_start", { index: 0, kind: "reasoning_summary" }),
  ];
  for (let i = 0; i < deltaCount; i += 1) {
    events.push(
      at(8 + i, "assistant_thinking_delta", { delta: `t${i} `, kind: "reasoning_summary" }),
    );
  }
  return events;
}

/** A projection with its per-call random ids and clock readings masked. */
function projection(events: readonly unknown[]): string {
  return JSON.stringify(adaptTranscriptEvents(events as never))
    .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"<random>"')
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<now>"')
    .replace(/"streamingEndedAt":\d+/g, '"streamingEndedAt":"<now>"');
}

function userRows(events: readonly unknown[]): string[] {
  return adaptTranscriptEvents(events as never)
    .messages.filter((message: { type?: string }) => message.type === "user")
    .map((message: { message?: { content?: unknown } }) => String(message.message?.content));
}

describe("transcript store folds stream deltas", () => {
  test("a 20,000-delta think keeps the conversation in the store", () => {
    const events = conversationThenLongThink(20_000);
    let batched = createSessionTranscriptStateForTesting([]);
    for (let i = 0; i < events.length; i += 50) {
      batched = appendSessionTranscriptBatchForTesting(batched, events.slice(i, i + 50) as never);
    }

    expect(batched.events.length).toBeLessThan(20);
    expect(userRows(batched.events)).toEqual(["first prompt", "think hard"]);
    const thinking = adaptTranscriptEvents(batched.events as never).streamingThinking;
    expect(thinking?.thinking.startsWith("t0 t1 t2 ")).toBe(true);
    expect(thinking?.thinking.endsWith("t19999 ")).toBe(true);
  });

  test("folding projects the same transcript as the raw events", () => {
    const events = [
      ...conversationThenLongThink(30),
      at(100, "assistant_thinking_block_stop", { index: 0, kind: "reasoning_summary" }),
      at(101, "agent_message_delta", { delta: "Second " }),
      at(102, "agent_message_delta", { delta: "answer." }),
    ];
    let sequential = createSessionTranscriptStateForTesting([]);
    for (const event of events) {
      sequential = appendSessionTranscriptEventForTesting(sequential, event as never);
    }
    const rebuilt = createSessionTranscriptStateForTesting(events as never);
    const raw = projection(events);

    expect(sequential.events.length).toBeLessThan(events.length);
    expect(projection(sequential.events)).toBe(raw);
    expect(projection(rebuilt.events)).toBe(raw);
  });

  test("a replayed delta is not added again after folding", () => {
    const events = conversationThenLongThink(5);
    const state = appendSessionTranscriptBatchForTesting(
      createSessionTranscriptStateForTesting([]),
      events as never,
    );
    const expected = adaptTranscriptEvents(state.events as never).streamingThinking?.thinking;

    // Live append of an already folded delta.
    const replayedOne = appendSessionTranscriptEventForTesting(state, events[9] as never);
    expect(replayedOne).toBe(state);

    // A batch mixing a replay with an older out-of-order event forces a rebuild.
    const rebuilt = appendSessionTranscriptBatchForTesting(state, [
      events[8],
      events[10],
      at(0, "session_configured", { sessionId: "s" }),
    ] as never);
    expect(adaptTranscriptEvents(rebuilt.events as never).streamingThinking?.thinking).toBe(expected);
    expect(userRows(rebuilt.events)).toEqual(["first prompt", "think hard"]);
  });

  test("different streams do not fold together", () => {
    const state = createSessionTranscriptStateForTesting([
      at(1, "assistant_thinking_delta", { delta: "a", kind: "thinking" }),
      at(2, "assistant_thinking_delta", { delta: "b", kind: "reasoning_summary" }),
      at(3, "agent_message_delta", { delta: "c" }),
      at(4, "agent_message_delta", { delta: "d" }),
    ] as never);
    expect(state.events.length).toBe(3);
  });

  test("the phase-event shape folds and keeps its newest sequence", () => {
    const wrapped = (seq: number, delta: string) => ({
      id: `event-${seq}`,
      seq,
      msg: { type: "agent_message_delta", payload: { delta } },
    });
    const state = createSessionTranscriptStateForTesting([
      wrapped(1, "Hel"),
      wrapped(2, "lo"),
    ] as never);
    expect(state.events).toEqual([wrapped(2, "Hello")]);
    expect(state.keys.has("seq:1")).toBe(true);
    expect(adaptTranscriptEvents(state.events as never).streamingText).toBe("Hello");
  });

  test("a late delta lands between its neighbours on the append path and the batch path", () => {
    const delta = (seq: number, text: string) => at(seq, "agent_message_delta", { delta: text });
    const raw = projection([delta(1, "A"), delta(2, "B"), delta(3, "C")]);

    // Sequence 1 and 3 must not fold across the gap that 2 fills later.
    let appended = createSessionTranscriptStateForTesting([]);
    appended = appendSessionTranscriptEventForTesting(appended, delta(1, "A") as never);
    appended = appendSessionTranscriptEventForTesting(appended, delta(3, "C") as never);
    expect(appended.events.length).toBe(2);
    appended = appendSessionTranscriptEventForTesting(appended, delta(2, "B") as never);
    expect(adaptTranscriptEvents(appended.events as never).streamingText).toBe("ABC");
    expect(projection(appended.events)).toBe(raw);

    let batched = createSessionTranscriptStateForTesting([]);
    batched = appendSessionTranscriptBatchForTesting(batched, [delta(1, "A"), delta(3, "C")] as never);
    batched = appendSessionTranscriptBatchForTesting(batched, [delta(2, "B")] as never);
    expect(adaptTranscriptEvents(batched.events as never).streamingText).toBe("ABC");
    expect(projection(batched.events)).toBe(raw);

    // Once the gap is filled the run folds into one event.
    expect(batched.events.length).toBe(1);
  });

  test("the key set stays bounded during a long stream", () => {
    const events = conversationThenLongThink(20_000);
    let state = createSessionTranscriptStateForTesting([]);
    let largest = 0;
    for (let i = 0; i < events.length; i += 50) {
      state = appendSessionTranscriptBatchForTesting(state, events.slice(i, i + 50) as never);
      largest = Math.max(largest, state.keys.size);
    }
    // One key per stored event plus the window of folded delta keys.
    expect(largest).toBeLessThanOrEqual(4000 + 4000 + 256);
    expect(state.foldedKeys.length).toBeLessThanOrEqual(4000 + 256);

    // A recent delta replayed after the run is still recognized.
    const replay = events.at(-10)!;
    expect(appendSessionTranscriptEventForTesting(state, replay as never)).toBe(state);
  });

  test("folded delta keys outlive eviction of their event, then age out of the window", () => {
    const events: Event[] = [
      at(1, "agent_message_delta", { delta: "a" }),
      at(2, "agent_message_delta", { delta: "b" }),
    ];
    for (let i = 0; i < 4000; i += 1) {
      events.push(at(3 + i, "tool_progress", { callId: `call-${i}` }));
    }
    const state = createSessionTranscriptStateForTesting(events as never);
    expect(state.events.length).toBe(4000);
    // The stored event (key seq:2) was evicted; the folded seq:1 stays known
    // until newer folds push it out of the window.
    expect(state.keys.has("seq:2")).toBe(false);
    expect(state.keys.has("seq:1")).toBe(true);
    expect(state.keys.size).toBe(4001);

    let streamed = state;
    const more: Event[] = [];
    for (let i = 0; i < 4300; i += 1) {
      more.push(at(5000 + i, "agent_message_delta", { delta: "x" }));
    }
    streamed = appendSessionTranscriptBatchForTesting(streamed, more as never);
    expect(streamed.keys.has("seq:1")).toBe(false);
  });

  test("a stored reset at the head of the store keeps folded keys through a rebuild (sequenced)", () => {
    const delta = (seq: number, text: string) => at(seq, "agent_message_delta", { delta: text });
    let state = createSessionTranscriptStateForTesting([
      at(1, "history_cleared", {}),
      at(2, "user_message", { message: "hi" }),
      at(3, "turn_started", { turnId: "turn-1" }),
    ] as never);
    state = appendSessionTranscriptBatchForTesting(state, [delta(10, "A"), delta(11, "B"), delta(12, "C")] as never);
    // A late sequenced event forces a rebuild, which re-runs the stored reset.
    state = appendSessionTranscriptEventForTesting(state, at(7, "token_count", {}) as never);
    expect(adaptTranscriptEvents(state.events as never).streamingText).toBe("ABC");
    // The folded delta is still recognized afterwards.
    const replayed = appendSessionTranscriptEventForTesting(state, delta(11, "B") as never);
    expect(adaptTranscriptEvents(replayed.events as never).streamingText).toBe("ABC");
  });

  test("a stored reset keeps folded keys when a batch repeats it (daemon id keys)", () => {
    const delta = (id: string, text: string) => ({
      id,
      type: "agent_message_delta",
      payload: { delta: text },
    });
    const reset = { id: "daemon:a:event:r", type: "history_replaced", payload: { messages: [] } };
    let state = createSessionTranscriptStateForTesting([reset] as never);
    state = appendSessionTranscriptBatchForTesting(state, [delta("a", "A"), delta("b", "B"), delta("c", "C")] as never);
    // A live delta coalesced with the re-delivered, already known reset.
    state = appendSessionTranscriptBatchForTesting(state, [delta("d", "D"), reset] as never);
    expect(adaptTranscriptEvents(state.events as never).streamingText).toBe("ABCD");
    state = appendSessionTranscriptEventForTesting(state, delta("b", "B") as never);
    expect(adaptTranscriptEvents(state.events as never).streamingText).toBe("ABCD");
  });
});
