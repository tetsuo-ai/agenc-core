/**
 * drainInFlight parity test.
 *
 * The cancellation/error paths in runTurnKernel call `drainInFlight`
 * after the phase loop catches an abort/error while tools are still
 * in flight. AgenC behavior (`query.ts:1046-1060`) requires every
 * yielded synthetic `tool_result` to be paired with the orphan
 * `tool_use` block on `state.messages` so the next provider request
 * sees a balanced tool-use/tool-result pair. Earlier AgenC code
 * iterated `getRemainingResults()` and silently discarded the
 * yielded values — this regression test proves that's fixed.
 */

import { describe, expect, test, vi } from "vitest";
vi.mock("axios", () => {
  const axiosLike = {
    create: vi.fn(() => axiosLike),
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: axiosLike,
    create: axiosLike.create,
    isAxiosError: () => false,
  };
});

import { drainInFlight } from "./run-turn.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { EXCLUSIVE } from "../tools/concurrency.js";
import { frameUntrustedToolResultContent } from "../tools/untrusted-tool-result-framing.js";
import { findToolTurnValidationIssue } from "../llm/tool-turn-validator.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { TurnState, UserMessage, AttachmentMessage } from "./turn-state.js";
import type { LLMMessage } from "../llm/types.js";
import type { TurnContext } from "./turn-context.js";
import type { Session } from "./session.js";

function mockRegistry(
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult>,
): ToolRegistry {
  return {
    tools: [],
    toLLMTools(): LLMTool[] {
      return [];
    },
    dispatch,
  };
}

function mkState(): TurnState {
  return {
    messages: [],
    messagesForQuery: [],
    assistantMessages: [],
    toolUseBlocks: [],
    toolResults: [] as Array<UserMessage | AttachmentMessage>,
    streamingToolExecutor: null,
  } as unknown as TurnState;
}

function mkCtxAndSession() {
  const emitted: Array<{ type: string; payload?: unknown }> = [];
  const session = {
    eventLog: { subscribe: () => () => {} },
    services: { registry: { tools: [] } },
    nextInternalSubId: () => `sub-${emitted.length}`,
    emit: (evt: { msg: { type: string; payload?: unknown } }) => {
      emitted.push({ type: evt.msg.type, payload: evt.msg.payload });
    },
  } as unknown as Session;
  const ctx = { subId: "turn-1" } as unknown as TurnContext;
  return { ctx, session, emitted };
}

describe("drainInFlight — AgenC behavior (T6)", () => {
  test("yielded synthetic tool_results are appended to state.messages", async () => {
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => ({ content: "ok" })),
    });
    // Unknown-tool short-circuit synthesizes "No such tool available"
    // without dispatching — deterministic + fast. Matches the
    // orphan-tool_use case drainInFlight is meant to close.
    exec.addTool(
      { type: "tool_use", id: "u1", name: "no.such", input: {} },
      { id: "u1", name: "no.such", arguments: "{}" },
    );
    exec.addTool(
      { type: "tool_use", id: "u2", name: "no.such.other", input: {} },
      { id: "u2", name: "no.such.other", arguments: "{}" },
    );

    const state = mkState();
    (state as unknown as { streamingToolExecutor: unknown })
      .streamingToolExecutor = exec;
    const { ctx, session, emitted } = mkCtxAndSession();

    await drainInFlight(state, ctx, session);

    // state.messages should have two role:'tool' entries, in order.
    const toolMsgs = state.messages.filter(
      (m: LLMMessage) => m.role === "tool",
    );
    expect(toolMsgs).toHaveLength(2);
    expect((toolMsgs[0] as { toolCallId: string }).toolCallId).toBe("u1");
    expect((toolMsgs[1] as { toolCallId: string }).toolCallId).toBe("u2");
    expect(findToolTurnValidationIssue(state.messages)).toBeNull();
    // state.toolResults mirrors the same model-safe records.
    expect(state.toolResults).toHaveLength(2);
    expect((state.toolResults[0] as UserMessage).toolCallId).toBe("u1");
    // tool_call_completed events emitted with isError=true.
    const completedEvents = emitted.filter(
      (e) => e.type === "tool_call_completed",
    );
    expect(completedEvents).toHaveLength(2);
    const payload0 = completedEvents[0]!.payload as {
      callId: string;
      isError: boolean;
      result: string;
    };
    expect(payload0.callId).toBe("u1");
    expect(payload0.isError).toBe(true);
    expect(payload0.result).toContain("No such tool available");
    // Executor reference is cleared so the next iteration starts fresh.
    expect(
      (state as unknown as { streamingToolExecutor: unknown })
        .streamingToolExecutor,
    ).toBeNull();
  });

  test("is a no-op when no executor is attached", async () => {
    const state = mkState();
    const { ctx, session, emitted } = mkCtxAndSession();
    await drainInFlight(state, ctx, session);
    expect(state.messages).toEqual([]);
    expect(state.toolResults).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("drains in-flight exclusive tool, pairs tool_use with real result", async () => {
    let resolveExec!: () => void;
    const registry = mockRegistry(async (call) => {
      await new Promise<void>((r) => {
        resolveExec = r;
      });
      return { content: `real-${call.id}` };
    });
    const exec = new StreamingToolExecutor({
      registry,
      runToolUseFn: (call) => registry.dispatch(call),
    });
    exec.setConcurrencyClassFor("Write", EXCLUSIVE);
    exec.addTool(
      { type: "tool_use", id: "w1", name: "Write", input: {} },
      { id: "w1", name: "Write", arguments: "{}" },
    );

    const state = mkState();
    (state as unknown as { streamingToolExecutor: unknown })
      .streamingToolExecutor = exec;
    const { ctx, session, emitted } = mkCtxAndSession();

    // Resolve the in-flight tool shortly after drainInFlight starts
    // so getRemainingResults sees one completed result.
    setTimeout(() => resolveExec(), 10);

    await drainInFlight(state, ctx, session);

    const toolMsgs = state.messages.filter(
      (m: LLMMessage) => m.role === "tool",
    );
    expect(toolMsgs).toHaveLength(1);
    expect(
      (toolMsgs[0] as { toolCallId: string; content: string }).toolCallId,
    ).toBe("w1");
    expect(
      (toolMsgs[0] as { toolCallId: string; content: string }).content,
    ).toBe(frameUntrustedToolResultContent("Write", "real-w1", "workspace"));
    expect(findToolTurnValidationIssue(state.messages)).toBeNull();
    expect(
      (emitted.find((event) => event.type === "tool_call_completed")?.payload as {
        result: string;
      }).result,
    ).toBe("real-w1");
  });

  test("emits warning on drain failure without throwing", async () => {
    // Build an executor whose getRemainingResults throws mid-iterate.
    const badExec = {
      close: () => {},
      getRemainingResults: async function* () {
        yield {
          toolCall: { id: "x1", name: "x" },
          result: { content: "one" },
          status: "completed" as const,
        };
        throw new Error("drain-failed");
      },
    };
    const state = mkState();
    (state as unknown as { streamingToolExecutor: unknown })
      .streamingToolExecutor = badExec;
    const { ctx, session, emitted } = mkCtxAndSession();

    await expect(drainInFlight(state, ctx, session)).resolves.toBeUndefined();

    const warnings = emitted.filter((e) => e.type === "warning");
    expect(warnings).toHaveLength(1);
    const payload = warnings[0]!.payload as { cause: string; message: string };
    expect(payload.cause).toBe("drain_in_flight_failed");
    expect(payload.message).toContain("drain-failed");
  });
});
