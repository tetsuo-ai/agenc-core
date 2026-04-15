import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import { createPromptEnvelope } from "./prompt-envelope.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

// ============================================================================
// Shared helpers
// ============================================================================

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<
        [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
        Promise<LLMResponse>
      >()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
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

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage(),
    history: [],
    promptEnvelope: createPromptEnvelope("You are a helpful assistant."),
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: "/tmp/chat-executor-test-workspace" },
    ...overrides,
  };
}

// ============================================================================
// Tests for chat-executor-model-orchestration.callModelForPhase behavior:
//   - per-call budget/recall overrides fed through the model call path
//   - provider chat options (routed tool subset, trace callbacks)
//   - route expansion on misses
// ============================================================================

describe("ChatExecutor model orchestration", () => {
  describe("per-call budget overrides", () => {
    it("maxToolRounds enforced — stops after limit", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "looping",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 3,
      });
      const result = await executor.execute(createParams());

      // 1 initial + 3 rounds = 4 LLM calls
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(4);
      expect(result.toolCalls.filter((call) => call.synthetic)).toHaveLength(1);
      expect(result.runtimeContractSnapshot?.toolProtocol.repairCount).toBe(1);
    });

    it("per-call maxToolRounds overrides constructor default", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "looping",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
          }),
        ),
      });

      // Constructor default is 10, but per-call override caps at 2
      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({ maxToolRounds: 2 }),
      );

      // 1 initial + 2 rounds = 3 LLM calls
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls.filter((call) => call.synthetic)).toHaveLength(1);
    });

    it("per-call maxModelRecalls=0 removes the recall cap", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "looping",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "done",
              finishReason: "stop",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxModelRecallsPerRequest: 1,
      });
      const result = await executor.execute(
        createParams({ maxModelRecallsPerRequest: 0 }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("done");
    });

    it("per-call toolBudgetPerRequest overrides constructor default", async () => {
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "two tools",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "tool", arguments: "{}" },
                { id: "tc-2", name: "tool", arguments: "{}" },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        toolBudgetPerRequest: 5,
      });
      const result = await executor.execute(
        createParams({ toolBudgetPerRequest: 1 }),
      );

      expect(toolHandler).toHaveBeenCalledTimes(1);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls.filter((call) => call.synthetic)).toHaveLength(1);
      expect(result.stopReason).toBe("budget_exceeded");
    });
  });

  describe("provider chat options and routed tool subset", () => {
    it("passes routed tool subset to provider chat options", async () => {
      const provider = createMockProvider("primary");
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash", "system.readFile"],
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.readFile",
      ]);
    });

    it("passes provider trace callbacks through with logical call metadata", async () => {
      const providerTraceEvents: unknown[] = [];
      const provider = createMockProvider("primary", {
        chat: vi.fn(async (_messages, options) => {
          options?.trace?.onProviderTraceEvent?.({
            kind: "request",
            transport: "chat",
            provider: "primary",
            model: "mock-model",
            payload: { tool_choice: "required" },
          });
          return mockResponse();
        }),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => providerTraceEvents.push(event),
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.trace?.includeProviderPayloads).toBe(true);
      expect(providerTraceEvents).toEqual([
        {
          kind: "request",
          transport: "chat",
          provider: "primary",
          model: "mock-model",
          callIndex: 1,
          callPhase: "initial",
          payload: { tool_choice: "required" },
        },
      ]);
    });

    it("passes allowedTools to provider chat options when no routing subset is active", async () => {
      const provider = createMockProvider("primary");
      const executor = new ChatExecutor({
        providers: [provider],
        allowedTools: ["desktop.bash", "desktop.text_editor"],
      });

      await executor.execute(createParams());

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      expect(options?.toolRouting?.allowedToolNames).toEqual([
        "desktop.bash",
        "desktop.text_editor",
      ]);
    });

    it("expands routed tool subset once when model requests a missed tool", async () => {
      const toolHandler = vi.fn().mockResolvedValue("unused");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.httpGet",
                  arguments: '{\"url\":\"https://example.com\"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash"],
            expandedToolNames: ["system.bash", "system.httpGet"],
            expandOnMiss: true,
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as LLMChatOptions | undefined;
      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
      ]);
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.httpGet",
      ]);
      expect(result.toolRoutingSummary).toEqual({
        enabled: true,
        initialToolCount: 1,
        finalToolCount: 2,
        routeMisses: 1,
        expanded: true,
      });
      expect(toolHandler).not.toHaveBeenCalled();
    });

    it("emits execution trace events for routed misses and route expansion", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("unused");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.httpGet",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(
        createParams({
          toolRouting: {
            routedToolNames: ["system.bash"],
            expandedToolNames: ["system.bash", "system.httpGet"],
            expandOnMiss: true,
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "model_call_prepared",
            phase: "initial",
            payload: expect.objectContaining({
              routedToolNames: ["system.bash"],
            }),
          }),
          expect.objectContaining({
            type: "tool_rejected",
            phase: "tool_followup",
            payload: expect.objectContaining({
              tool: "system.httpGet",
              routingMiss: true,
              expandAfterRound: true,
            }),
          }),
          expect.objectContaining({
            type: "route_expanded",
            phase: "tool_followup",
            payload: expect.objectContaining({
              previousRoutedToolNames: ["system.bash"],
              nextRoutedToolNames: ["system.bash", "system.httpGet"],
            }),
          }),
        ]),
      );
    });
  });
});
