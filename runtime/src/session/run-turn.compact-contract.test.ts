import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "../llm/types.js";
import {
  runTurn,
  setAutoCompactImplForTests,
  type AutoCompactImpl,
} from "./run-turn.js";
import {
  drain,
  mkCtx,
  mkProvider,
  mkSession,
} from "../../tests/fixtures.js";

const originalEnv = {
  AGENC_AUTO_COMPACT_WINDOW: process.env.AGENC_AUTO_COMPACT_WINDOW,
  AGENC_AUTOCOMPACT_PCT_OVERRIDE: process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE,
};

afterEach(() => {
  setAutoCompactImplForTests(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("runTurn compact contract", () => {
  test("ordinary under-threshold turns reach model sampling", async () => {
    const seen: LLMMessage[][] = [];
    const { session } = mkSession({
      provider: mkProvider(
        { content: "ok" },
        { onChatStream: (messages) => seen.push(messages) },
      ),
    });

    await drain(runTurn(session, mkCtx(), "hello"));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ role: "user", content: "hello" }]);
  });

  test("pre-turn auto compact rehydrates replacement history before sampling", async () => {
    process.env.AGENC_AUTO_COMPACT_WINDOW = "80";
    process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";
    const seen: LLMMessage[][] = [];
    const provider = mkProvider(
      { content: "compact summary" },
      { onChatStream: (messages) => seen.push(messages) },
    );
    const history = Array.from({ length: 12 }, (_, index): LLMMessage => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index} ${"x".repeat(120)}`,
    }));
    const { session, state } = mkSession({
      provider,
      history,
    });

    await drain(runTurn(session, mkCtx(), "new request"));

    expect(seen[0]?.[0]?.content).toContain(
      "This session is being continued from a previous conversation",
    );
    expect(seen[0]?.[0]?.content).toContain("compact summary");
    expect(seen[0]?.some((message) =>
      typeof message.content === "string" &&
      message.content.includes("compact summary"))).toBe(true);
    expect(JSON.stringify(seen[0])).not.toContain("old-0");
    expect(state.history[0]?.content).toContain("<compact>");
  });

  test("mid-turn compact runs before a continuation request and rebases sampling input", async () => {
    const seen: LLMMessage[][] = [];
    let streamCount = 0;
    const provider = mkProvider({}, {
      onChatStream: (messages) => seen.push(messages),
    });
    provider.chatStream = async (messages): Promise<LLMResponse> => {
      seen.push(messages.map((message) => ({ ...message })));
      streamCount += 1;
      if (streamCount === 1) {
        return {
          content: "need a tool",
          toolCalls: [{ id: "toolu_mid", name: "Read", arguments: "{}" }],
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
            message: "mid compact summary",
            replacementHistory: [
              { role: "user", content: "<compact>mid</compact>" },
              { role: "user", content: "mid compact summary" },
            ],
          },
        };
      },
    );
    setAutoCompactImplForTests(compactImpl);
    const { session } = mkSession({
      provider,
      totalTokenUsage: 1_000,
      modelInfo: { autoCompactTokenLimit: 1 } as never,
    });

    await drain(runTurn(session, mkCtx({
      modelInfo: {
        ...mkCtx().modelInfo,
        autoCompactTokenLimit: 1,
      } as never,
    }), "start"));

    expect(streamCount).toBe(2);
    expect(compactImpl).toHaveBeenCalled();
    expect(seen[1]).toEqual([
      { role: "user", content: "mid compact summary" },
    ]);
  });
});
