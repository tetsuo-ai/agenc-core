/**
 * Phase B acceptance test: the tool loop dispatches consecutive
 * concurrency-safe tool calls in parallel via `Promise.all`,
 * matching the `claude_code/services/tools/toolOrchestration.ts`
 * shape. Before Phase B, the dispatch was serial regardless of the
 * `isConcurrencySafe` predicate — the predicate only drove
 * telemetry, not execution.
 *
 * The parallel behavior is verified via wall-clock timing: 3 tool
 * calls that each sleep for T ms should complete in ~T ms (with
 * slack) when dispatched in parallel, not ~3T ms.
 */

import { describe, it, expect, vi } from "vitest";
import { ChatExecutor } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

function makeToolCall(id: string, name: string): LLMToolCall {
  return {
    id,
    name,
    arguments: "{}",
  };
}

function mockFirstCallThenStop(
  toolCalls: readonly LLMToolCall[],
): LLMProvider {
  let callCount = 0;
  return {
    name: "mock-parallel",
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: "dispatching tools",
            toolCalls: [...toolCalls],
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            },
            model: "mock-model",
            finishReason: "tool_calls",
          };
        }
        return {
          content: "all done",
          toolCalls: [],
          usage: {
            promptTokens: 5,
            completionTokens: 5,
            totalTokens: 10,
          },
          model: "mock-model",
          finishReason: "stop",
        };
      }),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockResolvedValue({
        content: "stream fallback",
        toolCalls: [],
        usage: {
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
        model: "mock-model",
        finishReason: "stop",
      }),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
  };
}

function createMessage(): GatewayMessage {
  return {
    id: "msg-parallel",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-parallel",
    content: "run parallel tools",
    timestamp: Date.now(),
    scope: "dm",
  };
}

const SLEEP_MS = 120;

function makeSlowToolHandler() {
  const invocations: string[] = [];
  const timings: { name: string; start: number; end: number }[] = [];
  const handler = async (
    name: string,
    _args: Record<string, unknown>,
  ): Promise<string> => {
    const start = Date.now();
    invocations.push(name);
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    const end = Date.now();
    timings.push({ name, start, end });
    return JSON.stringify({ ok: true, tool: name });
  };
  return { handler, invocations, timings };
}

describe("chat-executor parallel tool dispatch (Phase B)", () => {
  it("dispatches 3 concurrency-safe tool calls in parallel via Promise.all", async () => {
    const toolCalls = [
      makeToolCall("c1", "system.readFile"),
      makeToolCall("c2", "system.readFile"),
      makeToolCall("c3", "system.readFile"),
    ];
    const provider = mockFirstCallThenStop(toolCalls);
    const { handler, timings } = makeSlowToolHandler();

    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: handler,
      isConcurrencySafe: () => true,
      allowedTools: ["system.readFile"],
    });

    const started = Date.now();
    await executor.execute({
      message: createMessage(),
      history: [],
      promptEnvelope: createPromptEnvelope("You are a test assistant."),
      sessionId: "session-parallel",
    });
    const elapsed = Date.now() - started;

    // All three tool calls must have been invoked.
    expect(timings).toHaveLength(3);

    // Parallel dispatch proof: the round's total wall time must be
    // less than 2x the sleep duration. Serial would be ~3x.
    // Using 2x as a generous ceiling that accounts for scheduler slop
    // but still excludes the serial (3x) path.
    expect(elapsed).toBeLessThan(SLEEP_MS * 2);

    // Overlap proof: the start-to-start spread of the three tools
    // must be much tighter than the sleep duration. If they ran
    // serially, start[2] - start[0] would be ~2 * SLEEP_MS.
    const sortedStarts = timings
      .map((t) => t.start)
      .sort((a, b) => a - b);
    const startSpread =
      sortedStarts[sortedStarts.length - 1]! - sortedStarts[0]!;
    expect(startSpread).toBeLessThan(SLEEP_MS / 2);
  });

  it("serializes calls when isConcurrencySafe returns false", async () => {
    const toolCalls = [
      makeToolCall("c1", "system.readFile"),
      makeToolCall("c2", "system.readFile"),
      makeToolCall("c3", "system.readFile"),
    ];
    const provider = mockFirstCallThenStop(toolCalls);
    const { handler, timings } = makeSlowToolHandler();

    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: handler,
      isConcurrencySafe: () => false,
      allowedTools: ["system.readFile"],
    });

    const started = Date.now();
    await executor.execute({
      message: createMessage(),
      history: [],
      promptEnvelope: createPromptEnvelope("You are a test assistant."),
      sessionId: "session-serial",
    });
    const elapsed = Date.now() - started;

    expect(timings).toHaveLength(3);

    // Serial dispatch proof: the round must take at least ~2x sleep
    // (three sequential sleeps of SLEEP_MS, minus a little slack).
    expect(elapsed).toBeGreaterThanOrEqual(SLEEP_MS * 2);

    // Start spread must be at least ~2x sleep when serialized.
    const sortedStarts = timings
      .map((t) => t.start)
      .sort((a, b) => a - b);
    const startSpread =
      sortedStarts[sortedStarts.length - 1]! - sortedStarts[0]!;
    expect(startSpread).toBeGreaterThanOrEqual(SLEEP_MS);
  });

  it("serializes calls when no isConcurrencySafe predicate is supplied", async () => {
    const toolCalls = [
      makeToolCall("c1", "system.readFile"),
      makeToolCall("c2", "system.readFile"),
    ];
    const provider = mockFirstCallThenStop(toolCalls);
    const { handler, timings } = makeSlowToolHandler();

    // Note: no `isConcurrencySafe` in config.
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: handler,
      allowedTools: ["system.readFile"],
    });

    const started = Date.now();
    await executor.execute({
      message: createMessage(),
      history: [],
      promptEnvelope: createPromptEnvelope("You are a test assistant."),
      sessionId: "session-default-serial",
    });
    const elapsed = Date.now() - started;

    expect(timings).toHaveLength(2);
    // Two sequential sleeps => at least ~1.5x sleep duration.
    expect(elapsed).toBeGreaterThanOrEqual(SLEEP_MS * 1.5);
  });
});
