import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./session-transcript.js";

// Audit finding #13: agent_status:error is translated into a terminal-marked
// transcript error. The reducer must clear streaming for that event while
// leaving unmarked session diagnostics inside the active turn.
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
          terminal: true,
          terminalSource: "agent_status",
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

  test("`error` with stream_disconnected cause keeps the turn streaming", () => {
    const transcript = adaptTranscriptEvents([
      turnStart,
      {
        type: "assistant_text",
        payload: { content: "partial answ" },
      } as never,
      {
        type: "error",
        payload: {
          cause: "stream_disconnected",
          message: "Reconnecting after stream interruption (attempt 1)",
        },
      } as never,
    ]);

    expect(transcript.isStreaming).toBe(true);
    expect(JSON.stringify(transcript.messages)).toContain(
      "Reconnecting after stream interruption",
    );
  });

  test("unrecognized session errors keep the turn streaming", () => {
    const transcript = adaptTranscriptEvents([
      turnStart,
      {
        type: "error",
        payload: {
          cause: "future_mid_turn_diagnostic",
          message: "diagnostic event",
        },
      } as never,
    ]);

    expect(transcript.isStreaming).toBe(true);
    expect(JSON.stringify(transcript.messages)).toContain("diagnostic event");
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
