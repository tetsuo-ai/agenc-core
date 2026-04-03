import { describe, expect, it, vi } from "vitest";
import { callWithFallback } from "./chat-executor-fallback.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "./policy.js";
import { LLMServerError } from "./errors.js";
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
  it("falls through to a second same-family model after a transient server error", async () => {
    const failingProvider = {
      ...createMockProvider({
        name: "grok",
        chat: vi.fn().mockRejectedValue(
          new LLMServerError("grok", 503, "temporary outage"),
        ),
      }),
      config: { model: "grok-4-1-fast-non-reasoning" },
    } as LLMProvider & { config: { model: string } };
    const succeedingProvider = {
      ...createMockProvider({
        name: "grok",
        chat: vi.fn().mockResolvedValue(
          mockResponse({ model: "grok-code-fast-1" }),
        ),
      }),
      config: { model: "grok-code-fast-1" },
    } as LLMProvider & { config: { model: string } };

    const result = await callWithFallback(
      {
        providers: [failingProvider, succeedingProvider],
        cooldowns: new Map(),
        promptBudget: {},
        retryPolicyMatrix: DEFAULT_LLM_RETRY_POLICY_MATRIX,
        cooldownMs: 1_000,
        maxCooldownMs: 60_000,
      },
      [{ role: "user", content: "continue" }],
    );

    expect(failingProvider.chat.mock.calls.length).toBeGreaterThan(0);
    expect(succeedingProvider.chat).toHaveBeenCalledOnce();
    expect(result.response.model).toBe("grok-code-fast-1");
    expect(result.providerName).toBe("grok");
  });

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

  it("uses non-stream chat when streaming is explicitly disabled", async () => {
    const provider = createMockProvider();
    const onStreamChunk = vi.fn();

    await callWithFallback(
      createDeps(provider),
      [{ role: "user", content: "reply with exactly ACK" }],
      onStreamChunk,
      undefined,
      {
        callPhase: "initial",
        toolChoice: "none",
        disableStreaming: true,
      },
    );

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(provider.chatStream).not.toHaveBeenCalled();
  });
});
