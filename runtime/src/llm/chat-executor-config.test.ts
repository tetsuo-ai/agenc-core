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

// ============================================================================
// Tests for chat-executor-config behavior:
//   - resolveRoutingDecision: allowedTools enforcement at dispatch time
// ============================================================================

describe("ChatExecutor configuration and routing decisions", () => {
  describe("allowedTools routing", () => {
    it("allowedTools rejects disallowed tool name", async () => {
      const toolHandler = vi.fn().mockResolvedValue("should not be called");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "dangerous_tool", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "rejected" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["safe_tool"],
      });
      const result = await executor.execute(createParams());

      expect(toolHandler).not.toHaveBeenCalled();
      expect(result.toolCalls[0].isError).toBe(true);
      expect(result.toolCalls[0].result).toContain("not permitted");
    });
  });
});
