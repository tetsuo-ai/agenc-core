import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./session-transcript.js";

// bug-audit-2026-07-11.md #13: an error-terminated daemon turn never arrives
// as `turn_complete` — run-turn's turn_complete(stopReason:"error") is
// remapped to run_error → agent_status:error → a transcript `error` event.
// The reducer previously left `isStreaming` latched true for that event, so
// the "✢ Working…" spinner cycled forever after e.g. a provider
// connection_refused error.
describe("error events end the streaming turn", () => {
  const turnStart = {
    type: "turn_started",
    payload: { turnId: "turn-1" },
  } as never;

  test("`error` clears isStreaming and preserves partial text", () => {
    const transcript = adaptTranscriptEvents([
      turnStart,
      {
        type: "assistant_text",
        payload: { content: "partial answ" },
      } as never,
      {
        type: "error",
        payload: {
          message:
            "openai-compatible error: fetch failed [openai_category=connection_refused]",
        },
      } as never,
    ]);

    expect(transcript.isStreaming).toBe(false);
    const rendered = JSON.stringify(transcript.messages);
    expect(rendered).toContain("connection_refused");
    expect(rendered).toContain("partial answ");
  });

  test("`stream_error` clears isStreaming", () => {
    const transcript = adaptTranscriptEvents([
      turnStart,
      {
        type: "stream_error",
        payload: { message: "stream broke" },
      } as never,
    ]);

    expect(transcript.isStreaming).toBe(false);
  });

  test("turns still stream while no terminal event has arrived", () => {
    const transcript = adaptTranscriptEvents([
      turnStart,
      {
        type: "assistant_text",
        payload: { content: "thinking about it" },
      } as never,
    ]);

    expect(transcript.isStreaming).toBe(true);
  });
});
