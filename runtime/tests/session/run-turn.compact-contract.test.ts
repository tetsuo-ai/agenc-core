import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// Every session in this file shares the conversation id "conv-test", so they
// share one memory-extraction lane and its eligible-turn counter. Since the
// turn no longer awaits `drainPendingExtraction`, the child that fires when
// that counter reaches the cadence samples on the test's own provider AFTER
// the turn it belongs to has returned -- so its calls land in whichever later
// turn happens to be running, or not at all, depending on wall clock. The
// back-off test below counts model calls exactly across six turns, so the
// extraction fork is switched off for the file rather than being absorbed
// into each expectation. Same reasoning, same switch, as run-turn.test.ts.
beforeEach(() => {
  vi.stubEnv("AGENC_DISABLE_EXTRACT_MEMORIES", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    // The dispatcher is offered the session history, never the query
    // projection with its attachments and microcompacted tool results.
    const offered = compactImpl.mock.calls[0]?.[0] as LLMMessage[];
    expect(offered[0]).toEqual(
      expect.objectContaining({ role: "user", content: "start" }),
    );
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

  test("a mid-turn compact decline is reported once and the turn keeps working", async () => {
    // The gate sits at three quarters of the window and admission denies at
    // the window itself, so a dispatcher that ran and declined leaves room
    // to keep sampling. Ending the turn here cost a live session its turn on
    // every decline, mid-plan.
    let streamCount = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      if (streamCount === 1) {
        return {
          content: "need a tool",
          toolCalls: [{ id: "toolu_skip", name: "Read", arguments: "{}" }],
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          model: "test-model",
          finishReason: "tool_calls",
        };
      }
      return {
        content: "done after the decline",
        toolCalls: [],
        usage: { promptTokens: 120, completionTokens: 5, totalTokens: 125 },
        model: "test-model",
        finishReason: "stop",
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

    // The model sampled again after the decline and finished its work.
    expect(streamCount).toBe(2);
    // The pre-turn attempt answered "not compacted" without a reason, so the
    // in-turn gate asked once more; that decline is remembered for the rest
    // of the turn and no third attempt follows.
    expect(compactImpl).toHaveBeenCalledTimes(2);
    expect(
      events.filter(
        (event) =>
          event.msg.type === "warning" &&
          event.msg.payload.cause === "mid_turn_compact_failed",
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.msg.type === "error" &&
          event.msg.payload.cause === "mid_turn_compact_failed",
      ),
    ).toBe(false);
    expect(yielded.some((event) => event.type === "turn_complete")).toBe(true);
    expect(yielded).not.toContainEqual(
      expect.objectContaining({ stopReason: "compact_failed" }),
    );
  });

  test("an in-turn compaction that declines names its reason in the rollout", async () => {
    // Real dispatcher, no test override. This session has no rollout owner,
    // so the durable transaction refuses with `pin_failed`. The turn loop
    // must surface THAT sentence: before the fix the reason was computed in
    // autoCompactIfNeeded and dropped on the way back through
    // runAgenCAutoCompact, so a run that died here left only a bare
    // `mid_turn_compact_skipped` behind. The model asks for a tool, so the
    // compaction runs at the post-tool gate, after the result is in.
    let streamCount = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      if (streamCount === 1) {
        return {
          content: "need a tool",
          toolCalls: [{ id: "toolu_reason", name: "Read", arguments: "{}" }],
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
        content: "finished after the declined compaction",
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        model: "test-model",
        finishReason: "stop",
      };
    };
    const { session, events } = mkSession({
      provider,
      modelInfo: { autoCompactTokenLimit: 18_129 } as never,
    });

    const yielded: unknown[] = [];
    for await (const event of runTurn(
      session,
      mkCtx({
        modelInfo: {
          ...mkCtx().modelInfo,
          autoCompactTokenLimit: 18_129,
        } as never,
      }),
      "start",
    )) {
      yielded.push(event);
    }

    // The decline did not end the turn: the model answered afterwards.
    expect(streamCount).toBe(2);
    const declined = events.filter(
      (event) =>
        event.msg.type === "warning" &&
        event.msg.payload.cause === "auto_compact_failed",
    );
    expect(declined).toHaveLength(1);
    const first = declined[0];
    if (first?.msg.type === "warning") {
      expect(first.msg.payload.message).toBe(
        "context_limit/in_turn: durable compaction is unavailable without a canonical rollout owner; history was not changed",
      );
    }
    expect(
      events.some(
        (event) =>
          event.msg.type === "warning" &&
          event.msg.payload.cause === "mid_turn_compact_failed" &&
          typeof event.msg.payload.message === "string" &&
          event.msg.payload.message.startsWith("mid_turn_compact_skipped:"),
      ),
    ).toBe(true);
    expect(yielded).not.toContainEqual(
      expect.objectContaining({ stopReason: "compact_failed" }),
    );
  });

  test("three declined turns in a row buy two turns of back-off, then one more try", async () => {
    // Before: a session past the threshold paid a full failed attempt,
    // minutes long, at the start of every turn. Now the session backs off.
    let streamCount = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      if (streamCount % 2 === 1) {
        return {
          content: "need a tool",
          toolCalls: [{ id: `toolu_backoff_${streamCount}`, name: "Read", arguments: "{}" }],
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          model: "test-model",
          finishReason: "tool_calls",
        };
      }
      return {
        content: "turn done",
        toolCalls: [],
        usage: { promptTokens: 120, completionTokens: 5, totalTokens: 125 },
        model: "test-model",
        finishReason: "stop",
      };
    };
    const compactImpl = vi.fn<AutoCompactImpl>(async () => ({
      wasCompacted: false,
      skippedReason: "test decline",
    }));
    setAutoCompactImplForTests(compactImpl);
    const { session, events } = mkSession({
      provider,
      modelInfo: { autoCompactTokenLimit: 1 } as never,
    });
    const ctx = mkCtx({
      modelInfo: { ...mkCtx().modelInfo, autoCompactTokenLimit: 1 } as never,
    });
    const attemptsAfterTurn: number[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      for await (const _event of runTurn(session, ctx, `prompt ${turn}`)) {
        // drain
      }
      attemptsAfterTurn.push(compactImpl.mock.calls.length);
    }
    // Turns 1-3 each attempt once (pre-turn or in-turn) and decline; turns
    // 4 and 5 are skipped; turn 6 tries again.
    expect(attemptsAfterTurn[2]).toBeGreaterThanOrEqual(3);
    expect(attemptsAfterTurn[3]).toBe(attemptsAfterTurn[2]);
    expect(attemptsAfterTurn[4]).toBe(attemptsAfterTurn[2]);
    expect(attemptsAfterTurn[5]).toBeGreaterThan(attemptsAfterTurn[4]);
    const backoffNotes = events.filter(
      (event) =>
        event.msg.type === "warning" &&
        typeof event.msg.payload.message === "string" &&
        event.msg.payload.message.includes("back-off"),
    );
    expect(backoffNotes.length).toBeGreaterThanOrEqual(2);
    // Every turn finished normally.
    expect(streamCount).toBe(12);
  });
});
