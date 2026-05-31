import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMResponse } from "../llm/types.js";
import {
  runTurn,
  setAutoCompactImplForTests,
  type AutoCompactImpl,
} from "./run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../../tests/fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
});

describe("runTurn auto-compact <compact> boundary marker", () => {
  // Regression: durableHistoryStartIndex used to be frozen as `system ? 1 : 0`
  // for the whole turn. After auto-compact replaced state.messages with the
  // post-compact replacement history (index 0 = the <compact> boundary marker,
  // a real user message — NOT a system message), the frozen slice(1) dropped
  // that boundary marker (and the first kept message) from the in-memory
  // session.history, diverging from the manual-compact contract which writes
  // the full replacementHistory (boundary marker included) to history.
  test("preserves the <compact> marker in session.history when a system prompt is present", async () => {
    let streamCount = 0;
    const provider = mkProvider({}, {});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      if (streamCount === 1) {
        return {
          content: "need a tool",
          toolCalls: [{ id: "toolu_b", name: "Read", arguments: "{}" }],
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          model: "test-model",
          finishReason: "tool_calls",
        };
      }
      return {
        content: "after compact",
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        model: "test-model",
        finishReason: "stop",
      };
    };

    const compactImpl = vi.fn<AutoCompactImpl>(
      async (_messages, _context, _tracking, _snip, injection) => {
        if (injection !== "before_last_user_message") {
          return { wasCompacted: false };
        }
        return {
          wasCompacted: true,
          compactionResult: {
            message: "boundary compact summary",
            replacementHistory: [
              { role: "user", content: "<compact>boundary</compact>" },
              { role: "user", content: "boundary compact summary" },
              { role: "assistant", content: "kept tail message" },
            ],
          },
        };
      },
    );
    setAutoCompactImplForTests(compactImpl);

    const { session, state } = mkSession({
      provider,
      totalTokenUsage: 1_000,
      modelInfo: { autoCompactTokenLimit: 1 } as never,
    });

    await drain(
      runTurn(
        session,
        mkCtx({
          modelInfo: {
            ...mkCtx().modelInfo,
            autoCompactTokenLimit: 1,
          } as never,
        }),
        "start",
        { systemPrompt: "You are a helpful assistant." },
      ),
    );

    expect(compactImpl).toHaveBeenCalled();
    // The seed system message must be stripped from durable history...
    expect(state.history.some((message) => message.role === "system")).toBe(
      false,
    );
    // ...but the <compact> boundary marker (and the first kept message) must
    // survive, matching the manual-compact contract.
    expect(state.history[0]?.content).toBe("<compact>boundary</compact>");
    expect(
      state.history.map((message) => message.content),
    ).toContain("boundary compact summary");
    expect(
      state.history.map((message) => message.content),
    ).toContain("kept tail message");
  });
});
