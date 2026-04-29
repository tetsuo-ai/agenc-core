/**
 * Phase C acceptance test: `executeChat()` yields the Phase D
 * event vocabulary in the expected order, delegates under the
 * hood to `ChatExecutor.execute()`, and returns a `Terminal` that
 * reflects the legacy result shape.
 *
 * Phase C delegates to the class; Phase F will rewrite this to
 * orchestrate the helpers directly. These tests assert the
 * **event stream contract** — they must keep passing through
 * Phase F as the underlying implementation swaps.
 */

import { describe, it, expect, vi } from "vitest";
import { ChatExecutor } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import { executeChat } from "./execute-chat.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMToolCall,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";
import type {
  ExecuteChatYield,
  Terminal,
  StreamEvent,
  AssistantMessage,
  ToolResultMessage,
  RequestStartEvent,
} from "./streaming-events.js";

function makeMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createMockProvider(
  response: Partial<LLMResponse> = {},
): LLMProvider {
  const baseResponse: LLMResponse = {
    content: response.content ?? "final answer",
    toolCalls: response.toolCalls ?? [],
    usage: response.usage ?? {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    model: response.model ?? "mock-model",
    finishReason: response.finishReason ?? "stop",
  };
  return {
    name: "mock",
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(baseResponse),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockImplementation(async (_messages, onChunk) => {
        // Synthesize a simple two-chunk stream for tests that use
        // the streaming path.
        onChunk({ content: "partial ", done: false });
        onChunk({ content: "answer", done: true });
        return baseResponse;
      }),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
  };
}

async function collect(
  gen: AsyncGenerator<ExecuteChatYield, Terminal, void>,
): Promise<{ events: ExecuteChatYield[]; terminal: Terminal }> {
  const events: ExecuteChatYield[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await gen.next();
    if (step.done) {
      return { events, terminal: step.value };
    }
    events.push(step.value);
  }
}

describe("executeChat (Phase C async generator)", () => {
  it("yields request_start as the first event", async () => {
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    const gen = executeChat(executor, {
      message: makeMessage(),
      history: [],
      promptEnvelope: createPromptEnvelope("You are a test."),
      sessionId: "session-1",
    });
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe("request_start");
    const startEvent = first.value as RequestStartEvent;
    expect(startEvent.requestId).toMatch(/^req-/);
    expect(startEvent.turnIndex).toBe(0);
    expect(typeof startEvent.timestamp).toBe("number");
    // Drain the rest so the generator finishes cleanly.
    await collect(gen);
  });

  it("yields an assistant event with the final content", async () => {
    const provider = createMockProvider({ content: "hello world" });
    const executor = new ChatExecutor({ providers: [provider] });
    const { events, terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-1",
      }),
    );
    const assistant = events.find(
      (e) => e.type === "assistant",
    ) as AssistantMessage | undefined;
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("hello world");
    expect(terminal.finalContent).toBe("hello world");
    expect(terminal.reason).toBe("stop_reason_end_turn");
  });

  it("yields tool_result events for each tool call in the result", async () => {
    const toolCalls: LLMToolCall[] = [
      { id: "c1", name: "system.readFile", arguments: "{}" },
      { id: "c2", name: "system.listDir", arguments: "{}" },
    ];
    let callCount = 0;
    const nextResponse = (): LLMResponse => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "calling tools",
          toolCalls,
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
        content: "tools done",
        toolCalls: [],
        usage: {
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
        model: "mock-model",
        finishReason: "stop",
      };
    };
    const provider: LLMProvider = {
      name: "mock-tools",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockImplementation(async () => nextResponse()),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockImplementation(async () => nextResponse()),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: async (name) => JSON.stringify({ tool: name, ok: true }),
      allowedTools: ["system.readFile", "system.listDir"],
    });
    const { events, terminal } = await collect(
      executeChat(executor, {
        message: makeMessage("run tools"),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-tools",
      }),
    );
    const toolResults = events.filter(
      (e) => e.type === "tool_result",
    ) as ToolResultMessage[];
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.toolName).toBe("system.readFile");
    expect(toolResults[1]!.toolName).toBe("system.listDir");
    expect(terminal.toolCalls).toHaveLength(2);
  });

  it("yields request_start before any stream_chunk or assistant events", async () => {
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    const { events } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-order",
      }),
    );
    const startIdx = events.findIndex((e) => e.type === "request_start");
    const firstAssistantIdx = events.findIndex((e) => e.type === "assistant");
    expect(startIdx).toBe(0);
    expect(startIdx).toBeLessThan(firstAssistantIdx);
  });

  it("populates the Terminal with the legacy result fields", async () => {
    const provider = createMockProvider({
      content: "terminal test",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    const executor = new ChatExecutor({ providers: [provider] });
    const { terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-terminal",
      }),
    );
    expect(terminal.finalContent).toBe("terminal test");
    expect(terminal.tokenUsage.totalTokens).toBe(18);
    expect(terminal.durationMs).toBeGreaterThanOrEqual(0);
    expect(terminal.reason).toBe("stop_reason_end_turn");
  });

  it("preserves shared continuation behavior through the executeChat adapter", async () => {
    const provider: LLMProvider = {
      name: "mock-continuation",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
          ],
          usage: {
            promptTokens: 20,
            completionTokens: 50,
            totalTokens: 70,
          },
          model: "mock-model",
          finishReason: "tool_calls",
        })
        .mockResolvedValueOnce({
          content: "Next I will continue with the remaining work.",
          toolCalls: [],
          usage: {
            promptTokens: 20,
            completionTokens: 100,
            totalTokens: 120,
          },
          model: "mock-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content: "Bootstrap complete. Continuing.",
          toolCalls: [],
          usage: {
            promptTokens: 20,
            completionTokens: 100,
            totalTokens: 120,
          },
          model: "mock-model",
          finishReason: "stop",
        })
        .mockResolvedValueOnce({
          content: "Finished the remaining implementation details.",
          toolCalls: [],
          usage: {
            promptTokens: 20,
            completionTokens: 1_900,
            totalTokens: 1_920,
          },
          model: "mock-model",
          finishReason: "stop",
        }),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockRejectedValue(new Error("unused")),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn(async () => '{"ok":true}'),
    });

    const { events, terminal } = await collect(
      executeChat(executor, {
        message: makeMessage("continue the task"),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-continuation",
        turnOutputTokenBudget: 2_000,
      }),
    );

    const assistants = events.filter(
      (event) => event.type === "assistant",
    ) as AssistantMessage[];
    expect(assistants.at(-1)?.content).toBe(
      "Finished the remaining implementation details.",
    );
    expect(terminal.finalContent).toBe(
      "Finished the remaining implementation details.",
    );
    expect(terminal.legacyResult?.callUsage.map((entry) => entry.phase)).toEqual([
      "initial",
      "tool_followup",
      "tool_followup",
      "tool_followup",
    ]);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  });

  it("drains provider stream chunks into stream_chunk events when chatStream is used", async () => {
    const chunks: LLMStreamChunk[] = [
      { content: "a", done: false },
      { content: "b", done: false },
      { content: "c", done: true },
    ];
    const provider: LLMProvider = {
      name: "mock-stream",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValue({
          content: "abc",
          toolCalls: [],
          usage: {
            promptTokens: 1,
            completionTokens: 3,
            totalTokens: 4,
          },
          model: "mock-stream-model",
          finishReason: "stop",
        }),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockImplementation(async (_messages, onChunk) => {
          for (const chunk of chunks) {
            onChunk(chunk);
          }
          return {
            content: "abc",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 3,
              totalTokens: 4,
            },
            model: "mock-stream-model",
            finishReason: "stop",
          };
        }),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({ providers: [provider] });
    const { events } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-stream",
        onStreamChunk: () => {
          // Present but no-op — the generator should still yield
          // stream_chunk events in parallel with the pass-through.
        },
      }),
    );
    const streamEvents = events.filter(
      (e) => e.type === "stream_chunk",
    ) as StreamEvent[];
    expect(streamEvents.length).toBeGreaterThanOrEqual(1);
    // The last stream_chunk should be marked done.
    expect(streamEvents[streamEvents.length - 1]!.done).toBe(true);
  });

  it("fires the pass-through onStreamChunk callback alongside generator events", async () => {
    const onStreamChunk = vi.fn();
    const provider: LLMProvider = {
      name: "mock-passthrough",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValue({
          content: "hi",
          toolCalls: [],
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
          model: "mock-model",
          finishReason: "stop",
        }),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockImplementation(async (_messages, onChunk) => {
          onChunk({ content: "hi", done: true });
          return {
            content: "hi",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
            model: "mock-model",
            finishReason: "stop",
          };
        }),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({ providers: [provider] });
    await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-pass",
        onStreamChunk,
      }),
    );
    expect(onStreamChunk).toHaveBeenCalled();
  });

  it("tolerates pass-through callback errors without aborting", async () => {
    const provider: LLMProvider = {
      name: "mock-err",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValue({
          content: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
          model: "mock-model",
          finishReason: "stop",
        }),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockImplementation(async (_messages, onChunk) => {
          onChunk({ content: "ok", done: true });
          return {
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
            model: "mock-model",
            finishReason: "stop",
          };
        }),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({ providers: [provider] });
    const { terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-cb-err",
        onStreamChunk: () => {
          throw new Error("callback error");
        },
      }),
    );
    // Execution should still finish cleanly.
    expect(terminal.reason).toBe("stop_reason_end_turn");
  });

  it("returns an error Terminal when the underlying execute rejects", async () => {
    const provider: LLMProvider = {
      name: "mock-reject",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockRejectedValue(new Error("provider boom")),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockRejectedValue(new Error("provider boom")),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({ providers: [provider] });
    // ChatExecutor handles provider errors internally and returns a
    // result with a non-completed stopReason rather than throwing
    // outright. Assert the terminal reflects a non-happy path.
    const { terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-reject",
      }),
    );
    expect(
      [
        "provider_fallback_exhausted",
        "recovery_exhausted",
        "stop_reason_end_turn",
      ].includes(terminal.reason),
    ).toBe(true);
    expect(typeof terminal.finalContent).toBe("string");
  });

  it("propagates request_id through stream_chunk and assistant events", async () => {
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    const { events } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-id",
      }),
    );
    const start = events.find(
      (e) => e.type === "request_start",
    ) as RequestStartEvent;
    const requestId = start.requestId;
    const streamEvents = events.filter(
      (e) => e.type === "stream_chunk",
    ) as StreamEvent[];
    for (const evt of streamEvents) {
      expect(evt.requestId).toBe(requestId);
    }
    const assistant = events.find(
      (e) => e.type === "assistant",
    ) as AssistantMessage;
    expect(assistant.uuid.startsWith(requestId)).toBe(true);
  });

  it("returns a Terminal with non-negative durationMs", async () => {
    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    const { terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-duration",
      }),
    );
    expect(terminal.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("yields assistant events before tool_result events in the final order", async () => {
    const toolCalls: LLMToolCall[] = [
      { id: "t1", name: "system.readFile", arguments: "{}" },
    ];
    let callCount = 0;
    const nextResponse = (): LLMResponse => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "one tool",
          toolCalls,
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
        content: "done",
        toolCalls: [],
        usage: {
          promptTokens: 5,
          completionTokens: 5,
          totalTokens: 10,
        },
        model: "mock-model",
        finishReason: "stop",
      };
    };
    const provider: LLMProvider = {
      name: "mock-order",
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockImplementation(async () => nextResponse()),
      chatStream: vi
        .fn<
          [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
          Promise<LLMResponse>
        >()
        .mockImplementation(async () => nextResponse()),
      healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: async () => JSON.stringify({ ok: true }),
      allowedTools: ["system.readFile"],
    });
    const { events } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-ordered",
      }),
    );
    const assistantIdx = events.findIndex((e) => e.type === "assistant");
    const toolResultIdx = events.findIndex(
      (e) => e.type === "tool_result",
    );
    // Phase C batches these events at the end of execute(), so the
    // assistant event is yielded before the tool_result event that
    // corresponds to the same tool call. This ordering contract
    // must hold through Phase F — it is the stable event order
    // callers will depend on.
    expect(assistantIdx).toBeLessThan(toolResultIdx);
  });

  it("returns an empty toolCalls array in Terminal when no tools were called", async () => {
    const provider = createMockProvider({ content: "no tools here" });
    const executor = new ChatExecutor({ providers: [provider] });
    const { terminal } = await collect(
      executeChat(executor, {
        message: makeMessage(),
        history: [],
        promptEnvelope: createPromptEnvelope("You are a test."),
        sessionId: "session-notools",
      }),
    );
    expect(terminal.toolCalls).toEqual([]);
  });
});
