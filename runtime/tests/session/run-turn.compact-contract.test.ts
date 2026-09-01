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

  test("pre-turn auto compact leaves history intact without a rollout owner", async () => {
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

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain("old-0");
    expect(JSON.stringify(seen[0])).not.toContain("compact summary");
    expect(state.history[0]?.content).toContain("old-0");
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
              {
                role: "developer",
                content: "authenticated boundary",
                runtimeOnly: {
                  compactionHistory: {
                    version: 1,
                    kind: "boundary",
                    attempt_id: "mid-attempt",
                    summary_sha256: "a".repeat(64),
                  },
                },
              },
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

  test("mid-turn context-limit compaction forces an estimator-vetoed compact", async () => {
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
          toolCalls: [{ id: "toolu_force", name: "Read", arguments: "{}" }],
          usage: {
            promptTokens: 18_130,
            completionTokens: 10,
            totalTokens: 18_140,
          },
          model: "test-model",
          finishReason: "tool_calls",
        };
      }
      return {
        content: "after forced compact",
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        model: "test-model",
        finishReason: "stop",
      };
    };
    const compactImpl = vi.fn<AutoCompactImpl>(async (...args) => {
      const options = args[5] as { force?: boolean } | undefined;
      if (options?.force !== true) {
        return { wasCompacted: false };
      }
      return {
        wasCompacted: true,
        compactionResult: {
          message: "forced mid compact summary",
          replacementHistory: [
            {
              role: "developer",
              content: "authenticated boundary",
              runtimeOnly: {
                compactionHistory: {
                  version: 1,
                  kind: "boundary",
                  attempt_id: "forced-attempt",
                  summary_sha256: "b".repeat(64),
                },
              },
            },
            { role: "user", content: "forced mid compact summary" },
          ],
        },
      };
    });
    setAutoCompactImplForTests(compactImpl);
    const { session, events } = mkSession({
      provider,
      modelInfo: { autoCompactTokenLimit: 18_129 } as never,
    });

    await drain(runTurn(session, mkCtx({
      modelInfo: {
        ...mkCtx().modelInfo,
        autoCompactTokenLimit: 18_129,
      } as never,
    }), "start"));

    expect(streamCount).toBe(2);
    expect(compactImpl).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      undefined,
      0,
      "before_last_user_message",
      { force: true },
    );
    expect(events.some((event) =>
      event.msg.type === "error" &&
      event.msg.payload.cause === "mid_turn_compact_failed"
    )).toBe(false);
    expect(seen[1]).toEqual([
      { role: "user", content: "forced mid compact summary" },
    ]);
  });

  test("mid-turn compact skip ends the turn without a run-fatal error event", async () => {
    let streamCount = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      return {
        content: "need a tool",
        toolCalls: [{ id: "toolu_skip", name: "Read", arguments: "{}" }],
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        model: "test-model",
        finishReason: "tool_calls",
      };
    };
    const compactImpl = vi.fn<AutoCompactImpl>(async () => ({
      wasCompacted: false,
    }));
    setAutoCompactImplForTests(compactImpl);
    const { session, events } = mkSession({
      provider,
      modelInfo: { autoCompactTokenLimit: 1 } as never,
    });

    const yielded: Array<{ type?: string; stopReason?: string }> = [];
    for await (const event of runTurn(
      session,
      mkCtx({
        modelInfo: {
          ...mkCtx().modelInfo,
          autoCompactTokenLimit: 1,
        } as never,
      }),
      "start",
    )) {
      yielded.push(event);
    }

    expect(streamCount).toBe(1);
    expect(compactImpl).toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.msg.type === "warning" &&
          event.msg.payload.cause === "mid_turn_compact_failed",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.msg.type === "error" &&
          event.msg.payload.cause === "mid_turn_compact_failed",
      ),
    ).toBe(false);
    expect(yielded).toContainEqual(
      expect.objectContaining({
        type: "turn_complete",
        stopReason: "compact_failed",
      }),
    );
  });
});
