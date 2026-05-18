import { describe, expect, test } from "vitest";
import { buildInitialTurnState } from "../session/turn-state.js";
import { postSampleRecovery } from "./post-sample-recovery.js";
import {
  mkCtx,
  mkSession,
} from "../../tests/fixtures.js";
import type { LLMMessage } from "../llm/types.js";

function seedMessages(): LLMMessage[] {
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: "answer 1" },
    { role: "user", content: "more context" },
    { role: "assistant", content: "answer 2" },
    { role: "user", content: "latest" },
  ];
}

describe("post-sample context-collapse recovery contract", () => {
  test("withheld prompt-too-long routes through collapse once and then surfaces", async () => {
    const ctx = mkCtx();
    const { session, events } = mkSession();
    const messages = seedMessages();
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: messages },
    );
    state.messages = [...messages];
    state.messagesForQuery = [...messages];
    state.assistantMessages = [
      {
        uuid: "asst-413",
        role: "assistant",
        text: "Prompt is too long: 200000 tokens > 128000",
        apiError: "context_window_exceeded",
        toolCalls: [],
      },
    ];

    await postSampleRecovery(state, ctx, session);

    expect(state.transition).toEqual({ reason: "collapse_drain_retry" });
    expect(state.messagesForQuery[0]?.content).toContain("<compact>");
    expect(state.messages[0]?.content).toContain("<compact>");

    state.transition = undefined;
    await postSampleRecovery(state, ctx, session);

    expect(state.transition).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.msg.type === "error" &&
          event.msg.payload.cause === "prompt_too_long_exhausted",
      ),
    ).toBe(true);
  });
});
