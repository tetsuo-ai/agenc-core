import { beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "./errors.js";

// ============================================================================
// Test helpers
// ============================================================================
//
// This thinned ChatExecutor integration suite covers the full execute()
// pipeline via smoke tests for basic operation, provider fallback, cooldown
// state, core tool-loop behavior, narrative safeguards, and constructor
// edge cases. Module-level behavior lives in sibling files:
//
//   chat-executor-ctx-helpers.test.ts          recovery hints, stop reason
//   chat-executor-state.test.ts                token budget and session state
//   chat-executor-config.test.ts               routing decisions
//   chat-executor-usage.test.ts                accumulateUsage / createCallUsageRecord
//   chat-executor-in-flight-compaction.test.ts soft-threshold compaction
//   chat-executor-history-compaction.test.ts   hard-budget compactHistory
//   chat-executor-context-injection.test.ts    skill/memory/progress injection
//   chat-executor-model-orchestration.test.ts  per-call budgets and tool routing
//   chat-executor-init.test.ts                 message normalization / prompt budget
//   chat-executor-request.test.ts              streaming wiring, stateful summary
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

function safeJson(value: unknown): string {
  return JSON.stringify(value);
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
      .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
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
// Tests
// ============================================================================

describe("ChatExecutor", () => {
  // --------------------------------------------------------------------------
  // Basic operation
  // --------------------------------------------------------------------------

  describe("basic operation", () => {
    it("primary provider returns response with correct result shape", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect(result.toolCalls).toEqual([]);
      expect(result.completionState).toBe("completed");
      expect(result.tokenUsage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(result.callUsage).toHaveLength(1);
      expect(result.callUsage[0]).toMatchObject({
        callIndex: 1,
        phase: "initial",
        provider: "primary",
        model: "mock-model",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      expect(result.callUsage[0].beforeBudget.messageCount).toBeGreaterThan(0);
      expect(result.callUsage[0].afterBudget.messageCount).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("includes system prompt as first message", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams({ promptEnvelope: createPromptEnvelope("Be helpful.") }));

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[0]).toMatchObject({ role: "system", content: "Be helpful." });
    });

    it("uses chatStream when onStreamChunk provided", async () => {
      const onStreamChunk = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk,
      });

      await executor.execute(createParams());

      expect(provider.chatStream).toHaveBeenCalledOnce();
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("usedFallback is false when primary succeeds", async () => {
      const primary = createMockProvider("primary");
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.usedFallback).toBe(false);
      expect(result.provider).toBe("primary");
    });
  });

  // --------------------------------------------------------------------------
  // Fallback
  // --------------------------------------------------------------------------

  describe("fallback", () => {
    it("falls back to secondary on LLMTimeoutError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMTimeoutError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("falls back to secondary on LLMServerError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("primary", 500, "Internal error"),
          ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("falls back to secondary on LLMRateLimitError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMRateLimitError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("does NOT fall back on LLMAuthenticationError", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMAuthenticationError("primary", 401)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMAuthenticationError,
      );
      expect(secondary.chat).not.toHaveBeenCalled();
    });

    it("does NOT fall back on LLMProviderError (non-transient)", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMProviderError("primary", "Bad request", 400),
          ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMProviderError,
      );
      expect(secondary.chat).not.toHaveBeenCalled();
    });

    it("falls back when a provider returns a malformed response envelope", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
          .mockResolvedValue(undefined as unknown as LLMResponse),
      });
      const secondary = createMockProvider("secondary", {
        chat: vi
          .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
          .mockResolvedValue(mockResponse({ content: "secondary recovered" })),
      });
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
    });

    it("retries transient provider failures on same provider before fallback", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValueOnce(
            new LLMServerError("primary", 503, "temporary outage"),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        retryPolicyMatrix: {
          provider_error: {
            maxRetries: 1,
          },
        },
      });

      const result = await executor.execute(createParams());
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("does not retry deterministic message validation failures", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(
          new LLMMessageValidationError("primary", {
            validationCode: "missing_tool_call_link",
            messageIndex: 3,
            reason: "tool message missing assistant tool_calls",
          }),
        ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
      });

      await expect(executor.execute(createParams())).rejects.toThrow(
        LLMMessageValidationError,
      );
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it("usedFallback is true when fallback used", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockRejectedValue(new LLMTimeoutError("primary", 5000)),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      const result = await executor.execute(createParams());

      expect(result.usedFallback).toBe(true);
    });

    it("falls back on transient provider outage text without status", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new Error("Service temporarily unavailable.")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      const result = await executor.execute(createParams());

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
      expect((primary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
      expect((secondary.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("all providers fail — throws last error", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("secondary", 503, "overloaded"),
          ),
      });
      const executor = new ChatExecutor({ providers: [primary, secondary] });

      await expect(executor.execute(createParams())).rejects.toThrow(
        "overloaded",
      );
    });

    it("annotates thrown provider failures with canonical stop reason", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMProviderError("primary", "Bad request", 400)),
      });
      const executor = new ChatExecutor({ providers: [primary] });

      const caught = await executor.execute(createParams()).catch((error) => error);
      expect(caught).toBeInstanceOf(LLMProviderError);
      expect((caught as { stopReason?: string }).stopReason).toBe("provider_error");
      expect((caught as { stopReasonDetail?: string }).stopReasonDetail).toContain(
        "provider_error",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Cooldown
  // --------------------------------------------------------------------------

  describe("cooldown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("provider retried after cooldown expires", async () => {
      const providerTraceEvents: Array<Record<string, unknown>> = [];
      let primaryCallCount = 0;
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          primaryCallCount++;
          if (primaryCallCount === 1) {
            return Promise.reject(new LLMServerError("primary", 500, "down"));
          }
          return Promise.resolve(mockResponse());
        }),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // First call — primary fails
      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );

      // Advance past cooldown
      vi.advanceTimersByTime(11_000);

      // Second call — primary retried and succeeds
      const result = await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );
      expect(result.provider).toBe("primary");
      expect(result.usedFallback).toBe(false);
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_applied",
            }),
          }),
          expect.objectContaining({
            kind: "response",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_cleared",
              failures: 1,
            }),
          }),
        ]),
      );

      vi.useRealTimers();
    });

    it("uses retryAfterMs from LLMRateLimitError when available", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValueOnce(new LLMRateLimitError("primary", 30_000))
          .mockResolvedValue(mockResponse()),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          rate_limited: { maxRetries: 0 },
        },
      });

      await executor.execute(createParams());

      // Advance 15s — still within the 30s retryAfter cooldown
      vi.advanceTimersByTime(15_000);
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledOnce(); // still skipped

      // Advance past 30s total
      vi.advanceTimersByTime(16_000);
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledTimes(2); // retried

      vi.useRealTimers();
    });

    it("all providers in cooldown throws descriptive error", async () => {
      const providerTraceEvents: Array<Record<string, unknown>> = [];
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary", {
        chat: vi
          .fn()
          .mockRejectedValue(
            new LLMServerError("secondary", 503, "overloaded"),
          ),
      });
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 60_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // First call — both fail, both enter cooldown
      await expect(
        executor.execute(
          createParams({
            trace: {
              includeProviderPayloads: true,
              onProviderTraceEvent: (event) =>
                providerTraceEvents.push(event as Record<string, unknown>),
            },
          }),
        ),
      ).rejects.toThrow("overloaded");

      // Second call — both in cooldown, no provider tried
      vi.advanceTimersByTime(1_000);
      await expect(
        executor.execute(
          createParams({
            trace: {
              includeProviderPayloads: true,
              onProviderTraceEvent: (event) =>
                providerTraceEvents.push(event as Record<string, unknown>),
            },
          }),
        ),
      ).rejects.toThrow("All providers are in cooldown");
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_skip",
            }),
          }),
          expect.objectContaining({
            kind: "error",
            provider: "secondary",
            payload: expect.objectContaining({
              reason: "provider_cooldown_skip",
            }),
          }),
          expect.objectContaining({
            kind: "error",
            provider: "chat-executor",
            payload: expect.objectContaining({
              reason: "all_providers_in_cooldown",
              providers: [
                expect.objectContaining({
                  provider: "primary",
                  failures: 1,
                }),
                expect.objectContaining({
                  provider: "secondary",
                  failures: 1,
                }),
              ],
            }),
          }),
        ]),
      );

      vi.useRealTimers();
    });

    it("re-checks cooldown timing after earlier provider latency before skipping later providers", async () => {
      const primary = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(
          () =>
            new Promise<LLMResponse>((_resolve, reject) => {
              setTimeout(
                () => reject(new LLMServerError("primary", 500, "slow fail")),
                2_000,
              );
            }),
        ),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      (executor as unknown as {
        cooldowns: Map<string, { availableAt: number; failures: number }>;
      }).cooldowns.set("secondary", {
        availableAt: Date.now() + 1_000,
        failures: 1,
      });

      const execution = executor.execute(createParams());
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await execution;

      expect(result.provider).toBe("secondary");
      expect(result.usedFallback).toBe(true);
      expect(secondary.chat).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it("linear backoff capped at maxCooldownMs", async () => {
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 100_000,
        maxCooldownMs: 200_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
        },
      });

      // Failure 1: cooldown = min(100_000 * 1, 200_000) = 100_000
      await executor.execute(createParams());

      // Failure 2: cooldown = min(100_000 * 2, 200_000) = 200_000
      vi.advanceTimersByTime(100_001);
      await executor.execute(createParams());

      // Failure 3: cooldown = min(100_000 * 3, 200_000) = 200_000 (capped)
      vi.advanceTimersByTime(200_001);
      await executor.execute(createParams());

      // After 200_001ms primary should be retried (cap held at 200_000)
      vi.advanceTimersByTime(200_001);
      // Primary fails again, but the point is it was tried (not skipped forever)
      await executor.execute(createParams());
      expect(primary.chat).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // Tool loop
  // --------------------------------------------------------------------------

  describe("tool loop", () => {
    it("single tool call round executes correctly", async () => {
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"query":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final answer" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("final answer");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("search");
      expect(result.toolCalls[0].args).toEqual({ query: "test" });
      expect(result.toolCalls[0].result).toBe("tool result");
      expect(result.toolCalls[0].isError).toBe(false);
      expect(result.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(toolHandler).toHaveBeenCalledWith("search", { query: "test" });
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "initial",
        "tool_followup",
      ]);
      expect(result.callUsage).toHaveLength(2);

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const assistantWithToolCall = followupMessages.find(
        (m) => m.role === "assistant" && Array.isArray(m.toolCalls),
      );
      expect(assistantWithToolCall?.toolCalls).toEqual([
        { id: "tc-1", name: "search", arguments: '{"query":"test"}' },
      ]);
    });

    it("continues the tool loop when tool calls are present even if finishReason is stop", async () => {
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "stop",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"query":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final answer" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("final answer");
      expect(toolHandler).toHaveBeenCalledWith("search", { query: "test" });
      expect(result.runtimeContractSnapshot?.toolProtocol.repairCount).toBe(0);
    });

    it("fails closed when the provider reports tool_calls without any tool calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "I will keep going.",
            finishReason: "tool_calls",
            toolCalls: [],
          }),
        ),
      });

      const executor = new ChatExecutor({ providers: [provider] });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("validation_error");
      expect(result.content).toContain(
        "Provider returned finishReason \"tool_calls\" without any tool calls",
      );
      expect(result.runtimeContractSnapshot?.toolProtocol.violationCount).toBe(1);
    });


    it("does not turn an empty post-tool follow-up into a fake tool-result success", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"entries":["src","package.json"]}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "", finishReason: "stop" }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("no_progress");
      expect(result.content).toContain(
        "Model returned empty content after tool follow-up",
      );
      expect(result.content).not.toContain("Operation completed. Result");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual(
        expect.objectContaining({
          name: "system.listDir",
          args: { path: "." },
          result: '{"entries":["src","package.json"]}',
          isError: false,
        }),
      );
    });

    it("fails closed when the terminal provider payload is empty after tool use", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"status":"requires_input"}');
      const onStreamChunk = vi.fn();
      const provider = createMockProvider("primary", {
        chatStream: vi
          .fn<
            [LLMMessage[], StreamProgressCallback, LLMChatOptions?],
            Promise<LLMResponse>
          >()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "agenc.getReputationSummary", arguments: "{}" },
              ],
            }),
          )
          .mockImplementationOnce(async (_messages, stream) => {
            stream({ content: "Yes, but your signer wallet ", done: false });
            stream({ content: "already has registered agents.", done: true });
            return mockResponse({ content: "", finishReason: "stop" });
          }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        onStreamChunk,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("no_progress");
      expect(result.content).toBe(
        "Model returned empty content after tool follow-up; refusing to surface raw tool output as the final answer.",
      );
      expect(onStreamChunk).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Yes, but your signer wallet " }),
      );
      expect(result.content).toContain("Model returned empty content");
    });

    it("continues after a successful tool turn while token budget remains", async () => {
      const toolHandler = vi.fn().mockResolvedValue('{"ok":true}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
              ],
              usage: {
                promptTokens: 25,
                completionTokens: 50,
                totalTokens: 75,
              },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Next I will continue with the remaining implementation work.",
              finishReason: "stop",
              usage: {
                promptTokens: 30,
                completionTokens: 100,
                totalTokens: 130,
              },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Bootstrap complete. Continuing with the remaining work.",
              finishReason: "stop",
              usage: {
                promptTokens: 30,
                completionTokens: 100,
                totalTokens: 130,
              },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Finished the remaining implementation details.",
              finishReason: "stop",
              usage: {
                promptTokens: 30,
                completionTokens: 1_900,
                totalTokens: 1_930,
              },
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(
        createParams({ turnOutputTokenBudget: 2_000 }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Finished the remaining implementation details.");
      expect(result.callUsage.map((entry) => entry.phase)).toEqual([
        "initial",
        "tool_followup",
        "tool_followup",
        "tool_followup",
      ]);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
      expect(
        (provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]?.toolChoice,
      ).toBeUndefined();
    });

    it("does not apply token-budget continuation to structured-output turns", async () => {
      const toolHandler = vi.fn().mockResolvedValue('{"ok":true}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"status":"done"}',
              finishReason: "stop",
              usage: {
                promptTokens: 20,
                completionTokens: 100,
                totalTokens: 120,
              },
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(
        createParams({
          turnOutputTokenBudget: 2_000,
          structuredOutput: {
            enabled: true,
            schema: {
              type: "json_schema",
              name: "structured_turn",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["status"],
                properties: {
                  status: { type: "string" },
                },
              },
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe('{"status":"done"}');
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("does not apply token-budget continuation when structured output is default-enabled", async () => {
      const toolHandler = vi.fn().mockResolvedValue('{"ok":true}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"status":"done"}',
              finishReason: "stop",
              usage: {
                promptTokens: 20,
                completionTokens: 100,
                totalTokens: 120,
              },
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(
        createParams({
          turnOutputTokenBudget: 2_000,
          structuredOutput: {
            schema: {
              type: "json_schema",
              name: "structured_turn",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["status"],
                properties: {
                  status: { type: "string" },
                },
              },
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe('{"status":"done"}');
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("surfaces timeout detail instead of summarizing tool output when tool follow-up never starts", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-08T00:00:00.000Z"));
      try {
        const toolHandler = vi.fn().mockImplementation(async () => {
          vi.setSystemTime(new Date(Date.now() + 250));
          return '{"entries":["src","package.json"]}';
        });
        const provider = createMockProvider("primary", {
          chat: vi
            .fn()
            .mockResolvedValueOnce(
              mockResponse({
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
                ],
              }),
            ),
        });

        const executor = new ChatExecutor({ providers: [provider], toolHandler });
        const result = await executor.execute(
          createParams({ requestTimeoutMs: 200 }),
        );

        expect(result.stopReason).toBe("timeout");
        expect(result.content).toContain(
          "Request exceeded end-to-end timeout (200ms) during tool follow-up",
        );
        expect(result.content).not.toContain("Completed system.listDir");
        expect(result.content).not.toContain("Operation completed. Result");
        expect(provider.chat).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails closed to the stop detail when max tool rounds end with another unresolved tool turn", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({
          path: "/tmp/project",
          entries: [
            { name: "runtime", type: "dir", size: 0 },
            { name: "package.json", type: "file", size: 128 },
          ],
        }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.listDir", arguments: '{"path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-2", name: "system.listDir", arguments: '{"path":"."}' },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 1,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("tool_calls");
      expect(result.content).toContain("Reached max tool rounds (1)");
      expect(result.content).not.toContain("Operation completed. Result");
      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.toolCalls.filter((call) => call.synthetic)).toHaveLength(1);
      expect(result.runtimeContractSnapshot?.toolProtocol.repairCount).toBe(1);
    });

    it("forces one no-tool recovery turn after three consecutive real tool failures", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({ error: "tool failed" }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.grep", arguments: '{"pattern":"one","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-2", name: "system.grep", arguments: '{"pattern":"two","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-3", name: "system.grep", arguments: '{"pattern":"three","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Recovered after reassessing the failures.",
              finishReason: "stop",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Recovered after reassessing the failures.");
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[3]?.[1]?.toolChoice).toBe("none");
    });

    it("fails closed when a forced no-tool recovery turn still emits tool calls", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({ error: "tool failed" }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "system.grep", arguments: '{"pattern":"one","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-2", name: "system.grep", arguments: '{"pattern":"two","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-3", name: "system.grep", arguments: '{"pattern":"three","path":"."}' },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-4", name: "system.grep", arguments: '{"pattern":"four","path":"."}' },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxFailureBudgetPerRequest: 4,
      });
      const result = await executor.execute(createParams());

      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain("no-tool recovery turn");
      expect(result.runtimeContractSnapshot?.toolProtocol.violationCount).toBeGreaterThan(0);
      expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[3]?.[1]?.toolChoice).toBe("none");
    });

    it("sanitizes screenshot tool payloads and keeps image artifacts out-of-band", async () => {
      const hugeBase64 = "A".repeat(90_000);
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({
          image: hugeBase64,
          dataUrl: `data:image/png;base64,${hugeBase64}`,
          width: 1024,
          height: 768,
        }),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "desktop.screenshot", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Updated c.ts with the requested implementation change.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const toolMessage = followupMessages.find(
        (m) => m.role === "tool" && m.toolCallId === "tc-1",
      );
      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content).toBe("string");
      const text = String(toolMessage?.content);
      expect(text).toContain("(base64 omitted)");
      expect(text).toContain("(see image)");
      expect(text).toContain("out-of-band");
      expect(text.length).toBeLessThan(13_000);
    });

    it("does not replay inline screenshot image parts into follow-up prompts", async () => {
      const hugeBase64 = "B".repeat(70_000);
      const screenshotResult = JSON.stringify({
        dataUrl: `data:image/png;base64,${hugeBase64}`,
        width: 1024,
        height: 768,
      });
      const toolHandler = vi.fn().mockResolvedValue(screenshotResult);
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "desktop.screenshot", arguments: "{}" },
                { id: "tc-2", name: "desktop.screenshot", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Updated a.ts and reran the build/runtime verification commands successfully.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const toolMessages = followupMessages.filter(
        (m) => m.role === "tool",
      );
      expect(toolMessages).toHaveLength(2);

      for (const message of toolMessages) {
        expect(typeof message.content).toBe("string");
        expect(String(message.content)).toContain("out-of-band");
      }
    });

    it("sanitizes mixed markdown + embedded JSON base64 screenshot blobs", async () => {
      const hugeBase64 = "C".repeat(95_000);
      const toolHandler = vi.fn().mockResolvedValue(
        [
          "### Result",
          '- [Screenshot of viewport](../../tmp/screenshot.png)',
          '{"type":"image","data":"' + hugeBase64 + '"}',
        ].join("\n"),
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "mcp.browser.browser_take_screenshot", arguments: "{}" },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Repaired src/core.test.ts and the repo-local test command passed after the fix.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(createParams());

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const toolMessage = followupMessages.find(
        (m) => m.role === "tool" && m.toolCallId === "tc-1",
      );
      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content).toBe("string");
      const text = String(toolMessage?.content);
      expect(text).toContain('"data":"(base64 omitted)"');
      expect(text).not.toContain(hugeBase64.slice(0, 256));
      expect(text.length).toBeLessThan(13_000);
    });

    it("multi-round tool calls chain with context", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce("result-1")
        .mockResolvedValueOnce("result-2");

      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "tool-a", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-2", name: "tool-b", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "done",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("done");
      expect(result.toolCalls).toHaveLength(2);
      expect(provider.chat).toHaveBeenCalledTimes(3);
    });






    // The "reports equivalent completion semantics for direct and
    // planner deterministic implementation" test was removed in Phase 2
    // of the planner rip-out. It compared the direct path against the
    // planner path; with the planner gone there is only one path.

    // The "preserves legacy completion compatibility for documentation-only
    // direct writes" test that lived here was removed on 2026-04-06 alongside
    // the regex-based plan-artifact intent classifier. It exercised the
    // pre-call direct-owner shortcut path: a documentation-only README
    // update used to be detected by the regex layer and routed through
    // the workflow-completion-truth gate without invoking the planner.
    // With the rip-out, intent is decided by the model and surfaced as
    // `plan_intent` on the parsed PlannerPlan, so the executor always
    // routes through the planner first; the legacy direct-owner shortcut
    // and the workflow-completion-truth gate path it triggered no longer
    // exist as standalone code paths. New end-to-end coverage for
    // documentation-only edit flows belongs in a planner-pipeline
    // integration test against a recorded model response that emits
    // `plan_intent: "edit_artifact"`.









    it("preserves provider-native server-side tool telemetry for delegated research", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: '{"selected":"pixi","why":["small","fast"]}',
            providerEvidence: {
              serverSideToolCalls: [
                {
                  type: "web_search_call",
                  toolType: "web_search",
                  id: "ws_123",
                  status: "completed",
                },
              ],
              serverSideToolUsage: [
                {
                  category: "SERVER_SIDE_TOOL_WEB_SEARCH",
                  toolType: "web_search",
                  count: 1,
                },
              ],
            },
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        allowedTools: ["web_search"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "tech_research",
              objective:
                "Compare Canvas API, Phaser, and PixiJS from official docs",
              inputContract:
                "Return JSON with selected framework and supporting evidence",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.providerEvidence?.serverSideToolCalls).toEqual([
        expect.objectContaining({
          type: "web_search_call",
          toolType: "web_search",
        }),
      ]);
      expect(result.providerEvidence?.serverSideToolUsage).toEqual([
        expect.objectContaining({
          category: "SERVER_SIDE_TOOL_WEB_SEARCH",
          count: 1,
        }),
      ]);
    });





    it("repairs collaboration tool args from explicit prompt fields and traces the repair", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "social.requestCollaboration") {
          return safeJson({ requestId: "req-1", args });
        }
        return safeJson({ name, args });
      });
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-collab",
                  name: "social.requestCollaboration",
                  arguments: safeJson({
                    requiredCapabilities: "3",
                    maxMembers: 3,
                    payoutMode: "fixed",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "Collaboration posted." }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["social.requestCollaboration"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators., requiredCapabilities 3, maxMembers 3, payoutMode fixed.",
          ),
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledWith("social.requestCollaboration", {
        title: "Launch Ritual Drill",
        description:
          "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
        requiredCapabilities: "3",
        maxMembers: 3,
        payoutMode: "fixed",
      });
      expect(result.toolCalls[0]?.args).toEqual({
        title: "Launch Ritual Drill",
        description:
          "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
        requiredCapabilities: "3",
        maxMembers: 3,
        payoutMode: "fixed",
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_dispatch_started",
            phase: "tool_followup",
            payload: expect.objectContaining({
              tool: "social.requestCollaboration",
              args: expect.objectContaining({
                title: "Launch Ritual Drill",
                description:
                  "Need 3 agents to simulate a privacy-safe localnet launch with one observer and two operators.",
              }),
              argumentDiagnostics: expect.objectContaining({
                repairSource: "message_text",
                repairedFields: ["title", "description"],
                rawArgs: {
                  requiredCapabilities: "3",
                  maxMembers: 3,
                  payoutMode: "fixed",
                },
              }),
            }),
          }),
        ]),
      );
    });






    it("invalid JSON args handled gracefully", async () => {
      const toolHandler = vi.fn();
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "tool", arguments: "not-json" }],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "handled" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(toolHandler).not.toHaveBeenCalled();
      expect(result.toolCalls[0].isError).toBe(true);
      expect(result.toolCalls[0].result).toContain("Invalid tool arguments");
    });

    it("ToolCallRecord includes name, args, result, isError, durationMs", async () => {
      const toolHandler = vi.fn().mockResolvedValue("result-data");
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
                  name: "fetch",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      const record = result.toolCalls[0];
      expect(record).toEqual(expect.objectContaining({
        name: "fetch",
        args: { url: "https://example.com" },
        result: "result-data",
        isError: false,
        durationMs: expect.any(Number),
      }));
    });

    it("suppresses narrative file-creation claims when tools never wrote files", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"exitCode":0,"stdout":"","stderr":""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "tc-1",
                name: "system.bash",
                arguments:
                  '{"command":"mkdir","args":["-p","/home/tetsuo/git/AgenC/neon-heist"]}',
              }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "I've created the folder `/home/tetsuo/git/AgenC/neon-heist`.\n\n" +
                "### Project Structure\n" +
                "- `/home/tetsuo/git/AgenC/neon-heist/index.html`\n" +
                "- `/home/tetsuo/git/AgenC/neon-heist/game.js`\n\n" +
                "Now creating the files...",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Set up the neon-heist workspace under /home/tetsuo/git/AgenC by creating the requested folder.",
          ),
          runtimeContext: {
            workspaceRoot: "/home/tetsuo/git/AgenC",
          },
        }),
      );

      // Narrative file-creation claim suppression no longer rewrites the response;
      // the executor preserves the model's original response.
      expect(result.content).toContain("I've created the folder");
    });

    it("preserves successful folder-creation replies when the only mutation is mkdir", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"exitCode":0,"stdout":"","stderr":""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "tc-1",
                name: "desktop.bash",
                arguments: '{"command":"mkdir -p /workspace/pong"}',
              }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Created the folder `/workspace/pong`.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      expect(result.content).toContain("Created the folder `/workspace/pong`.");
      expect(result.content).not.toContain(
        "tool evidence did not confirm any file writes",
      );
    });

  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty history works (first message in session)", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams({ history: [] }));

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // system prompt + user message only
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    });

    it("constructor throws if providers is empty", () => {
      expect(() => new ChatExecutor({ providers: [] })).toThrow(
        "ChatExecutor requires at least one provider",
      );
    });

    it("negative cooldown values are clamped to zero", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        providerCooldownMs: -1000,
        maxCooldownMs: -500,
      });

      // Should work without errors — negative values clamped to 0
      const result = await executor.execute(createParams());
      expect(result.content).toBe("mock response");
    });

  });
});
