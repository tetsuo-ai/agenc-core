import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents, createSessionTranscriptStateForTesting, appendSessionTranscriptBatchForTesting, appendSessionTranscriptEventForTesting } from "../../src/tui/session-transcript.js";

// Spinner tok/s + workbench ctx% inputs. The spinner previously read the
// LIVE streaming buffers (which reset per message/thinking block), so its
// chars/4 numerator collapsed mid-turn while the rate denominator kept
// growing — grok tool-heavy turns displayed ~3 tok/s. ctx% previously read
// assistant-message usage blocks, which the daemon bridge synthesizes as
// zeros — it displayed 0% forever. Both now come from the transcript
// projection: `turnStreamedChars` (cumulative per turn) and `latestUsage`
// (from token_count events).

function ev(id: string, type: string, payload: Record<string, unknown>) {
  return { id, msg: { type, payload } } as never;
}

describe("turnStreamedChars", () => {
  test("accumulates visible + thinking + tool-argument deltas without resetting mid-turn", () => {
    const transcript = adaptTranscriptEvents([
      ev("t", "turn_started", { turnId: "t1" }),
      ev("d0", "agent_message_delta", { delta: "hello " }),
      ev("th-start", "assistant_thinking_block_start", { index: 0 }),
      ev("th0", "assistant_thinking_delta", { delta: "pondering", index: 0 }),
      ev("ti-start", "tool_input_block_start", {
        callId: "call_1",
        index: 0,
        contentBlock: { type: "tool_use", id: "call_1", name: "Write", input: {} },
      }),
      ev("ti0", "tool_input_delta", {
        callId: "call_1",
        index: 0,
        partialJson: '{"a":1}',
      }),
    ]);
    expect(transcript.turnStreamedChars).toBe(
      "hello ".length + "pondering".length + '{"a":1}'.length,
    );
  });

  test("resets on the next turn_start, not on message boundaries", () => {
    const transcript = adaptTranscriptEvents([
      ev("t1", "turn_started", { turnId: "t1" }),
      ev("d0", "agent_message_delta", { delta: "0123456789" }),
      ev("t2", "turn_started", { turnId: "t2" }),
      ev("d1", "agent_message_delta", { delta: "abc" }),
    ]);
    expect(transcript.turnStreamedChars).toBe(3);
  });
});

describe("latestUsage", () => {
  test("null before any token_count event", () => {
    const transcript = adaptTranscriptEvents([
      ev("t", "turn_started", { turnId: "t1" }),
    ]);
    expect(transcript.latestUsage).toBeNull();
  });

  test("carries the most recent token_count payload in usage-block shape", () => {
    const transcript = adaptTranscriptEvents([
      ev("u1", "token_count", {
        promptTokens: 1_000,
        completionTokens: 50,
        cachedInputTokens: 400,
        cacheCreationInputTokens: 100,
        model: "grok-4.5",
        provider: "grok",
      }),
      ev("u2", "token_count", {
        promptTokens: 120_000,
        completionTokens: 2_000,
        cachedInputTokens: 90_000,
        cacheCreationInputTokens: 0,
        model: "grok-4.5",
        provider: "grok",
      }),
    ]);
    expect(transcript.latestUsage).toEqual({
      input_tokens: 120_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 90_000,
    });
  });
});


describe("turn efficiency", () => {
  const start = ev("start", "turn_started", { turnId: "turn-1" });
  const dispatch = (id: string, kind = "model_turn") => ev(id, "execution_admission", { event: "dispatched", kind });
  const usage = (id: string, promptTokens: number, cachedInputTokens?: number, provider = "openai") => ev(id, "token_count", {
    provider, promptTokens, completionTokens: 100, cachedInputTokens,
  });

  test("shows dispatches immediately and keeps the last request separate from turn totals", () => {
    const transcript = adaptTranscriptEvents([
      usage("old", 999), start, dispatch("d1"), usage("u1", 1_000, 900),
      dispatch("tool", "tool_call"), dispatch("d2"), usage("u2", 3_000, 2_700), dispatch("d3"),
    ]);
    expect(transcript.turnEfficiency).toEqual({
      modelCalls: 3,
      lastRequest: { inputTokens: 3_000, outputTokens: 100, cachedInputTokens: 2_700 },
      usage: { inputTokens: 4_000, outputTokens: 200, cachedInputTokens: 3_600 },
    });
  });

  test("normalizes cache-exclusive input and includes reasoning in output", () => {
    const transcript = adaptTranscriptEvents([start, dispatch("d1"), ev("usage", "token_count", {
      provider: "anthropic", promptTokens: 100, cachedInputTokens: 900,
      cacheCreationInputTokens: 200, completionTokens: 100, reasoningOutputTokens: 200,
    })]);
    expect(transcript.turnEfficiency?.usage).toEqual({ inputTokens: 1_200, outputTokens: 200, cachedInputTokens: 900 });
  });

  test("does not invent cache data when a provider omits it", () => {
    const transcript = adaptTranscriptEvents([start, dispatch("d1"), usage("u1", 1_000, 900),
      dispatch("d2"), usage("u2", 1_000)]);
    expect(transcript.turnEfficiency?.lastRequest?.cachedInputTokens).toBeNull();
    expect(transcript.turnEfficiency?.usage?.cachedInputTokens).toBeNull();
  });

  test("omits usage before counters arrive and output when it is unreported", () => {
    const before = adaptTranscriptEvents([start, dispatch("d1"), ev("empty", "token_count", {})]);
    expect(before.turnEfficiency?.usage).toBeNull();
    const incomplete = adaptTranscriptEvents([start, dispatch("d1"), ev("usage", "token_count", { totalTokens: 1_000 })]);
    expect(incomplete.turnEfficiency?.usage).toBeNull();
    const after = adaptTranscriptEvents([start, dispatch("d1"), ev("usage", "token_count", { promptTokens: 1_000 })]);
    expect(after.turnEfficiency?.usage).toEqual({ inputTokens: 1_000, cachedInputTokens: null, outputTokens: null });
  });

  test("captures totals in the footer and resets for the next turn", () => {
    const transcript = adaptTranscriptEvents([start, dispatch("d1"), usage("u1", 1_000, 900),
      ev("done", "turn_complete", { turnId: "turn-1", durationMs: 5_500 }),
      ev("start2", "turn_started", { turnId: "turn-2" }),
    ]);
    expect(transcript.messages.find(message => message.subtype === "turn_duration")).toMatchObject({
      modelCalls: 1, turnUsage: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 900 },
    });
    expect(transcript.turnEfficiency).toEqual({ modelCalls: 0, usage: null, lastRequest: null });
  });

  test.each(["turn_aborted", "turn_failed", "history_cleared", "history_replaced"])("clears live metrics on %s", type => {
    const transcript = adaptTranscriptEvents([start, dispatch("d1"), usage("u1", 1_000, 0),
      ev("end", type, { turnId: "turn-1", reason: "interrupted", code: "test_failure", message: "failed", messages: [] }),
    ]);
    expect(transcript.turnEfficiency).toBeNull();
  });

  test("ignores duplicate events and stale terminal events", () => {
    const dispatched = dispatch("d1");
    const transcript = adaptTranscriptEvents([start, dispatched, dispatched, usage("u1", 1_000, 0),
      ev("stale", "turn_complete", { turnId: "old-turn", durationMs: 10 }),
    ]);
    expect(transcript.turnEfficiency?.modelCalls).toBe(1);
    expect(transcript.turnEfficiency?.usage?.cachedInputTokens).toBe(0);
  });

  test.each([0, 47])("uses the store's authoritative tally of %i calls for live and finished turns", calls => {
    const events = [start, dispatch("d1"), usage("u1", 1_000, 900)];
    const modelCallsByTurn = new Map([["turn-1", calls]]);
    const live = adaptTranscriptEvents(events, [], modelCallsByTurn);
    expect(live.turnEfficiency?.modelCalls).toBe(calls);
    const completed = adaptTranscriptEvents([...events,
      ev("done", "turn_complete", { turnId: "turn-1", durationMs: 5_000 }),
    ], [], modelCallsByTurn);
    expect(completed.messages.find(message => message.subtype === "turn_duration")?.modelCalls).toBe(calls);
  });

  test.each(["append", "appendBatch"])("keeps token totals through an evicted-window rebuild using %s", path => {
    const events = [start, dispatch("d1"), usage("u1", 1_000, 900),
      ...Array.from({ length: 4_100 }, (_, i) => ev(`noise-${i}`, "irrelevant", {})),
    ].map((event, i) => ({ ...event, seq: i + 1 }));
    let state = createSessionTranscriptStateForTesting(events);
    expect(state.efficiencyBeforeEvents.current).not.toHaveProperty("modelCalls");
    const late = { ...ev("late", "warning", { message: "late" }), seq: 3.5 };
    state = path === "append"
      ? appendSessionTranscriptEventForTesting(state, late)
      : appendSessionTranscriptBatchForTesting(state, [events.at(-1)!, late]);
    state = appendSessionTranscriptBatchForTesting(state, [dispatch("d2"), usage("u2", 3_000, 2_700)]);
    const live = adaptTranscriptEvents(state.events, [], state.modelCalls.byTurn, state.efficiencyBeforeEvents);
    expect(live.turnEfficiency).toEqual({
      modelCalls: 2,
      lastRequest: { inputTokens: 3_000, cachedInputTokens: 2_700, outputTokens: 100 },
      usage: { inputTokens: 4_000, cachedInputTokens: 3_600, outputTokens: 200 },
    });
  });

  test("keeps live totals and the footer after the start of a long turn is evicted", () => {
    let state = createSessionTranscriptStateForTesting([start, dispatch("d1"), usage("u1", 1_000, 900)]);
    state = appendSessionTranscriptBatchForTesting(state, Array.from({ length: 4_100 }, (_, i) =>
      ev(`noise-${i}`, "irrelevant", {})));
    state = appendSessionTranscriptEventForTesting(state, dispatch("d2"));
    state = appendSessionTranscriptBatchForTesting(state, [usage("u2", 3_000, 2_700)]);
    const live = adaptTranscriptEvents(state.events, [], state.modelCalls.byTurn, state.efficiencyBeforeEvents);
    expect(live.isStreaming).toBe(true);
    expect(live.turnEfficiency?.modelCalls).toBe(2);
    expect(live.turnEfficiency?.usage?.inputTokens).toBe(4_000);
    state = appendSessionTranscriptEventForTesting(state,
      ev("done", "turn_complete", { turnId: "turn-1", durationMs: 5_500 }));
    const completed = adaptTranscriptEvents(state.events, [], state.modelCalls.byTurn, state.efficiencyBeforeEvents);
    expect(completed.turnEfficiency).toBeNull();
    expect(completed.messages.find(message => message.subtype === "turn_duration")).toMatchObject({
      modelCalls: 2, turnUsage: { inputTokens: 4_000, cachedInputTokens: 3_600, outputTokens: 200 },
    });
  });

  test.each(["turn_aborted", "turn_failed"])("adds a footer for %s when wall time is available", type => {
    const transcript = adaptTranscriptEvents([start, dispatch("d1"), usage("u1", 1_000, 0),
      ev("end", type, { turnId: "turn-1", reason: "interrupted", code: "test_failure", message: "failed", durationMs: 1500 }),
    ]);
    expect(transcript.messages.find(message => message.subtype === "turn_duration")).toMatchObject({
      durationMs: 1500, modelCalls: 1, turnUsage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 },
    });
  });

});
