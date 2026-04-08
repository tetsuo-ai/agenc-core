import { describe, expect, it, vi } from "vitest";

import { ChatBudgetExceededError, ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
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
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: "/tmp/chat-executor-test-workspace" },
    ...overrides,
  };
}

function buildLongHistory(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message ${i}`,
  }));
}

// ============================================================================
// Tests for chat-executor-state trackTokenUsage behavior via execute() surface
// ============================================================================

describe("ChatExecutor state tracking", () => {
  describe("token budget", () => {
    it("throws ChatBudgetExceededError when compaction fails", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: {
                promptTokens: 500,
                completionTokens: 500,
                totalTokens: 1000,
              },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: {
                promptTokens: 500,
                completionTokens: 500,
                totalTokens: 1000,
              },
            }),
          )
          // Third call triggers compaction — summarization fails
          .mockRejectedValueOnce(new Error("LLM unavailable")),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      // First call: 1000 tokens used
      await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      // Second call: 2000 tokens total, but 1000 < 1500 so passes
      await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      // Third call: 2000 >= 1500. Compaction attempted, fails, throws original error.
      await expect(
        executor.execute(createParams({ history: buildLongHistory(10) })),
      ).rejects.toThrow(ChatBudgetExceededError);
    });

    it("accumulates across multiple executions; resetSessionTokens clears", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
          }),
        ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 500,
      });

      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);

      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(200);

      executor.resetSessionTokens("session-1");
      expect(executor.getSessionTokenUsage("session-1")).toBe(0);

      // Can use again after reset
      await executor.execute(createParams());
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);
    });
  });
});
