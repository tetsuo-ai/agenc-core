import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
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
// Tests for chat-executor-in-flight-compaction.maybeCompactInFlightCallInput
// behavior: soft-threshold compaction while the hard session budget is unlimited.
// ============================================================================

describe("ChatExecutor in-flight compaction", () => {
  describe("soft compaction threshold", () => {
    it("uses a soft compaction threshold even when the hard session budget is unlimited", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "Soft-threshold summary" }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "response after soft-threshold compaction",
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 0,
        sessionCompactionThreshold: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      const result = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      expect(result.compacted).toBe(true);
      expect(result.content).toBe("response after soft-threshold compaction");
    });

    it("treats soft-threshold compaction failures as best-effort when the hard budget is unlimited", async () => {
      let calls = 0;
      const provider = createMockProvider("primary", {
        chat: vi.fn(async () => {
          calls += 1;
          if (calls <= 2) {
            return mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            });
          }
          if (calls === 3) {
            throw new Error("summary unavailable");
          }
          return mockResponse({
            content: "response after skipped compaction",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          });
        }),
      });
      const onCompaction = vi.fn();
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 0,
        sessionCompactionThreshold: 1500,
        onCompaction,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
          unknown: { maxRetries: 0 },
        },
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      const result = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      expect(result.compacted).toBe(false);
      expect(result.content).toBe("response after skipped compaction");
      expect(onCompaction).not.toHaveBeenCalled();
    });
  });
});
