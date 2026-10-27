import { expect, test } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const event = (id: string, type: string, payload: Record<string, unknown>) =>
  ({ id, msg: { type, payload } }) as never;

test("a reconnect notice separates the failed partial answer from the new stream", () => {
  const transcript = adaptTranscriptEvents([
    event("start", "turn_started", { turnId: "turn" }),
    event("partial", "agent_message_delta", { delta: "Interrupted fragment. " }),
    event("retry", "stream_error", {
      cause: "stream_disconnected", message: "provider error, retrying in up to 1 s (2/6)",
    }),
    event("fresh", "agent_message_delta", { delta: "Recovered answer." }),
  ]);
  expect(transcript.streamingText).toBe("Recovered answer.");
  expect(transcript.messages).toMatchObject([
    { type: "assistant", message: { content: [{ type: "text", text: "Interrupted fragment. " }] } },
    { type: "system", content: "provider error, retrying in up to 1 s (2/6)" },
  ]);
});

test("a stream failure preserves its partial answer before the failure notice", () => {
  const transcript = adaptTranscriptEvents([
    event("start", "turn_started", { turnId: "turn" }),
    event("partial", "agent_message_delta", { delta: "Partial answer" }),
    event("failed", "stream_error", { cause: "stream_disconnected", message: "Retry is unsafe." }),
  ]);
  expect(transcript.streamingText).toBeNull();
  expect(transcript.messages[0]).toMatchObject({
    type: "assistant", message: { content: [{ type: "text", text: "Partial answer" }] },
  });
});

test("a fragment kept at a reconnect notice is removed when its attempt is discarded", () => {
  const transcript = adaptTranscriptEvents([
    event("start", "turn_started", { turnId: "turn" }),
    event("partial", "agent_message_delta", { delta: "Abandoned fragment. " }),
    event("retry", "stream_error", {
      cause: "stream_disconnected", message: "provider error, retrying in up to 1 s (2/6)",
    }),
    event("discard", "stream_error", {
      cause: "stream_attempt_discarded", message: "Discarded interrupted model output.",
    }),
    event("fresh", "agent_message_delta", { delta: "Recovered answer." }),
  ]);
  expect(transcript.streamingText).toBe("Recovered answer.");
  expect(JSON.stringify(transcript.messages)).not.toContain("Abandoned fragment");
  expect(transcript.messages).toMatchObject([
    { type: "system", content: "provider error, retrying in up to 1 s (2/6)" },
  ]);
});
