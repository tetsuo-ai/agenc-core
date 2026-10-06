import { describe, expect, it } from "vitest";
import type { Event } from "../../src/session/event-log.js";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  makeToolResultMessage,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

describe("typed transcript inputs", () => {
  it("projects journal envelopes and flat notifications into the same thinking state", () => {
    const started: Event = {
      id: "started",
      msg: { type: "turn_started", payload: { turnId: "parent-turn" } },
    };
    const stopped: Event = {
      id: "stopped",
      msg: { type: "assistant_thinking_block_stop", payload: { index: 0 } },
    };
    const events: SessionTranscriptEvent[] = [
      started,
      { type: "assistant_thinking_delta", payload: { delta: "first", kind: "reasoning_summary" } },
      { type: "assistant_thinking_delta", payload: { delta: " second" } },
      stopped,
    ];
    const transcript = adaptTranscriptEvents(events);
    expect(transcript.currentTurnId).toBe("parent-turn");
    expect(transcript.streamingThinking).toEqual({
      thinking: "first second",
      isStreaming: false,
      redacted: false,
      kind: "reasoning_summary",
      streamingEndedAt: expect.any(Number),
    });
    expect(transcript.turnStreamedChars).toBe(12);
  });

  it("keeps stable object identity for cyclic notifications without journal IDs", () => {
    const payload: Record<string, unknown> = { message: "visible prompt" };
    payload.circular = payload;
    const event: SessionTranscriptEvent = { type: "user_message", payload };
    const initial = createSessionTranscriptStateForTesting([event]);
    const appended = appendSessionTranscriptEventForTesting(initial, event);
    expect(appended.events).toHaveLength(1);
    expect(adaptTranscriptEvents(initial.events).messages[0]?.uuid)
      .toBe(adaptTranscriptEvents(appended.events).messages[0]?.uuid);
  });

  it("preserves structured text blocks and their plain text result summary", () => {
    const content = [{ type: "text", text: "first" }, { type: "text", text: "second" }] as const;
    const message = makeToolResultMessage("tool-call", content);
    expect(message.message.content[0].content).toBe(content);
    expect(message.toolUseResult).toBe("first\nsecond");
    expect(makeToolResultMessage("tool-call", "plain").toolUseResult).toBe("plain");
  });
});
