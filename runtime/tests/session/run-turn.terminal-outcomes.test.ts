import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import type { LLMResponse } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import {
  runTurn,
  setAutoCompactImplForTests,
} from "../../src/session/run-turn.js";
import type { Event, SessionServices } from "../../src/session/session.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
});

function expectFailedTurn(events: readonly Event[], code: string): void {
  const terminals = events.flatMap((event) => {
    const terminal = classifyTurnTerminal(event.msg, {
      expectedTurnId: mkCtx().subId,
    });
    return terminal === undefined ? [] : [terminal];
  });
  expect(terminals).toEqual([
    expect.objectContaining({ outcome: "errored", code: 1, failureCode: code }),
  ]);
  expect(events.some((event) => event.msg.type === "turn_complete")).toBe(false);
}

describe("canonical turn outcomes", () => {
  test("iteration caps fail rather than publishing leftover assistant text as success", async () => {
    let samples = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      samples += 1;
      return {
        content: "Let me run the next check.",
        toolCalls: [{ id: `read-${samples}`, name: "Read", arguments: "{}" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        finishReason: "tool_calls",
      };
    };
    const { session, events } = mkSession({ provider });
    const ctx = mkCtx();
    const phases: PhaseEvent[] = [];
    for await (const phase of runTurn(session, {
      ...ctx,
      config: { ...ctx.config, maxTurns: 1 },
    }, "finish the task")) {
      phases.push(phase);
    }

    expect(samples).toBe(1);
    expect(phases.at(-1)).toMatchObject({ stopReason: "max_turns" });
    expectFailedTurn(events, "max_turns");
    expect(
      events.find((event) => event.msg.type === "turn_failed")?.msg,
    ).toMatchObject({
      payload: { message: expect.stringContaining("iteration limit") },
    });

    provider.chatStream = mkProvider({
      content: "Finished the remaining work.",
    }).chatStream;
    const followupEventsStart = events.length;
    await drain(runTurn(session, { ...ctx, subId: "followup-turn" }, "continue"));
    expect(
      events.slice(followupEventsStart).map((event) =>
        classifyTurnTerminal(event.msg, { expectedTurnId: "followup-turn" }),
      ),
    ).toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });

  test("cost caps publish a failed canonical boundary before sampling", async () => {
    const chatStream = vi.fn(mkProvider().chatStream);
    const { session, events } = mkSession({
      provider: { ...mkProvider(), chatStream },
      services: {
        costSidecar: { getTotalCostUsd: () => 1 } as SessionServices["costSidecar"],
      },
    });
    const ctx = mkCtx();
    await drain(runTurn(session, {
      ...ctx,
      config: { ...ctx.config, maxBudgetUsd: 1 },
    }, "do not spend more"));

    expect(chatStream).not.toHaveBeenCalled();
    expectFailedTurn(events, "max_budget_usd");
  });

  test("failed post-tool compaction publishes failure instead of stale commentary", async () => {
    const provider = mkProvider({
      content: "Now I will create the implementation.",
      toolCalls: [{ id: "read-compact", name: "Read", arguments: "{}" }],
      usage: { promptTokens: 100, completionTokens: 1, totalTokens: 101 },
      finishReason: "tool_calls",
    });
    setAutoCompactImplForTests(async () => ({ wasCompacted: false }));
    const { session, events } = mkSession({ provider });
    const ctx = mkCtx();
    await drain(runTurn(session, {
      ...ctx,
      modelInfo: { ...ctx.modelInfo, autoCompactTokenLimit: 1 },
    }, "create the implementation"));

    expectFailedTurn(events, "compact_failed");
    expect(
      events.find((event) => event.msg.type === "turn_failed")?.msg,
    ).toMatchObject({
      payload: { message: expect.stringContaining("mid_turn_compact_skipped") },
    });
  });

  test("exhausting the empty-response retry does not count as success", async () => {
    const chatStream = vi.fn(mkProvider({ content: "" }).chatStream);
    const { session, events } = mkSession({
      provider: { ...mkProvider(), chatStream },
    });
    await drain(runTurn(session, mkCtx(), "answer the question"));

    expect(chatStream).toHaveBeenCalledTimes(2);
    expectFailedTurn(events, "empty_response");
  });
});
