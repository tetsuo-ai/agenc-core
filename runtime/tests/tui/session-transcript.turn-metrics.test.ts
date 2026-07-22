import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

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
