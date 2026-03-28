import { describe, expect, it, vi } from "vitest";
import { callWithFallback } from "./chat-executor-fallback.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "./policy.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";

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
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name: "primary",
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createDeps(provider: LLMProvider) {
  return {
    providers: [provider],
    cooldowns: new Map(),
    promptBudget: {},
    retryPolicyMatrix: DEFAULT_LLM_RETRY_POLICY_MATRIX,
    cooldownMs: 1_000,
    maxCooldownMs: 60_000,
  };
}

describe("callWithFallback", () => {
  it("uses non-stream chat for tool follow-up turns that still require tools", async () => {
    const provider = createMockProvider({
      chat: vi.fn().mockResolvedValue(
        mockResponse({
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
        }),
      ),
    });

    await callWithFallback(
      createDeps(provider),
      [{ role: "user", content: "continue" }],
      vi.fn(),
      undefined,
      {
        callPhase: "tool_followup",
        toolChoice: "required",
      },
    );

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(provider.chatStream).not.toHaveBeenCalled();
  });

  it("keeps streaming enabled for tool follow-up final-answer turns", async () => {
    const provider = createMockProvider();
    const onStreamChunk = vi.fn();

    await callWithFallback(
      createDeps(provider),
      [{ role: "user", content: "continue" }],
      onStreamChunk,
      undefined,
      {
        callPhase: "tool_followup",
        toolChoice: "none",
      },
    );

    expect(provider.chatStream).toHaveBeenCalledOnce();
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
