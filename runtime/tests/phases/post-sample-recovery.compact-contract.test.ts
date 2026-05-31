import { describe, expect, test, vi } from "vitest";
import { buildInitialTurnState } from "../session/turn-state.js";
import {
  postSampleRecovery,
  runContextCollapseOverflowRecovery,
} from "./post-sample-recovery.js";
import { findToolTurnValidationIssue } from "../llm/tool-turn-validator.js";
import {
  mkCtx,
  mkSession,
} from "../../tests/fixtures.js";
import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";

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
    const append = vi.fn();
    session.rolloutStore = {
      append,
    } as unknown as Session["rolloutStore"];
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
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({
            cause: "prompt_too_long_exhausted",
          }),
        }),
      }),
      expect.objectContaining({ durable: true }),
    );
  });

  test("413 collapse preserves assistant tool calls paired with kept tool results", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "continue",
    });
    state.messagesForQuery = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-collapse", name: "Read", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "tc-collapse",
        toolName: "Read",
        content: "ok",
      },
    ];

    const recovered = await runContextCollapseOverflowRecovery({ state });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    expect(findToolTurnValidationIssue(state.messagesForQuery)).toBeNull();
  });

  test("413 collapse preserves assistant call when kept tail starts with tool result", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(ctx, {
      role: "user",
      content: "continue",
    });
    state.messagesForQuery = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-edge", name: "Read", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "tc-edge",
        toolName: "Read",
        content: "ok",
      },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];

    const recovered = await runContextCollapseOverflowRecovery({ state });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    expect(findToolTurnValidationIssue(state.messagesForQuery)).toBeNull();
  });
});
