import { describe, expect, test } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

describe("degenerate stream notice", () => {
  test("labels the failed partial before a fresh retry starts", () => {
    const transcript = adaptTranscriptEvents([
      { id: "turn", msg: { type: "turn_started", payload: { turnId: "t1" } } },
      { id: "delta", msg: { type: "agent_message_delta", payload: { delta: "fu fu a2 : " } } },
      { id: "stop", msg: { type: "stream_error", payload: { cause: "stream_degenerate", message: "Stopped degenerate model output; partial output is unreliable. Retry or switch model." } } },
      { id: "retry", msg: { type: "agent_message_delta", payload: { delta: "Clean answer." } } },
    ] as never);
    const rendered = JSON.stringify(transcript.messages);
    expect(rendered).toContain("fu fu a2");
    expect(rendered).toContain("partial output is unreliable");
    expect(transcript.streamingText).toBe("Clean answer.");
  });
});
