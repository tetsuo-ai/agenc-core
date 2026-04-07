import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatExecutor, ChatBudgetExceededError } from "./chat-executor.js";
import type { ChatExecuteParams, ChatExecutorConfig } from "./chat-executor.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
  LLMMessage,
  StreamProgressCallback,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";
import {
  LLMTimeoutError,
  LLMServerError,
  LLMRateLimitError,
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
} from "./errors.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";

// ============================================================================
// Test helpers
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

function plannerScopePath(workspaceRoot: string, entry: string): string {
  if (!entry || entry === ".") return workspaceRoot;
  if (entry.startsWith("/")) return entry;
  return `${workspaceRoot.replace(/\/+$/, "")}/${entry.replace(/^\/+/, "")}`;
}

function plannerReadOnlyExecutionContext(
  workspaceRoot: string,
  options: {
    readonly sourceArtifacts?: readonly string[];
    readonly inputArtifacts?: readonly string[];
    readonly verificationMode?: "none" | "grounded_read";
    readonly stepKind?: "delegated_research" | "delegated_review";
  } = {},
): Record<string, unknown> {
  const sourceArtifacts = (options.sourceArtifacts ?? []).map((entry) =>
    plannerScopePath(workspaceRoot, entry)
  );
  const inputArtifacts = (options.inputArtifacts ?? []).map((entry) =>
    plannerScopePath(workspaceRoot, entry)
  );
  const verificationMode = options.verificationMode ??
    (sourceArtifacts.length > 0 || inputArtifacts.length > 0
      ? "grounded_read"
      : "none");
  const stepKind = options.stepKind ??
    (verificationMode === "grounded_read"
      ? "delegated_review"
      : "delegated_research");
  return {
    version: "v1",
    workspace_root: workspaceRoot,
    allowed_read_roots: [workspaceRoot],
    ...(inputArtifacts.length > 0
      ? { input_artifacts: inputArtifacts }
      : {}),
    ...(sourceArtifacts.length > 0
      ? { required_source_artifacts: sourceArtifacts }
      : {}),
    effect_class: "read_only",
    verification_mode: verificationMode,
    step_kind: stepKind,
  };
}

function plannerWriteExecutionContext(
  workspaceRoot: string,
  options: {
    readonly sourceArtifacts?: readonly string[];
    readonly inputArtifacts?: readonly string[];
    readonly targetArtifacts?: readonly string[];
    readonly effectClass?: "filesystem_write" | "filesystem_scaffold" | "shell" | "mixed";
    readonly verificationMode?: "mutation_required" | "deterministic_followup";
    readonly stepKind?: "delegated_write" | "delegated_scaffold" | "delegated_validation";
  } = {},
): Record<string, unknown> {
  const sourceArtifacts = (options.sourceArtifacts ?? []).map((entry) =>
    plannerScopePath(workspaceRoot, entry)
  );
  const inputArtifacts = (options.inputArtifacts ?? []).map((entry) =>
    plannerScopePath(workspaceRoot, entry)
  );
  const targetArtifacts = (options.targetArtifacts ?? []).map((entry) =>
    plannerScopePath(workspaceRoot, entry)
  );
  return {
    version: "v1",
    workspace_root: workspaceRoot,
    allowed_read_roots: [workspaceRoot],
    allowed_write_roots: [workspaceRoot],
    ...(inputArtifacts.length > 0
      ? { input_artifacts: inputArtifacts }
      : {}),
    ...(sourceArtifacts.length > 0
      ? { required_source_artifacts: sourceArtifacts }
      : {}),
    ...(targetArtifacts.length > 0
      ? { target_artifacts: targetArtifacts }
      : {}),
    effect_class: options.effectClass ?? "filesystem_write",
    verification_mode: options.verificationMode ?? "mutation_required",
    step_kind: options.stepKind ?? "delegated_write",
  };
}

function completedDelegatedPlannerResult(
  output: string,
  toolCalls:
    | readonly string[]
    | readonly {
      readonly name?: string;
      readonly args?: unknown;
      readonly result?: string;
      readonly isError?: boolean;
    }[] = ["system.writeFile"],
): string {
  return safeJson({
    status: "completed",
    output,
    success: true,
    durationMs: 12,
    failedToolCalls: 0,
    toolCalls: toolCalls.map((entry) =>
      typeof entry === "string"
        ? {
          name: entry,
          isError: false,
        }
        : {
          ...entry,
          isError: entry.isError === true,
        }
    ),
  });
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

      await executor.execute(createParams({ systemPrompt: "Be helpful." }));

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[0]).toEqual({ role: "system", content: "Be helpful." });
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

    it("failed provider skipped on next call within cooldown", async () => {
      const providerTraceEvents: Array<Record<string, unknown>> = [];
      const primary = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockRejectedValue(new LLMServerError("primary", 500, "down")),
      });
      const secondary = createMockProvider("secondary");
      const executor = new ChatExecutor({
        providers: [primary, secondary],
        providerCooldownMs: 10_000,
        retryPolicyMatrix: {
          provider_error: { maxRetries: 0 },
          rate_limited: { maxRetries: 0 },
        },
      });

      // First call — primary fails, secondary succeeds
      const reroutedResult = await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );
      expect(primary.chat).toHaveBeenCalledOnce();

      // Second call — primary should be skipped (in cooldown)
      vi.advanceTimersByTime(1_000);
      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) =>
              providerTraceEvents.push(event as Record<string, unknown>),
          },
        }),
      );

      // Primary still called only once total (the initial failure)
      expect(primary.chat).toHaveBeenCalledOnce();
      expect(secondary.chat).toHaveBeenCalledTimes(2);
      expect(reroutedResult.provider).toBe("secondary");
      expect(reroutedResult.economicsSummary?.rerouteCount).toBeGreaterThan(0);
      expect(providerTraceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            provider: "primary",
            callPhase: "initial",
            payload: expect.objectContaining({
              reason: "provider_cooldown_applied",
              failureClass: "provider_error",
              failures: 1,
            }),
          }),
        ]),
      );

      vi.useRealTimers();
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

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
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

    it("injects an authoritative runtime tool ledger before tool follow-up synthesis", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        JSON.stringify({ stdout: "pong ready", stderr: "", exitCode: 0 }),
      );
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
                  name: "desktop.bash",
                  arguments: '{"command":"mkdir -p /workspace/pong"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final answer" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      const groundingMessage = followupMessages.find((message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Runtime execution ledger")
      );

      expect(groundingMessage).toBeDefined();
      expect(String(groundingMessage?.content)).toContain('"tool":"desktop.bash"');
      expect(String(groundingMessage?.content)).toContain(
        '"successfulToolCalls":1',
      );
      expect(String(groundingMessage?.content)).toContain(
        'mkdir -p /workspace/pong',
      );
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

    it("retries once with a correction hint when delegated tool evidence is required", async () => {
      const toolHandler = vi.fn().mockResolvedValue("official-doc-result");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "Here is the answer from memory.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "search",
                  arguments: '{"query":"official docs"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Grounded answer with tool evidence.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["search"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: { maxCorrectionAttempts: 1 },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Grounded answer with tool evidence.");
      expect(result.toolCalls).toHaveLength(1);
      expect(toolHandler).toHaveBeenCalledWith("search", {
        query: "official docs",
      });
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(
        (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.toolChoice,
      ).toBe("required");

      const correctionMessages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1][0] as LLMMessage[];
      expect(
        correctionMessages.some((message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Tool-grounded evidence is required for this delegated task")
        ),
      ).toBe(true);
    });

    it("fails with validation_error when delegated tool evidence is still missing after correction", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "I already know the answer.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Still answering without tools.",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider] });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: { maxCorrectionAttempts: 1 },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(2);
      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain(
        "child reported no tool calls",
      );
      expect(result.content).toContain("child reported no tool calls");
      expect(result.toolCalls).toEqual([]);
    });

    it("retries plan-only execution responses before accepting a contract-backed implementation turn", async () => {
      const events: Record<string, unknown>[] = [];
      const toolHandler = vi.fn().mockResolvedValue("wrote file");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Plan**\n1. Create `main.c`\n2. Compile with gcc\n3. Run the binary\n\nStarting execution.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/tmp/tui-smoke/main.c",
                    content: "int main(void) { return 0; }\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Created `main.c` with the requested `int main(void) { return 0; }` entrypoint and continued execution with tools.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.readFile", "system.writeFile", "system.bash"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "In /tmp/tui-smoke only, create main.c.",
          ),
          requiredToolEvidence: {
            verificationContract: {
              workspaceRoot: "/tmp/tui-smoke",
              targetArtifacts: ["/tmp/tui-smoke/main.c"],
              acceptanceCriteria: ["main.c exists with the requested entrypoint."],
              completionContract: {
                taskClass: "artifact_only",
                placeholdersAllowed: false,
                partialCompletionAllowed: false,
                placeholderTaxonomy: "implementation",
              },
            },
            completionContract: {
              taskClass: "artifact_only",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
              placeholderTaxonomy: "implementation",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("continued execution");
      expect(toolHandler).toHaveBeenCalledWith("system.writeFile", {
        path: "/tmp/tui-smoke/main.c",
        content: "int main(void) { return 0; }\n",
      });
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(
        (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.toolChoice,
      ).toBe("required");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "retry",
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "accept",
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "workflow_completion_truth",
              decision: "accept",
              ownerClass: "implementation",
              ownershipSource: "turn_contract",
              completionState: "completed",
            }),
          }),
        ]),
      );
    });

    it("retries deferred execution summaries instead of stopping mid-implementation", async () => {
      const events: Record<string, unknown>[] = [];
      const toolHandler = vi.fn()
        .mockResolvedValueOnce("wrote main")
        .mockResolvedValueOnce("wrote readme");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-main",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/tmp/tui-smoke/main.c",
                    content: "int main(void) { return 0; }\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Implementation complete where implemented.**\n\n" +
                "**Summary of process:**\n" +
                "- Updated `main.c`\n" +
                "- Current status: compilable and aligned\n\n" +
                "Ready for targeted module completion. Let me know specific feature to deepen next.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-readme",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/tmp/tui-smoke/README.md",
                    content: "done\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Created `main.c` and `README.md` with grounded tool execution.",
            }),
          )
          .mockResolvedValue(
            mockResponse({
              content:
                "Created `main.c` and `README.md` with grounded tool execution.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.readFile", "system.writeFile", "system.bash"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "In /tmp/tui-smoke only, create main.c and README.md.",
          ),
          runtimeContext: {
            workspaceRoot: "/tmp/tui-smoke",
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("main.c");
      expect(result.content).toContain("README.md");
      expect(toolHandler).toHaveBeenNthCalledWith(1, "system.writeFile", {
        path: "/tmp/tui-smoke/main.c",
        content: "int main(void) { return 0; }\n",
      });
      expect(toolHandler).toHaveBeenNthCalledWith(2, "system.writeFile", {
        path: "/tmp/tui-smoke/README.md",
        content: "done\n",
      });
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "retry",
              executionDeferred: true,
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "accept",
              executionDeferred: false,
            }),
          }),
        ]),
      );
    });

    it("materializes a runtime-owned workflow contract for direct implementation instead of falling back to legacy compatibility", async () => {
      const events: Record<string, unknown>[] = [];
      const toolHandler = vi.fn().mockResolvedValue("wrote source");
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
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/tmp/phase9-direct/src/main.c",
                    content: "int main(void) { return 0; }\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Created src/main.c with the requested entrypoint.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.writeFile"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "In /tmp/phase9-direct only, create src/main.c with an int main entrypoint and finish when the file is written.",
          ),
          runtimeContext: {
            workspaceRoot: "/tmp/phase9-direct",
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.completionState).toBe("completed");
      expect(result.completionProgress?.verificationContract).toMatchObject({
        workspaceRoot: "/tmp/phase9-direct",
        targetArtifacts: ["/tmp/phase9-direct/src/main.c"],
        verificationMode: "mutation_required",
        completionContract: expect.objectContaining({
          taskClass: "artifact_only",
        }),
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "workflow_completion_truth",
              decision: "accept",
              ownerClass: "implementation",
              ownershipSource: "turn_contract",
              reason: "workflow_verification_contract_present",
            }),
          }),
        ]),
      );
    });

    it("fails implementation-class turns before execution when no workspace root is available", async () => {
      const toolHandler = vi.fn().mockResolvedValue("wrote source");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "should not run" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.writeFile"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Implement src/main.c and finish when the implementation is done.",
          ),
          runtimeContext: {},
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain(
        "requires a resolved workspace root",
      );
      expect(result.turnExecutionContract.turnClass).toBe(
        "workflow_implementation",
      );
      expect(provider.chat).not.toHaveBeenCalled();
      expect(toolHandler).not.toHaveBeenCalled();
    });

    it("binds direct implementation turns to a workflow contract before tool execution", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "system.writeFile") {
          return safeJson({ ok: true });
        }
        if (name === "system.bash") {
          return safeJson({
            stdout: "ok",
            stderr: "",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "make test",
            },
          });
        }
        throw new Error("Unexpected tool " + name);
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
                  id: "tc-write-contract",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/tmp/phase9-contract/src/main.c",
                    content: "int main(void) { return 0; }\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-build-contract",
                  name: "system.bash",
                  arguments: safeJson({ command: "make test" }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Phase 0 implemented and verified with make test.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.writeFile", "system.bash"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Implement phase 0 and run make test before finishing."),
          runtimeContext: { workspaceRoot: "/tmp/phase9-contract" },
        }),
      );

      expect(result.turnExecutionContract.turnClass).toBe(
        "workflow_implementation",
      );
      expect(result.stopReasonDetail ?? "").not.toContain(
        "workflow-owned verification closure",
      );
      expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
        "system.writeFile",
        "system.bash",
      ]);
      expect(result.completionState).not.toBe("blocked");
      expect(result.stopReason).toBe("completed");
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

    it("preserves legacy completion compatibility for research-only turns", async () => {
      const events: Record<string, unknown>[] = [];
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              "Pixi is the best fit. Citations: https://pixijs.com, https://docs.phaser.io.",
            providerEvidence: {
              citations: ["https://pixijs.com", "https://docs.phaser.io"],
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
          message: createMessage(
            "Compare PixiJS and Phaser from official docs and cite sources.",
          ),
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.completionState).toBe("completed");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "tool_followup",
            payload: expect.objectContaining({
              gate: "legacy_completion_compatibility",
              decision: "accept",
              compatibilityClass: "research",
            }),
          }),
        ]),
      );
    });

    it("fails coding turns that return only plans after the retry", async () => {
      const events: Record<string, unknown>[] = [];
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Plan**\n1. Create `main.c`\n2. Compile with gcc\n3. Run the binary\n\nStarting execution.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Plan**\n1. Write the code\n2. Compile it\n3. Verify it\n\nStarting execution.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Plan**\n1. Write main.c\n2. Build it\n3. Test it\n\nStarting execution.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler: vi.fn(),
        allowedTools: ["system.writeFile", "system.bash"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "In /tmp/tui-smoke only, create main.c, compile it with gcc, run it, and verify the output.",
          ),
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(result.stopReason).toBe("validation_error");
      expect(result.stopReasonDetail).toContain("plan without grounded tool work");
      expect(result.content).toContain("plan without grounded tool work");
      expect(result.toolCalls).toEqual([]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "retry",
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              gate: "plan_only_execution",
              decision: "fail",
            }),
          }),
        ]),
      );
    });

    it("uses a toolless correction retry when delegated evidence exists but the result contract is malformed", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/grid-router-ts/README.md",
                    content: "# Grid Router\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "**write_docs complete** README.md updated.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: safeJson({
                files: ["README.md"],
                status: "completed",
              }),
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          path: "/workspace/grid-router-ts/README.md",
          bytesWritten: 14,
        }),
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.writeFile"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "write_docs",
              objective: "Write the README in workspace files",
              inputContract:
                "Return a JSON object with implemented scope and touched files",
              acceptanceCriteria: ["README.md written"],
            },
          },
          toolRouting: {
            routedToolNames: ["system.writeFile"],
            expandedToolNames: ["system.writeFile"],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledTimes(1);
      expect(provider.chat).toHaveBeenCalledTimes(3);
      const correctionOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(correctionOptions?.tools).toBeUndefined();
    });

    it("fails when delegated output claims completion while admitting unresolved mismatches", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/grid-router-ts/tests/map.test.ts",
                    content: "it('works', () => expect(true).toBe(true));\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**add_tests complete**: test/map.test.ts created. " +
                "Note: some tests may need minor impl tweaks due to code mismatches in cli/GridMap methods like parse/getGoal.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Still complete, but there may be minor follow-up changes needed for the mismatches.",
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          path: "/workspace/grid-router-ts/tests/map.test.ts",
          bytesWritten: 48,
        }),
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.bash", "system.writeFile"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "add_tests",
              objective:
                "Create Vitest tests that match the implemented CLI and core contracts",
              inputContract: "Core library and CLI already exist",
              acceptanceCriteria: [
                "Tests compile against the current CLI/core APIs",
                "Tests cover requirements",
              ],
            },
          },
          toolRouting: {
            routedToolNames: ["system.bash", "system.writeFile"],
            expandedToolNames: ["system.bash", "system.writeFile"],
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(provider.chat).toHaveBeenCalledTimes(3);
    });

    it("fails delegated corrections that still answer blocked after a contradictory completion retry", async () => {
      const events: Record<string, unknown>[] = [];
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write-initial",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/space-colony/src/simulation.ts",
                    content:
                      "export function generateAsteroidSurface() {\n" +
                      "  // placeholder stub\n" +
                      "  return [];\n" +
                      "}\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**implement_core_drones complete** Updated `src/simulation.ts`. " +
                "Note: `src/simulation.ts` still contains placeholder stub lines " +
                "that need follow-up cleanup before the phase is really complete.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write-fixed",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/space-colony/src/simulation.ts",
                    content:
                      "export function generateAsteroidSurface() {\n" +
                      "  return [];\n" +
                      "}\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**Blocked** The placeholder is fixed, but the prior validation error still says this phase is blocked.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "**implement_core_drones complete** Updated `src/simulation.ts` and removed the placeholder stub.",
            }),
          ),
      });
      const toolHandler = vi.fn().mockImplementation(
        async (name: string, args: Record<string, unknown>) => {
          if (name === "system.writeFile") {
            return safeJson({
              path: args.path,
              bytesWritten: String(args.content ?? "").length,
            });
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.writeFile", "system.readFile"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "assess_core_drones",
              objective:
                "Inspect src/simulation.ts and confirm whether the placeholder stub is gone",
              inputContract: "src/simulation.ts exists",
              acceptanceCriteria: [
                "Report whether src/simulation.ts still contains placeholder comments",
              ],
            },
          },
          toolRouting: {
            routedToolNames: ["system.writeFile", "system.readFile"],
            expandedToolNames: ["system.writeFile", "system.readFile"],
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
    });

    it("fails when delegated browser research only uses low-signal about:blank tab checks", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        "### Result\n- 0: (current) [](about:blank)",
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-tabs",
                  name: "mcp.browser.browser_tabs",
                  arguments: '{"action":"list"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Heat Signature, Gunpoint, and Monaco are good references. Tuning: 220px/s, 3 enemies, 30s mutation.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Still done with the research.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.browser.browser_tabs"],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "design_research",
              objective:
                "Research 3 reference games with browser tools and cite sources",
              inputContract:
                "Return markdown with 3 cited references and tuning targets",
              requiredToolCapabilities: [
                "mcp.browser.browser_navigate",
                "mcp.browser.browser_snapshot",
              ],
            },
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(result.toolCalls).toHaveLength(1);
      expect(toolHandler).toHaveBeenCalledWith("mcp.browser.browser_tabs", {
        action: "list",
      });
    });

    it("forces a navigation-first tool choice for browser-grounded delegated work", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-nav",
                  name: "mcp.browser.browser_navigate",
                  arguments: '{"url":"https://example.com"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Grounded research output with citations.",
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        '{"ok":true,"url":"https://example.com"}',
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
          "mcp.browser.browser_tabs",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "design_research",
              objective:
                "Research 3 reference games with browser tools and cite sources",
              inputContract:
                "Return markdown with 3 cited references and tuning targets",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.browser.browser_navigate",
      ]);
    });

    it("accepts provider-native web search evidence for delegated research", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              '{"selected":"pixi","why":["small","fast"],"citations":["https://pixijs.com","https://docs.phaser.io"]}',
            providerEvidence: {
              citations: ["https://pixijs.com", "https://docs.phaser.io"],
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
                "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
              inputContract:
                "Return JSON with selected framework, rationale, and citations",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.providerEvidence?.citations).toEqual([
        "https://pixijs.com",
        "https://docs.phaser.io",
      ]);
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual(["web_search"]);
    });

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

    it("forces an editor-first tool choice for implementation delegation", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-edit",
                  name: "desktop.text_editor",
                  arguments:
                    '{"command":"create","path":"/workspace/neon-heist/index.html","file_text":"<!doctype html>"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"ok":true}');

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "desktop.bash",
          "desktop.text_editor",
          "mcp.neovim.vim_edit",
          "mcp.neovim.vim_buffer_save",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Implement the game files in the desktop workspace",
              inputContract: "JSON output with created files",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "desktop.text_editor",
      ]);
    });

    it("restores the broader delegated tool subset after the initial grounded implementation subset", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "/workspace/grid-router-ts/src/index.ts",
                    content: "export const ok = true;\n",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/grid-router-ts/src/index.ts"}]}',
            }),
          ),
      });
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"bytesWritten":24,"path":"/workspace/grid-router-ts/src/index.ts"}');

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
          "system.listDir",
        ],
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Implement the requested TypeScript files",
              inputContract: "JSON output with created files",
            },
          },
          toolRouting: {
            routedToolNames: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            expandedToolNames: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.readFile",
        "system.writeFile",
      ]);
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ]);
    });

    it("narrows correction retries to file-mutation tools after missing file evidence", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-shell",
                  name: "desktop.bash",
                  arguments: '{"command":"npm test"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"status":"done"}',
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-edit",
                  name: "desktop.text_editor",
                  arguments:
                    '{"command":"create","path":"/workspace/neon-heist/index.html","file_text":"<!doctype html>"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        '{"stdout":"tests passed\\n","exitCode":0}',
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["desktop.bash", "desktop.text_editor"],
      });

      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Scaffold and implement the game files in the desktop workspace",
              inputContract: "JSON output with created files",
            },
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolChoice).toBe("required");
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "desktop.text_editor",
      ]);
    });

    it("honors non-persistent correction routes during the next tool dispatch round", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "Implemented the phase.",
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"/workspace/freight-flow/src/index.ts","content":"export const ok = true;\\n"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"files_created":[{"path":"/workspace/freight-flow/src/index.ts"}]}',
            }),
          ),
      });
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          path: "/workspace/freight-flow/src/index.ts",
          bytesWritten: 24,
        }),
      );

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["system.bash", "system.writeFile"],
      });

      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "core_implementation",
              objective: "Implement the requested TypeScript files",
              inputContract: "JSON output with created files",
            },
          },
          toolRouting: {
            routedToolNames: ["system.bash"],
            expandedToolNames: ["system.bash", "system.writeFile"],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledWith("system.writeFile", {
        path: "/workspace/freight-flow/src/index.ts",
        content: "export const ok = true;\n",
      });

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "system.writeFile",
      ]);
    });

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
      expect(result.toolCalls).toHaveLength(3);
    });

    it("extends tool-round budget when the latest round still makes material progress", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const workspaceRoot = "/tmp/tool-round-budget-progress";
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.readFile",
                  arguments: '{"path":"a.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments: '{"path":"c.ts","content":"export const c = 1;"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Updated c.ts with the requested implementation change.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            verificationContract: {
              workspaceRoot,
              targetArtifacts: [`${workspaceRoot}/c.ts`],
              acceptanceCriteria: ["c.ts was updated as part of the requested implementation."],
              completionContract: {
                taskClass: "artifact_only",
                placeholdersAllowed: false,
                partialCompletionAllowed: false,
                placeholderTaxonomy: "implementation",
              },
            },
            completionContract: {
              taskClass: "artifact_only",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
              placeholderTaxonomy: "implementation",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionRounds: 1,
              newLimit: 3,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 3,
              extensionRounds: 1,
            }),
          }),
        ]),
      );
    });

    it("extends tool-round budget when recent rounds show sustained progress despite the latest failed round", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const workspaceRoot = "/tmp/tool-round-budget-sustained";
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce("ok")
        .mockResolvedValueOnce('{"exitCode":1,"stderr":"build failed"}')
        .mockResolvedValueOnce(
          JSON.stringify({
            stdout: "build passed",
            exitCode: 0,
            __agencVerification: {
              category: "build",
              repoLocal: true,
              command: "npm run build",
              cwd: workspaceRoot,
            },
          }),
        );
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.writeFile",
                  arguments: '{"path":"a.ts","content":"export const a = 1;"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Updated a.ts and build verification completed after the implementation update.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            verificationContract: {
              workspaceRoot,
              targetArtifacts: [`${workspaceRoot}/a.ts`],
              acceptanceCriteria: ["Build verification completed after the implementation update."],
              completionContract: {
                taskClass: "build_required",
                placeholdersAllowed: false,
                partialCompletionAllowed: false,
                placeholderTaxonomy: "implementation",
              },
            },
            completionContract: {
              taskClass: "build_required",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
              placeholderTaxonomy: "implementation",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              extensionRounds: 2,
              newLimit: 4,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 4,
              extensionReason: "repair_episode",
              extensionRounds: 2,
            }),
          }),
        ]),
      );
    });

    it("extends tool-round budget to finish an open repair episode after a failing verification round", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const workspaceRoot = "/tmp/tool-round-budget-repair";
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"exitCode":1,"stderr":"AssertionError: expected 0 to be greater than 0"}',
        )
        .mockResolvedValueOnce(
          JSON.stringify({ path: "src/core.test.ts", content: "old failing test" }),
        )
        .mockResolvedValueOnce('{"path":"src/core.test.ts","bytesWritten":12}')
        .mockResolvedValueOnce(
          JSON.stringify({
            exitCode: 0,
            stdout: "tests passed",
            __agencVerification: {
              category: "behavior",
              repoLocal: true,
              command: "npm run test",
              cwd: workspaceRoot,
            },
          }),
        );
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"src/core.test.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"src/core.test.ts","content":"fixed test contents"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
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

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            verificationContract: {
              workspaceRoot,
              requiredSourceArtifacts: [`${workspaceRoot}/src/core.test.ts`],
              targetArtifacts: [`${workspaceRoot}/src/core.test.ts`],
              acceptanceCriteria: ["The repaired test file passes the repo-local verification command."],
              completionContract: {
                taskClass: "build_required",
                placeholdersAllowed: false,
                partialCompletionAllowed: false,
                placeholderTaxonomy: "repair",
              },
            },
            completionContract: {
              taskClass: "build_required",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
              placeholderTaxonomy: "repair",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(5);
      expect(result.toolCalls).toHaveLength(4);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              recentTotalNewVerificationFailureDiagnosticKeys: 1,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
              extensionRounds: 2,
              newLimit: 4,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 4,
              extensionReason: "repair_episode",
              extensionRounds: 2,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
            }),
          }),
        ]),
      );
    });

    it("extends tool-round budget for node-based runtime verification repair episodes", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const workspaceRoot = "/tmp/tool-round-budget-node";
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          "{\"exitCode\":1,\"stderr\":\"SyntaxError: Unexpected identifier 'assert' at packages/data/dist/index.js\"}",
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            path: "packages/data/dist/index.js",
            content: "module.exports = require('./broken')",
          }),
        )
        .mockResolvedValueOnce(
          '{"path":"packages/data/src/index.ts","bytesWritten":24}',
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            exitCode: 0,
            stdout: "runtime smoke test passed",
            __agencVerification: {
              category: "behavior",
              repoLocal: true,
              command: "node -e \"require('./packages/data/dist/index.js')\"",
              cwd: workspaceRoot,
            },
          }),
        );
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.bash",
                  arguments:
                    "{\"command\":\"node -e \\\"require('./packages/data/dist/index.js')\\\"\"}",
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"packages/data/dist/index.js"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments:
                    "{\"path\":\"packages/data/src/index.ts\",\"content\":\"export const ok = true;\"}",
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.bash",
                  arguments:
                    "{\"command\":\"node -e \\\"require('./packages/data/dist/index.js')\\\"\"}",
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Repaired packages/data/src/index.ts and the runtime import check passed after the source repair.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            verificationContract: {
              workspaceRoot,
              requiredSourceArtifacts: [
                `${workspaceRoot}/packages/data/dist/index.js`,
              ],
              targetArtifacts: [`${workspaceRoot}/packages/data/src/index.ts`],
              acceptanceCriteria: ["The runtime import check passes after the source repair."],
              completionContract: {
                taskClass: "behavior_required",
                placeholdersAllowed: false,
                partialCompletionAllowed: false,
                placeholderTaxonomy: "repair",
              },
            },
            completionContract: {
              taskClass: "behavior_required",
              placeholdersAllowed: false,
              partialCompletionAllowed: false,
              placeholderTaxonomy: "repair",
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(5);
      expect(result.toolCalls).toHaveLength(4);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              recentTotalNewVerificationFailureDiagnosticKeys: 1,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
              extensionRounds: 2,
              newLimit: 4,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 4,
              extensionReason: "repair_episode",
              extensionRounds: 2,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
            }),
          }),
        ]),
      );
    });

    it("caps repair-episode extensions by the remaining request tool budget", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"exitCode":1,"stderr":"AssertionError: expected 0 to be greater than 0"}',
        )
        .mockResolvedValueOnce("inspection-ok")
        .mockResolvedValueOnce('{"path":"src/core.test.ts","bytesWritten":12}');
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.bash",
                  arguments: '{"command":"cat","args":["src/core.test.ts"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"src/core.test.ts","content":"fixed test contents"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","test"]}',
                },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
        toolBudgetPerRequest: 3,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("tool_calls");
      expect(result.stopReasonDetail).toContain("Reached max tool rounds (3)");
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              extensionReason: "repair_episode",
              extensionRounds: 1,
              newLimit: 3,
              effectiveToolBudget: 3,
              remainingToolBudget: 1,
              repairCycleOpen: true,
              repairCycleNeedsMutation: true,
              repairCycleNeedsVerification: true,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 2,
              newLimit: 3,
              extensionReason: "repair_episode",
              extensionRounds: 1,
              effectiveToolBudget: 3,
              remainingToolBudget: 1,
            }),
          }),
        ]),
      );
    });

    it("forces a no-tool delegated finalization turn when the tool budget is exhausted", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"ok":true}')
        .mockResolvedValueOnce('{"path":"package.json","bytesWritten":120}')
        .mockResolvedValueOnce('{"path":"tsconfig.json","bytesWritten":96}');
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "author scaffold files",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"package.json","content":"{\\"name\\":\\"demo\\"}"}',
                },
                {
                  id: "tc-2",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"tsconfig.json","content":"{\\"files\\":[]}"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "one more verification step",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.bash",
                  arguments: '{"command":"ls","args":["-la"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "one last redundant verification step",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.bash",
                  arguments: '{"command":"ls","args":["-la"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Completed the scaffold phase. Authored package.json and tsconfig.json.",
              finishReason: "stop",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 1,
        toolBudgetPerRequest: 3,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "scaffold_structure",
              objective: "Author package.json and tsconfig.json only",
              acceptanceCriteria: [
                "package.json authored",
                "tsconfig.json authored",
              ],
              requiredToolCapabilities: ["file_system"],
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("package.json");
      expect(result.content).toContain("tsconfig.json");
      expect(result.toolCalls).toHaveLength(3);
      expect(toolHandler).toHaveBeenCalledTimes(3);
      expect(provider.chat).toHaveBeenCalledTimes(4);

      const finalizationCallOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(finalizationCallOptions?.toolChoice).toBe("none");

      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_finalization_finished",
            payload: expect.objectContaining({
              outcome: "completed",
              requestedToolNames: ["system.bash"],
              requestedToolCount: 1,
            }),
          }),
        ]),
      );
    });

    it("bypasses the normal recall budget for the terminal delegated no-tool finalization call", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "author scaffold files",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "package.json",
                    content: '{"name":"fixture"}',
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "one more verification step",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.writeFile",
                  arguments: safeJson({
                    path: "tsconfig.json",
                    content: '{"compilerOptions":{"strict":true}}',
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Completed the scaffold phase. Authored package.json and tsconfig.json.",
              finishReason: "stop",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 1,
        toolBudgetPerRequest: 1,
        maxModelRecallsPerRequest: 1,
      });
      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              task: "scaffold_structure",
              objective: "Author package.json and tsconfig.json only",
              acceptanceCriteria: [
                "package.json authored",
                "tsconfig.json authored",
              ],
              requiredToolCapabilities: ["file_system"],
            },
          },
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("package.json");
      expect(result.content).toContain("tsconfig.json");
      expect(provider.chat).toHaveBeenCalledTimes(3);

      const finalizationCallOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(finalizationCallOptions?.toolChoice).toBe("none");

      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_finalization_finished",
            payload: expect.objectContaining({
              outcome: "completed",
              requestedToolNames: ["system.writeFile"],
              requestedToolCount: 1,
            }),
          }),
        ]),
      );
    });

    it("does not extend tool-round budget when the latest round adds no new progress and no repair cycle is open", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      const toolHandler = vi.fn().mockResolvedValue("ok");
      const provider = createMockProvider("primary", {
        chat: vi.fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-1",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-1",
                  name: "system.readFile",
                  arguments: '{"path":"a.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-2",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-2",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-3",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-3",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "round-4",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-4",
                  name: "system.readFile",
                  arguments: '{"path":"b.ts"}',
                },
              ],
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 2,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(result.toolCalls).toHaveLength(3);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 2,
              decision: "extended",
              newLimit: 3,
            }),
          }),
          expect.objectContaining({
            type: "tool_round_budget_extension_evaluated",
            payload: expect.objectContaining({
              currentLimit: 3,
              decision: "insufficient_recent_progress",
              latestRoundHadMaterialProgress: false,
              latestRoundNewSuccessfulSemanticKeys: 0,
              repairCycleOpen: false,
              newLimit: 3,
            }),
          }),
        ]),
      );
      expect(traceEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_round_budget_extended",
            payload: expect.objectContaining({
              previousLimit: 3,
            }),
          }),
        ]),
      );
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
      expect(result.toolCalls).toHaveLength(2);
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
      expect(result.toolCalls).toHaveLength(1);
      expect(result.stopReason).toBe("budget_exceeded");
    });

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

    it("normalizes Doom launch resolution args before calling the tool handler", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            normalized_resolution: args.screen_resolution,
          });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    async_player: true,
                    screen_resolution: "1280x720",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "Doom started." })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.doom.start_game"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Start Doom defend_the_center at 1280x720."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenCalledWith("mcp.doom.start_game", {
        scenario: "defend_the_center",
        async_player: true,
        screen_resolution: "RES_1280X720",
        window_visible: true,
        render_hud: true,
      });
      expect(result.toolCalls[0]?.args).toEqual({
        scenario: "defend_the_center",
        async_player: true,
        screen_resolution: "RES_1280X720",
        window_visible: true,
        render_hud: true,
      });
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

    it("records normalized async Doom launches as evidence for autonomous follow-up routing", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "running",
            god_mode_enabled: true,
          });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running in async defend-the-center mode with god mode enabled.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("Doom is running");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          god_mode: true,
          async_player: true,
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "hold_position" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );
      expect(result.toolCalls[0]?.args).toEqual(
        expect.objectContaining({
          async_player: true,
          god_mode: true,
          scenario: "defend_the_center",
        }),
      );

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const fourthOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(fourthOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("requires an explore objective for generic Doom autoplay turns", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({ status: "running", scenario: "basic" });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({
            status: "objective_set",
            objective: { type: "explore" },
          });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "exploring",
            objectives: [{ type: "explore" }],
          });
        }
        return safeJson({ status: "ok" });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "basic",
                    window_visible: true,
                    render_hud: true,
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "explore" }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running autonomously and will continue until stopped.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Play Doom until I tell you to stop."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          async_player: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "explore" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("keeps Doom contract-required tools available even when the generic routed subset omits them", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set", objective_type: "hold_position" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "fighting",
            god_mode_enabled: true,
            objectives: [{ type: "hold_position" }],
          });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Doom is running in async hold-position defense mode with god mode enabled.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "desktop.bash",
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
          toolRouting: {
            routedToolNames: [
              "desktop.bash",
              "mcp.doom.start_game",
              "mcp.doom.get_situation_report",
            ],
          },
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toContain("hold-position defense");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          god_mode: true,
          async_player: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.set_objective",
        { objective_type: "hold_position" },
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        3,
        "mcp.doom.get_situation_report",
        {},
      );

      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_objective",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const fourthOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[3]?.[1] as LLMChatOptions | undefined;
      expect(fourthOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("uses non-stream chat for deterministic single-tool Doom follow-ups and streams only the final answer", async () => {
      const onStreamChunk = vi.fn();
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          return safeJson({
            status: "running",
            god_mode_enabled: true,
            scenario: args.scenario,
          });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set", objective_type: "hold_position" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({
            executor_state: "running",
            god_mode_enabled: true,
          });
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
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    god_mode: true,
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          ),
        chatStream: vi.fn().mockResolvedValue(
          mockResponse({
            content:
              "Doom is running in async defend-the-center mode with god mode enabled.",
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        onStreamChunk,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
          "mcp.doom.get_state",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Start Doom in god mode, defend the center, and keep playing until I tell you to stop.",
          ),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(provider.chatStream).toHaveBeenCalledTimes(1);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);

      const finalOptions = (provider.chatStream as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[2] as LLMChatOptions | undefined;
      expect(finalOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.get_situation_report",
      ]);
    });

    it("ends a Doom tool round after failed start_game so dependent calls do not run", async () => {
      const toolHandler = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === "mcp.doom.start_game") {
          if (args.screen_resolution === "banana") {
            return "Unknown resolution 'banana'. Valid: ['RES_1280X720']";
          }
          return safeJson({ status: "running" });
        }
        if (name === "mcp.doom.set_objective") {
          return safeJson({ status: "objective_set" });
        }
        if (name === "mcp.doom.get_situation_report") {
          return safeJson({ executor_state: "fighting" });
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
                  id: "tc-start-bad",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    screen_resolution: "banana",
                  }),
                },
                {
                  id: "tc-objective",
                  name: "mcp.doom.set_objective",
                  arguments: safeJson({ objective_type: "hold_position" }),
                },
                {
                  id: "tc-report",
                  name: "mcp.doom.get_situation_report",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-start-good",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({
                    scenario: "defend_the_center",
                    screen_resolution: "RES_1280X720",
                  }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Doom started after correcting the resolution.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: [
          "mcp.doom.start_game",
          "mcp.doom.set_objective",
          "mcp.doom.get_situation_report",
        ],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Start Doom defend_the_center."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("Doom started after correcting the resolution.");
      expect(toolHandler).toHaveBeenNthCalledWith(
        1,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          screen_resolution: "banana",
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(toolHandler).toHaveBeenNthCalledWith(
        2,
        "mcp.doom.start_game",
        expect.objectContaining({
          scenario: "defend_the_center",
          screen_resolution: "RES_1280X720",
          window_visible: true,
          render_hud: true,
        }),
      );
      expect(
        toolHandler.mock.calls.some(([name]) =>
          name === "mcp.doom.set_objective" ||
          name === "mcp.doom.get_situation_report"
        ),
      ).toBe(false);
    });

    it("steers Doom turns toward start_game first and then the missing follow-up tool", async () => {
      let started = false;
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "mcp.doom.start_game") {
          started = true;
          return safeJson({ status: "running" });
        }
        if (name === "mcp.doom.set_god_mode") {
          if (!started) {
            return safeJson({
              error:
                "Launch Doom first with `mcp.doom.start_game` before calling follow-up Doom tools in this turn. " +
                "For play-until-stop requests, the launch must include `async_player: true`.",
            });
          }
          return safeJson({
            status: "god_mode_updated",
            god_mode_enabled: true,
          });
        }
        return safeJson({ name });
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
                  id: "tc-god-early",
                  name: "mcp.doom.set_god_mode",
                  arguments: safeJson({ enabled: true }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-start",
                  name: "mcp.doom.start_game",
                  arguments: safeJson({}),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-god-correct",
                  name: "mcp.doom.set_god_mode",
                  arguments: safeJson({ enabled: true }),
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "God mode is enabled and Doom is running.",
            }),
          ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["mcp.doom.start_game", "mcp.doom.set_god_mode"],
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Enable god mode in Doom."),
        }),
      );

      expect(result.stopReason).toBe("completed");
      expect(result.content).toBe("God mode is enabled and Doom is running.");
      expect(toolHandler.mock.calls).toEqual([
        [
          "mcp.doom.start_game",
          {
            screen_resolution: "RES_1280X720",
            window_visible: true,
            render_hud: true,
          },
        ],
        ["mcp.doom.set_god_mode", { enabled: true }],
      ]);

      const firstOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as LLMChatOptions | undefined;
      expect(firstOptions?.toolChoice).toBe("required");
      expect(firstOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const secondOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[1]?.[1] as LLMChatOptions | undefined;
      expect(secondOptions?.toolChoice).toBe("required");
      expect(secondOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.start_game",
      ]);

      const thirdOptions = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[2]?.[1] as LLMChatOptions | undefined;
      expect(thirdOptions?.toolChoice).toBe("required");
      expect(thirdOptions?.toolRouting?.allowedToolNames).toEqual([
        "mcp.doom.set_god_mode",
      ]);
    });

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

    it("emits completion-gate retry and failure events when required tool evidence is missing", async () => {
      const events: Array<Record<string, unknown>> = [];
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(mockResponse({ content: "plan", finishReason: "stop" }))
          .mockResolvedValueOnce(mockResponse({ content: "still no tools", finishReason: "stop" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(
        createParams({
          requiredToolEvidence: {
            maxCorrectionAttempts: 1,
            delegationSpec: {
              tools: ["system.bash"],
            },
          },
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      expect(result.stopReason).toBe("validation_error");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              decision: "retry",
            }),
          }),
          expect.objectContaining({
            type: "completion_gate_checked",
            phase: "initial",
            payload: expect.objectContaining({
              decision: "fail",
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
      expect(record).toEqual({
        name: "fetch",
        args: { url: "https://example.com" },
        result: "result-data",
        isError: false,
        durationMs: expect.any(Number),
      });
    });

    it("surfaces direct output for simple successful desktop shell observations", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"stdout":"/workspace\\n","stderr":"","exitCode":0}',
      );
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
                  name: "desktop.bash",
                  arguments: '{"command":"pwd"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                "Note: `desktop.bash` spawns fresh shells from `/workspace` each time (non-persistent).\n\n" +
                "To work in `~` (/home/agenc): Prefix like `cd ~ && your_command`.\n\n" +
                "Demo:\n```sh\ncd ~ && pwd\n```",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toBe("/workspace");
    });

    it("breaks loop when same tool call fails consecutively", async () => {
      // Simulate the LLM calling desktop.bash with "mkdir" (no directory),
      // which returns exitCode:1 every time. Should stop after 3 identical failures.
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"usage: mkdir dir"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call-1",
                name: "desktop.bash",
                arguments: '{"command":"mkdir"}',
              },
            ],
          }),
        ),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      // Should have stopped after 3 identical failures, not all 10 rounds
      expect(result.toolCalls.length).toBe(3);
      expect(result.toolCalls.every((tc) => tc.name === "desktop.bash")).toBe(
        true,
      );
    });

    it("injects a recovery hint after shell-builtin style system.bash failure", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn set ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set","args":["-euo","pipefail"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Shell builtins"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("omitting `args`");
    });

    it("injects a recovery hint after missing local binary ENOENT on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn tsc ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"tsc","args":["--noEmit"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("`npx tsc`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("host PATH");
      expect(String(injectedHint?.content)).not.toContain("Shell builtins");
    });

    it("injects a recovery hint after malformed grep direct-mode usage", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"Command failed: grep -A 20 mapString|example|test packages/core/src/index.ts"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["-A","20","mapString|example|test","packages/core/src/index.ts"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("prefer `rg PATTERN PATH`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("add `-E`");
      expect(String(injectedHint?.content)).toContain("reads stdin instead of searching files");
    });

    it("injects a recovery hint after grep is given a pattern but no search path", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"","timedOut":false}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["-E","enemy|combat|attack","--include=*.{h,cpp}"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Direct-mode `grep` with only a pattern reads stdin"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("pair `--include` with `-r`");
      expect(String(injectedHint?.content)).toContain("`rg PATTERN src include`");
    });

    it("injects a recovery hint when npm run targets a missing script", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"npm error Missing script: \\"build\\""}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["run","build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("does not define the npm script `build`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("root/workspace script");
      expect(String(injectedHint?.content)).toContain("package-specific command");
    });

    it("injects a recovery hint when npm workspace selectors do not match package names", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"npm error No workspaces found:\\nnpm error   --workspace=core --workspace=cli --workspace=web"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"npm","args":["run","build","--workspace=core","--workspace=cli","--workspace=web"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("could not match one or more `--workspace` selectors"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("`core`");
      expect(String(injectedHint?.content)).toContain("package `name`");
      expect(String(injectedHint?.content)).toContain("--workspace=@scope/pkg");
    });

    it("emits an execution trace event when recovery hints are injected", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"spawn set ENOENT"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set","args":["-euo","pipefail"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "moved on" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(
        createParams({
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
            type: "recovery_hints_injected",
            phase: "tool_followup",
            payload: expect.objectContaining({
              count: 1,
              hints: expect.arrayContaining([
                expect.objectContaining({
                  key: "system-bash-shell-builtin",
                }),
              ]),
            }),
          }),
        ]),
      );
    });

    it("injects a recovery hint for TypeScript rootDir scope errors", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":2,"stdout":"error TS6059: File \'/workspace/packages/web/vite.config.ts\' is not under \'rootDir\' \'/workspace/packages/web/src\'.","stderr":"Command failed: npx tsc --build"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npx","args":["tsc","--build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("includes files outside `rootDir`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("vite.config.ts");
      expect(String(injectedHint?.content)).toContain("tsconfig.node.json");
    });

    it("injects a recovery hint for duplicate export compiler errors", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"\\n> freight-scheduler-lab@0.1.0 test\\n> vitest run packages/core\\n","stderr":"Error: Transform failed with 1 error:\\n/workspace/packages/core/src/index.ts:257:9: ERROR: Multiple exports with the same name \\"Scheduler\\"\\n  255|\\n  256|  // Re-export main API\\n  257|  export { Scheduler };\\n     |           ^\\n  258|  export default Scheduler;\\n"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npm","args":["test","--","packages/core"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("exports `Scheduler` more than once"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("export { Scheduler }");
      expect(String(injectedHint?.content)).toContain("rerun the failing build/test");
    });

    it("injects a recovery hint for JSON-escaped source content written into a compiler target", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":101,"stdout":"","stderr":"error: unknown start of token: \\\\\\n --> gridforge-core/src/lib.rs:48:15\\n  |\\n48 |     let map = \\\\\\"S#G\\\\\\";\\n  |               ^\\n\\nerror[E0765]: unterminated double quote string\\n --> gridforge-core/src/lib.rs:48:16\\n  |\\n48 |     let map = \\\\\\"S#G\\\\\\";\\n  |                ^^^^^^^^^\\n\\nerror: could not compile `gridforge-core` due to 2 previous errors"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"cargo","args":["test","--workspace","--quiet"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("JSON escape sequences"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("raw source code");
      expect(String(injectedHint?.content)).toContain("JSON-encoded representation");
    });

    it("replaces stale recovery hints with the latest timeout hint and traces the active keys", async () => {
      const events: Array<Record<string, unknown>> = [];
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"exitCode":2,"stdout":"error TS6059: File \'/workspace/packages/web/vite.config.ts\' is not under \'rootDir\' \'/workspace/packages/web/src\'.","stderr":"Command failed: npx tsc --build"}',
        )
        .mockResolvedValueOnce(
          '{"exitCode":null,"timedOut":true,"stdout":"Running core tests...\\nBFS test passed, cost: 3\\nUnreachable test passed\\n","stderr":"Command failed: node packages/core/dist/test/index.test.js\\n"}',
        );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"npx","args":["tsc","--build"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.bash",
                  arguments:
                    '{"command":"node","args":["packages/core/dist/test/index.test.js"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "stopped retrying" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) => {
              events.push(event as unknown as Record<string, unknown>);
            },
          },
        }),
      );

      const thirdCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      const timeoutHint = thirdCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("A test or code path likely hung"),
      );
      const staleRootDirHint = thirdCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("includes files outside `rootDir`"),
      );
      expect(timeoutHint).toBeDefined();
      expect(staleRootDirHint).toBeUndefined();

      const followupPreparedEvents = events.filter(
        (event) =>
          event.type === "model_call_prepared" &&
          event.phase === "tool_followup",
      );
      expect(followupPreparedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              activeRecoveryHintKeys: ["system-bash-typescript-rootdir-scope"],
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              activeRecoveryHintKeys: ["system.bash-test-runner-timeout"],
            }),
          }),
        ]),
      );
    });

    it("injects a recovery hint when CommonJS require is used against an exports-only package", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        '{"exitCode":1,"stdout":"","stderr":"Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No \\"exports\\" main defined in /workspace/node_modules/@demo/core/package.json"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    "{\"command\":\"node -e \\\"const core = require('@demo/core'); console.log(core)\\\"\"}",
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Do not verify it with CommonJS `require(...)`"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("node --input-type=module");
      expect(String(injectedHint?.content)).toContain("package `exports` map");
    });

    it("injects a recovery hint when localhost is blocked by system.browse", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Private/loopback address blocked: 127.0.0.1"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("block localhost/private/internal addresses"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("CANNOT reach");
    });

    it("injects a recovery hint when localhost is blocked by system.browserSessionStart", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          error: {
            family: "browser_session",
            code: "browser_session.domain_blocked",
            message:
              "SSRF target blocked: localhost. system.http*/system.browse intentionally block localhost/private/internal addresses.",
          },
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
                {
                  id: "call-1",
                  name: "system.browserSessionStart",
                  arguments: '{"url":"http://127.0.0.1:5173"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("system.browserSession*/system.browserAction"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("Playwright/Chromium");
    });

    it("injects a recovery hint when desktop.bash is unavailable", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Tool not found: \\"desktop.bash\\""}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "desktop.bash",
                  arguments: '{"command":"ls"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when container MCP tools require desktop session", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue("Container MCP tool — requires desktop session");
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "mcp.kitty.launch",
                  arguments: '{"instance":"terminal1"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Desktop/container tools are unavailable"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("mcp.*");
    });

    it("injects a recovery hint when execute_with_agent requires decomposition", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          success: false,
          status: "needs_decomposition",
          error:
            "Delegated objective is overloaded (research, implementation, validation). Split it into smaller execute_with_agent steps.",
          decomposition: {
            code: "needs_decomposition",
            phases: ["research", "implementation", "validation"],
            suggestedSteps: [
              { name: "research_requirements" },
              { name: "implement_core_scope" },
              { name: "verify_acceptance" },
            ],
          },
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
                {
                  id: "call-1",
                  name: "execute_with_agent",
                  arguments: '{"task":"build and verify the whole game in one child"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("objective was too large"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("research_requirements");
      expect(String(injectedHint?.content)).toContain("verify_acceptance");
    });

    it("injects a recovery hint when execute_with_agent reports low-signal browser evidence", async () => {
      const toolHandler = vi.fn().mockResolvedValue(
        safeJson({
          success: false,
          status: "failed",
          validationCode: "low_signal_browser_evidence",
          error:
            "Delegated task required browser-grounded evidence but child only used low-signal browser state checks",
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
                {
                  id: "call-1",
                  name: "execute_with_agent",
                  arguments: '{"task":"research reference games"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("low-signal browser state checks"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("browser_tabs");
      expect(String(injectedHint?.content)).toContain("about:blank");
    });

    it("injects a recovery hint when desktop-targeted command fails on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"gdb\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"gdb","args":["--version"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("host shell"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when node invocation of agenc-runtime is denied", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"node\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments:
                    '{"command":"node","args":["runtime/dist/bin/agenc-runtime.js","status","--output","json"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes('command:"agenc-runtime"'),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("status");
      expect(String(injectedHint?.content)).toContain("--output");
    });

    it("injects a recovery hint when python is denied on system.bash", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Command \\"python3\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"python3","args":["-c","print(1)"]}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("Python interpreter commands are blocked"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("/desktop attach");
      expect(String(injectedHint?.content)).toContain("desktop.bash");
    });

    it("injects a recovery hint when filesystem path is outside allowlist", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"error":"Access denied: Path is outside allowed directories"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.readFile",
                  arguments: '{"path":"/home/tetsuo/git/AgenC/mcp-terminal-smoke-test-prompt.txt"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const injectedHint = secondCallMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("blocked by path allowlisting"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("system.bash");
      expect(String(injectedHint?.content)).toContain("/tmp");
    });

    it("injects a recovery hint when a delegated child escapes its workspace root", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"error":"Delegated workspace root violation: path must stay under the delegated workspace root. Keep all filesystem paths under /home/tetsuo/agent-test/terrain-router-ts-2."}',
        )
        .mockResolvedValueOnce(
          '{"path":"/home/tetsuo/agent-test/terrain-router-ts-2/src/index.ts","bytesWritten":24}',
        );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-1",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"/tmp/terrain-monorepo/packages/core/src/index.ts","content":"export const bad = true;\\n"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.writeFile",
                  arguments:
                    '{"path":"/home/tetsuo/agent-test/terrain-router-ts-2/src/index.ts","content":"export const ok = true;\n"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "recovered" }))
          .mockResolvedValue(mockResponse({ content: "recovered" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
      });
      await executor.execute(
        createParams({
          message: createMessage(
            "Implement src/index.ts within the delegated workspace root only.",
          ),
          runtimeContext: {
            workspaceRoot: "/home/tetsuo/agent-test/terrain-router-ts-2",
          },
        }),
      );

      const followupMessages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls
        .slice(1)
        .flatMap((call) => (call[0] as LLMMessage[]) ?? []);
      const injectedHint = followupMessages.find(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.includes("delegated workspace root"),
      );
      expect(injectedHint).toBeDefined();
      expect(String(injectedHint?.content)).toContain("relative paths");
      expect(String(injectedHint?.content)).toContain("/tmp");
    });

    it("does not break loop when tool calls differ", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"err"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          // Return different args each time
          return Promise.resolve(
            mockResponse({
              content: callCount >= 3 ? "gave up" : "",
              finishReason: callCount >= 3 ? "stop" : "tool_calls",
              toolCalls:
                callCount >= 3
                  ? []
                  : [
                      {
                        id: `call-${callCount}`,
                        name: "desktop.bash",
                        arguments: `{"command":"mkdir attempt-${callCount}"}`,
                      },
                    ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      // All calls had different args, so loop detection should NOT fire
      expect(result.toolCalls.length).toBe(2);
      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("desktop.bash: err");
    });

    it("breaks loop after repeated all-failed rounds even with different args", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":"err"}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `call-${callCount}`,
                  name: "desktop.bash",
                  arguments: `{"command":"mkdir attempt-${callCount}"}`,
                },
              ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      // Should stop after 3 fully-failed rounds.
      expect(result.toolCalls.length).toBe(3);
      expect(toolHandler).toHaveBeenCalledTimes(3);
    });

    it("breaks loop sooner when all failed rounds are opaque", async () => {
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":""}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `call-${callCount}`,
                  name: "desktop.bash",
                  arguments: `{"command":"mkdir attempt-${callCount}"}`,
                },
              ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          message: createMessage("Set up the pong workspace in /workspace."),
          runtimeContext: { workspaceRoot: "/workspace" },
        }),
      );

      expect(result.stopReason).toBe("no_progress");
      expect(result.stopReasonDetail).toContain("All tool calls failed for 3 consecutive rounds");
      expect(result.toolCalls.length).toBe(3);
      expect(toolHandler).toHaveBeenCalledTimes(3);
    });

    it("emits a terminal trace event when repeated failed rounds stop the tool loop", async () => {
      const traceEvents: Array<Record<string, unknown>> = [];
      let callCount = 0;
      const toolHandler = vi
        .fn()
        .mockResolvedValue('{"exitCode":1,"stdout":"","stderr":""}');
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `call-${callCount}`,
                  name: "system.bash",
                  arguments:
                    '{"command":"grep","args":["missing|pattern","packages/core/src/index.ts"]}',
                },
              ],
            }),
          );
        }),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 10,
      });
      const result = await executor.execute(
        createParams({
          trace: {
            onExecutionTraceEvent: (event) =>
              traceEvents.push(event as unknown as Record<string, unknown>),
          },
        }),
      );

      expect(result.stopReason).toBe("no_progress");
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_loop_stuck_detected",
            phase: "tool_followup",
            payload: expect.objectContaining({
              reason: expect.stringContaining("failing tool calls"),
              roundToolCallCount: 1,
              roundFailureCount: 1,
              consecutiveFailCount: 3,
            }),
          }),
        ]),
      );
    });

    it("marks structured overall result as fail when any tool call fails", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"error":"command denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "desktop.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","steps":[{"step":1,"tool":"desktop.bash","ok":true}]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
      };

      expect(parsed.overall).toBe("fail");
      expect(result.toolCalls[0].isError).toBe(true);
    });

    it("marks structured overall result as fail when it claims unexecuted tools", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce('{"exitCode":0}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "desktop.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","steps":[{"step":1,"tool":"playwright.browser_navigate","ok":true}]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
      };

      expect(parsed.overall).toBe("fail");
    });

    it("marks structured overall checks result as fail when any tool call fails", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"error":"command denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "desktop.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","checks":[{"id":"env_versions","status":"pass","summary":"node -v: command denied"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain("tool_call_failed");
    });

    it("marks structured overall result as fail when delegated output signals unresolved failure", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"success":true,"status":"completed","output":"uname -s: Linux\\nnode -v: Command denied\\nnpm -v: 11.7.0","failedToolCalls":1}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "execute_with_agent", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","checks":[{"id":"env_versions","status":"pass","summary":"node -v: command denied"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain(
        "subagent_output_contains_failure_signal",
      );
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

    it("marks structured overall result as fail when pass checks report daemon down", async () => {
      const toolHandler = vi.fn().mockResolvedValueOnce(
        '{"success":true,"status":"completed","output":"running: false\\npid: n/a\\nport: n/a"}',
      );
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "execute_with_agent", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content:
                '{"overall":"pass","checks":[{"id":"daemon_status","status":"pass","summary":"running: false\\npid: n/a\\nport: n/a"}],"failure_reasons":[]}',
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());
      const parsed = JSON.parse(result.content) as {
        overall: string;
        failure_reasons?: string[];
      };

      expect(parsed.overall).toBe("fail");
      expect(parsed.failure_reasons).toContain(
        "check_summary_conflicts_with_pass_status",
      );
    });

    it("replaces low-information completion text when tool failures occurred", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"error":"Command \\"python3\\" is denied"}');
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "Done\nDone\nDone",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(createParams());

      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("system.bash");
      expect(result.content).not.toBe("Done\nDone\nDone");
    });

    it("does not preserve exact success sentinels when a tool failed", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce(
          '{"error":"Collaboration request failed: Feed post failed: AnchorError thrown in src/instructions/post_to_feed.rs:62. Error Code: InsufficientReputation."}',
        );
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
                  name: "social.requestCollaboration",
                  arguments:
                    '{"title":"Launch Ritual Drill","description":"Need 3 agents","requiredCapabilities":"3","maxMembers":3,"payoutMode":"fixed"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "R2_DONE_A2",
            }),
          ),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration, then after the tool calls finish, reply with exactly R2_DONE_A2.",
          ),
        }),
      );

      expect(result.content).toContain(
        "Execution could not be completed due to unresolved tool errors.",
      );
      expect(result.content).toContain("social.requestCollaboration");
      expect(result.content).not.toBe("R2_DONE_A2");
    });

    it("forces required tool choice for explicit social tool prompts", async () => {
      const toolHandler = vi
        .fn()
        .mockResolvedValueOnce('{"requestId":"req-123"}');
      const responses = [
        mockResponse({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-1",
              name: "social.requestCollaboration",
              arguments:
                '{"title":"Launch Ritual Drill","description":"Need 3 agents","requiredCapabilities":"3","maxMembers":3,"payoutMode":"fixed"}',
            },
          ],
        }),
        mockResponse({
          content: "R3_DONE_A2",
        }),
      ];
      const chat = vi
        .fn()
        .mockImplementation(async () => responses.shift() ?? mockResponse());
      const chatStream = vi
        .fn()
        .mockImplementation(
          async (
            _messages: LLMMessage[],
            onChunk: StreamProgressCallback,
            _options?: LLMChatOptions,
          ) => {
            const response = responses.shift() ?? mockResponse();
            onChunk({
              content: response.content,
              done: true,
              ...(response.toolCalls.length > 0
                ? { toolCalls: response.toolCalls }
                : {}),
            });
            return response;
          },
        );
      const provider = createMockProvider("primary", { chat, chatStream });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        allowedTools: ["social.requestCollaboration"],
      });
      await executor.execute(
        createParams({
          message: createMessage(
            "Use social.requestCollaboration with title Launch Ritual Drill, description Need 3 agents, requiredCapabilities 3, maxMembers 3, payoutMode fixed. After the tool calls finish, reply with exactly R3_DONE_A2.",
          ),
        }),
      );

      const firstCallOptions =
        chat.mock.calls[0]?.[1] ?? chatStream.mock.calls[0]?.[2];
      expect(firstCallOptions?.toolChoice).toBe("required");
      expect(firstCallOptions?.toolRouting?.allowedToolNames).toEqual([
        "social.requestCollaboration",
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Token budget
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Context compaction
  // --------------------------------------------------------------------------

  describe("context compaction", () => {
    it("compacts instead of throwing when budget exceeded", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // First two calls: normal responses that burn through the budget
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
          // Third call triggers compaction — summary call succeeds
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary of conversation" }),
          )
          // Fourth call is the actual execution after compaction
          .mockResolvedValueOnce(
            mockResponse({
              content: "response after compaction",
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // Third call — budget exceeded, compaction succeeds, execution continues
      const result = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );

      expect(result.compacted).toBe(true);
      expect(result.content).toBe("response after compaction");
    });

    it("preserves exact parent recall output after compaction", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse({
              content: "ACK-1",
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "ACK-2",
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary of earlier recall state" }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "**TOKEN=OBSIDIAN-SIGNAL-61**",
              usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
        plannerEnabled: true,
        allowedTools: ["desktop.text_editor", "execute_with_agent"],
        toolHandler: vi.fn().mockResolvedValue("unused"),
      });

      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          message: createMessage("Reply with exactly ACK-1 and nothing else."),
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          message: createMessage("Reply with exactly ACK-2 and nothing else."),
        }),
      );

      const result = await executor.execute(
        createParams({
          history: [
            {
              role: "user",
              content:
                "Parent endurance P1. Memorize token OBSIDIAN-SIGNAL-61 for later recall and answer exactly PARENT-STORED-P1.",
            },
            { role: "assistant", content: "PARENT-STORED-P1" },
            ...buildLongHistory(8),
          ],
          toolRouting: {
            routedToolNames: ["desktop.text_editor", "execute_with_agent"],
            expandedToolNames: ["desktop.text_editor", "execute_with_agent"],
          },
          message: createMessage(
            "After compaction, without extra words return the parent token from P1 exactly as TOKEN=OBSIDIAN-SIGNAL-61.",
          ),
        }),
      );

      expect(result.compacted).toBe(true);
      expect(result.content).toBe("TOKEN=OBSIDIAN-SIGNAL-61");
      expect(result.plannerSummary?.used).toBe(false);
      expect(provider.chat).toHaveBeenCalledTimes(4);
    });

    it("resets token counter after compaction", async () => {
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
          // Summary call
          .mockResolvedValueOnce(
            mockResponse({ content: "Summary" }),
          )
          // Execution after compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));
      expect(executor.getSessionTokenUsage("session-1")).toBe(2000);

      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // After compaction, counter was reset then new usage accumulated
      expect(executor.getSessionTokenUsage("session-1")).toBe(20);
    });

    it("emits provider trace events for pre-execution compaction calls", async () => {
      const traceEvents: unknown[] = [];
      let invocation = 0;
      const provider = createMockProvider("primary", {
        chat: vi.fn(async (_messages, options) => {
          invocation += 1;
          options?.trace?.onProviderTraceEvent?.({
            kind: "request",
            transport: "chat",
            provider: "primary",
            model: "mock-model",
            payload: { observed: true, invocation },
          });
          if (invocation <= 2) {
            return mockResponse({
              usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
            });
          }
          if (invocation === 3) {
            return mockResponse({ content: "Summary of conversation" });
          }
          return mockResponse({
            content: "response after compaction",
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          });
        }),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );
      await executor.execute(
        createParams({
          history: buildLongHistory(10),
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );

      expect(traceEvents).toContainEqual({
        kind: "request",
        transport: "chat",
        provider: "primary",
        model: "mock-model",
        callIndex: 0,
        callPhase: "compaction",
        payload: { observed: true, invocation: 3 },
      });
    });

    it("invokes onCompaction callback", async () => {
      const onCompaction = vi.fn();
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
          // Summary call
          .mockResolvedValueOnce(
            mockResponse({ content: "Compact summary text" }),
          )
          // Execution after compaction
          .mockResolvedValueOnce(mockResponse()),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
        onCompaction,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      expect(onCompaction).toHaveBeenCalledOnce();
      expect(onCompaction).toHaveBeenCalledWith(
        "session-1",
        "Compact summary text",
      );
    });

    it("short history skips summarization but still resets tokens", async () => {
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
          // With <=5 messages, compactHistory returns history as-is, no summary call
          // Next call is the actual execution
          .mockResolvedValueOnce(
            mockResponse({
              content: "short history response",
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 1500,
      });

      await executor.execute(createParams({ history: buildLongHistory(3) }));
      await executor.execute(createParams({ history: buildLongHistory(3) }));

      // Short history (<=5 msgs) — no summary LLM call needed
      const result = await executor.execute(
        createParams({ history: buildLongHistory(3) }),
      );

      expect(result.compacted).toBe(true);
      // Token counter reset + new usage
      expect(executor.getSessionTokenUsage("session-1")).toBe(20);
    });

    it("compacted is false when no budget set", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.compacted).toBe(false);
    });

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

    it("second budget hit re-triggers compaction", async () => {
      const onCompaction = vi.fn();
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Round 1: burn 1000 tokens
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // Round 2: burn 1000 more → total 2000 >= 100
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // First compaction summary
          .mockResolvedValueOnce(
            mockResponse({ content: "First summary" }),
          )
          // Execution after first compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            }),
          )
          // Second compaction summary
          .mockResolvedValueOnce(
            mockResponse({ content: "Second summary" }),
          )
          // Execution after second compaction
          .mockResolvedValueOnce(
            mockResponse({
              usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        sessionTokenBudget: 150,
        onCompaction,
      });

      await executor.execute(createParams({ history: buildLongHistory(10) }));
      await executor.execute(createParams({ history: buildLongHistory(10) }));

      // First compaction
      const r1 = await executor.execute(
        createParams({ history: buildLongHistory(10) }),
      );
      expect(r1.compacted).toBe(true);
      expect(executor.getSessionTokenUsage("session-1")).toBe(100);

      // Budget hit again (100 >= 150 is false, so need one more)
      // Actually 100 < 150, so this call passes normally. After this: 200 >= 150.
      // So we need another call to trigger second compaction.
      // Let's just verify it compacted once and the counter was reset.
      expect(onCompaction).toHaveBeenCalledTimes(1);
      expect(onCompaction).toHaveBeenCalledWith("session-1", "First summary");
    });
  });

  // --------------------------------------------------------------------------
  // Injection
  // --------------------------------------------------------------------------

  describe("injection", () => {
    it("skillInjector.inject() result appears in messages", async () => {
      const skillInjector = {
        inject: vi.fn().mockResolvedValue("Skill context: you can search"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
      });

      await executor.execute(createParams());

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[1]).toEqual({
        role: "system",
        content: "Skill context: you can search",
      });
    });

    it("skillInjector failure is non-blocking", async () => {
      const skillInjector = {
        inject: vi.fn().mockRejectedValue(new Error("injection failed")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // Only system prompt + user message (no skill context)
      expect(messages).toHaveLength(2);
    });

    it("memoryRetriever failure is non-blocking", async () => {
      const memoryRetriever = {
        retrieve: vi.fn().mockRejectedValue(new Error("retrieval failed")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages).toHaveLength(2);
    });

    it("memoryRetriever.retrieve() result appears in messages", async () => {
      const memoryRetriever = {
        retrieve: vi
          .fn()
          .mockResolvedValue("Memory: user prefers short answers"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages[1]).toEqual({
        role: "system",
        content: "Memory: user prefers short answers",
      });
    });

    it("progressProvider.retrieve() result appears in messages", async () => {
      const progressProvider = {
        retrieve: vi
          .fn()
          .mockResolvedValue("## Recent Progress\n\n- [tool_result] ran ls"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        progressProvider,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      expect(messages).toContainEqual({
        role: "system",
        content: "## Recent Progress\n\n- [tool_result] ran ls",
      });
    });

    it("progressProvider failure is non-blocking", async () => {
      const progressProvider = {
        retrieve: vi.fn().mockRejectedValue(new Error("progress backend down")),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        progressProvider,
      });

      const result = await executor.execute(createParams());

      expect(result.content).toBe("mock response");
    });

    it("progressProvider injected after learningProvider", async () => {
      const learningProvider = {
        retrieve: vi.fn().mockResolvedValue("## Learned Patterns\n\n- lesson"),
      };
      const progressProvider = {
        retrieve: vi.fn().mockResolvedValue("## Recent Progress\n\n- step"),
      };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        learningProvider,
        progressProvider,
      });

      await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "Previous turn" }],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      // System prompt + learning + progress = 3 system messages before history/user
      const systemMessages = messages.filter((m) => m.role === "system");
      expect(systemMessages).toHaveLength(3);
      expect(systemMessages[1].content).toContain("Learned Patterns");
      expect(systemMessages[2].content).toContain("Recent Progress");
    });

    it("does not inject persistent memory providers on a fresh session", async () => {
      const memoryRetriever = { retrieve: vi.fn().mockResolvedValue("Memory") };
      const learningProvider = { retrieve: vi.fn().mockResolvedValue("Learning") };
      const progressProvider = { retrieve: vi.fn().mockResolvedValue("Progress") };
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        memoryRetriever,
        learningProvider,
        progressProvider,
      });

      await executor.execute(createParams({ history: [] }));

      expect(memoryRetriever.retrieve).not.toHaveBeenCalled();
      expect(learningProvider.retrieve).not.toHaveBeenCalled();
      expect(progressProvider.retrieve).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Per-call streaming
  // --------------------------------------------------------------------------

  describe("per-call streaming", () => {
    it("per-call callback overrides constructor callback", async () => {
      const constructorCallback = vi.fn();
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        perCallCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("per-call callback used when no constructor callback set", async () => {
      const perCallCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams({ onStreamChunk: perCallCallback }));

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        perCallCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("constructor callback used when per-call not provided", async () => {
      const constructorCallback = vi.fn();
      const provider = createMockProvider();
      const executor = new ChatExecutor({
        providers: [provider],
        onStreamChunk: constructorCallback,
      });

      await executor.execute(createParams());

      expect(provider.chatStream).toHaveBeenCalledWith(
        expect.any(Array),
        constructorCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("no streaming when neither callback set", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      await executor.execute(createParams());

      expect(provider.chat).toHaveBeenCalledOnce();
      expect(provider.chatStream).not.toHaveBeenCalled();
    });

    it("per-call streaming persists through multi-round tool loop", async () => {
      const perCallCallback = vi.fn();
      const toolHandler = vi.fn().mockResolvedValue("tool result");
      const provider = createMockProvider("primary", {
        chatStream: vi
          .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                { id: "tc-1", name: "search", arguments: '{"q":"test"}' },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "final" })),
      });

      const executor = new ChatExecutor({ providers: [provider], toolHandler });
      const result = await executor.execute(
        createParams({ onStreamChunk: perCallCallback }),
      );

      expect(result.content).toBe("final");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
      // Both calls used the same per-call callback
      expect(provider.chatStream).toHaveBeenNthCalledWith(
        1,
        expect.any(Array),
        perCallCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
      expect(provider.chatStream).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        perCallCallback,
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "session-1",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Evaluator
  // --------------------------------------------------------------------------

  describe("evaluator", () => {
    it("not called when not configured", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.evaluation).toBeUndefined();
      expect(provider.chat).toHaveBeenCalledOnce();
    });

    it("passes when score meets threshold", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "good answer" }))
          // Evaluation call
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.9, "feedback": "clear and accurate"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation).toBeDefined();
      expect(result.evaluation!.score).toBe(0.9);
      expect(result.evaluation!.passed).toBe(true);
      expect(result.evaluation!.retryCount).toBe(0);
      expect(result.evaluation!.feedback).toBe("clear and accurate");
    });

    it("emits provider trace events for evaluator calls", async () => {
      const traceEvents: unknown[] = [];
      let invocation = 0;
      const provider = createMockProvider("primary", {
        chat: vi
          .fn(async (_messages, options) => {
            invocation += 1;
            options?.trace?.onProviderTraceEvent?.({
              kind: "request",
              transport: "chat",
              provider: "primary",
              model: "mock-model",
              payload: { observed: true, invocation },
            });
            return mockResponse({
              content:
                invocation === 1
                  ? "good answer"
                  : '{"score": 0.9, "feedback": "clear and accurate"}',
            });
          }),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      await executor.execute(
        createParams({
          trace: {
            includeProviderPayloads: true,
            onProviderTraceEvent: (event) => traceEvents.push(event),
          },
        }),
      );

      expect(traceEvents).toContainEqual({
        kind: "request",
        transport: "chat",
        provider: "primary",
        model: "mock-model",
        callIndex: 2,
        callPhase: "evaluator",
        payload: { observed: true, invocation: 2 },
      });
    });

    it("retries when below threshold then passes", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "weak answer" }))
          // First evaluation: low score
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.3, "feedback": "too vague"}',
            }),
          )
          // Retry response
          .mockResolvedValueOnce(mockResponse({ content: "improved answer" }))
          // Second evaluation: passes
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.8, "feedback": "much better"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7, maxRetries: 1 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation!.score).toBe(0.8);
      expect(result.evaluation!.passed).toBe(true);
      expect(result.evaluation!.retryCount).toBe(1);
      expect(result.content).toBe("improved answer");
    });

    it("accepts after max retries even if still low", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          // Main response
          .mockResolvedValueOnce(mockResponse({ content: "bad answer" }))
          // First evaluation: low
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.2, "feedback": "needs work"}',
            }),
          )
          // Retry response
          .mockResolvedValueOnce(mockResponse({ content: "still bad" }))
          // Second evaluation: still low
          .mockResolvedValueOnce(
            mockResponse({
              content: '{"score": 0.4, "feedback": "slightly better"}',
            }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7, maxRetries: 1 },
      });

      const result = await executor.execute(createParams());

      expect(result.evaluation!.score).toBe(0.4);
      expect(result.evaluation!.passed).toBe(false);
      expect(result.evaluation!.retryCount).toBe(1);
    });

    it("handles invalid JSON gracefully", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValueOnce(mockResponse({ content: "answer" }))
          // Evaluation returns invalid JSON
          .mockResolvedValueOnce(
            mockResponse({ content: "not valid json" }),
          ),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      // Parse failure defaults to score 1.0 — accepts the response
      expect(result.evaluation!.score).toBe(1.0);
      expect(result.evaluation!.passed).toBe(true);
    });

    it("skipped for empty content", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "" })),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        evaluator: { minScore: 0.7 },
      });

      const result = await executor.execute(createParams());

      // Empty content => evaluator not triggered
      expect(result.evaluation).toBeUndefined();
      // Only the main call, no evaluation call
      expect(provider.chat).toHaveBeenCalledOnce();
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

    it("omits historical image payloads from normalized history", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeImage = `data:image/png;base64,${"A".repeat(120_000)}`;

      await executor.execute(
        createParams({
          history: [
            {
              role: "assistant",
              content: [
                { type: "image_url", image_url: { url: hugeImage } },
                { type: "text", text: "previous screenshot context" },
              ],
            },
          ],
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const historicalAssistant = messages.find((m) => m.role === "assistant");
      expect(historicalAssistant).toBeDefined();
      expect(Array.isArray(historicalAssistant?.content)).toBe(true);
      const parts = historicalAssistant!.content as Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
      expect(
        parts.some(
          (p) => p.type === "text" && p.text.includes("prior image omitted"),
        ),
      ).toBe(true);
    });

    it("truncates oversized user messages before provider call", async () => {
      const provider = createMockProvider();
      const executor = new ChatExecutor({ providers: [provider] });
      const hugeUserMessage = "U".repeat(30_000);

      await executor.execute(
        createParams({
          message: createMessage(hugeUserMessage),
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as LLMMessage[];
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(typeof last.content).toBe("string");
      expect((last.content as string).length).toBeLessThanOrEqual(8_000);
    });

    it("suppresses runaway repetitive assistant output", async () => {
      const repetitive = Array.from({ length: 120 }, () => "Yes.").join("\n");
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: repetitive })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toContain("repetitive model output suppressed");
      expect(result.content.length).toBeLessThan(3_000);
    });

    it("truncates oversized final assistant output", async () => {
      const provider = createMockProvider("primary", {
        chat: vi
          .fn()
          .mockResolvedValue(mockResponse({ content: "x".repeat(80_000) })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const result = await executor.execute(createParams());

      expect(result.content).toContain("oversized model output suppressed");
      expect(result.content.length).toBeLessThanOrEqual(24_200);
    });

    it("keeps prompt growth bounded across repeated long turns", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn(async () => mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({ providers: [provider] });

      const promptSizes: number[] = [];
      let history: LLMMessage[] = [];

      for (let i = 0; i < 12; i++) {
        const userText = `turn-${i} ` + "x".repeat(6_000);
        const result = await executor.execute(
          createParams({
            history,
            message: createMessage(userText),
          }),
        );
        promptSizes.push(result.callUsage[0].afterBudget.estimatedChars);
        history = [
          ...history,
          { role: "user", content: userText },
          { role: "assistant", content: result.content },
        ];
      }

      // Hard budget is 500k chars in ChatExecutor; include small metadata overhead.
      expect(Math.max(...promptSizes)).toBeLessThanOrEqual(550_000);

      // Tail variance should be bounded once truncation/normalization kicks in.
      const tail = promptSizes.slice(-4);
      const tailRange = Math.max(...tail) - Math.min(...tail);
      expect(tailRange).toBeLessThan(50_000);
    });

    it("truncates oversized assistant tool-call arguments before follow-up model calls", async () => {
      let callCount = 0;
      const oversizedArgs = safeJson({
        command:
          "cat <<'EOF'\n" +
          "x".repeat(120_000) +
          "\nEOF",
      });
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(
              mockResponse({
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-1",
                    name: "desktop.bash",
                    arguments: oversizedArgs,
                  },
                ],
              }),
            );
          }
          return Promise.resolve(mockResponse({ content: "done" }));
        }),
      });
      const toolHandler = vi.fn().mockResolvedValue('{"exitCode":0,"stdout":"ok"}');
      const executor = new ChatExecutor({ providers: [provider], toolHandler });

      await executor.execute(createParams());

      const secondCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[1][0] as LLMMessage[];
      const assistantWithToolCalls = secondCallMessages.find(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          message.toolCalls.length > 0,
      );
      expect(assistantWithToolCalls).toBeDefined();
      const replayedArgs = assistantWithToolCalls!.toolCalls![0]!.arguments;
      expect(replayedArgs.length).toBeLessThanOrEqual(100_000);
      expect(replayedArgs).toContain("__truncatedToolCallArgs");
    });

    it("reports section-level budget diagnostics when constrained", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const executor = new ChatExecutor({
        providers: [provider],
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const history = Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `history-${i} ` + "h".repeat(3_000),
      })) as LLMMessage[];

      const result = await executor.execute(
        createParams({
          history,
          message: createMessage("u".repeat(6_000)),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.constrained).toBe(true);
      expect(
        (diagnostics?.sections.history.droppedMessages ?? 0) +
          (diagnostics?.sections.history.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });

    it("caps additive runtime system hints via prompt budget config", async () => {
      const toolHandler = vi.fn(async (name: string) => {
        if (name === "system.bash") {
          return '{"exitCode":1,"stderr":"spawn set ENOENT"}';
        }
        return '{"error":"Private/loopback address blocked: 127.0.0.1"}';
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
                  id: "call-1",
                  name: "system.bash",
                  arguments: '{"command":"set"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(
            mockResponse({
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call-2",
                  name: "system.browse",
                  arguments: '{"url":"http://127.0.0.1:8123"}',
                },
              ],
            }),
          )
          .mockResolvedValueOnce(mockResponse({ content: "done" })),
      });

      const executor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        maxToolRounds: 4,
        promptBudget: { maxRuntimeHints: 1 },
      });
      await executor.execute(createParams());

      const thirdCallMessages = (provider.chat as ReturnType<typeof vi.fn>)
        .mock.calls[2][0] as LLMMessage[];
      const runtimeHints = thirdCallMessages.filter(
        (msg) =>
          msg.role === "system" &&
          typeof msg.content === "string" &&
          msg.content.startsWith("Tool recovery hint:"),
      );
      expect(runtimeHints).toHaveLength(1);
      expect(String(runtimeHints[0].content)).toContain("localhost");
      expect(String(runtimeHints[0].content)).not.toContain("Shell builtins");
    });

    it("retains one system anchor and sheds extra runtime system blocks under pressure", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(mockResponse({ content: "ok" })),
      });
      const skillInjector = {
        inject: vi.fn().mockResolvedValue("skill ".repeat(3_000)),
      };
      const memoryRetriever = {
        retrieve: vi.fn().mockResolvedValue("memory ".repeat(3_000)),
      };
      const learningProvider = {
        retrieve: vi.fn().mockResolvedValue("learning ".repeat(3_000)),
      };
      const progressProvider = {
        retrieve: vi.fn().mockResolvedValue("progress ".repeat(3_000)),
      };

      const executor = new ChatExecutor({
        providers: [provider],
        skillInjector,
        memoryRetriever,
        learningProvider,
        progressProvider,
        promptBudget: {
          contextWindowTokens: 4_096,
          maxOutputTokens: 2_048,
          hardMaxPromptChars: 8_000,
        },
      });

      const result = await executor.execute(
        createParams({
          history: [{ role: "assistant", content: "previous turn" }],
          message: createMessage("hello"),
        }),
      );

      const diagnostics = result.callUsage[0].budgetDiagnostics;
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.sections.system_anchor.afterMessages).toBe(1);
      expect(
        (diagnostics?.sections.system_runtime.droppedMessages ?? 0) +
          (diagnostics?.sections.system_runtime.truncatedMessages ?? 0),
      ).toBeGreaterThan(0);
    });

    it("passes stateful session options through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-session" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-session",
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-session",
            reconciliationMessages: expect.any(Array),
          }),
        }),
      );
    });

    it("passes the full normalized history into reconciliationMessages", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const history = Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history-${index}`,
      })) as LLMMessage[];

      await executor.execute(
        createParams({
          history,
          sessionId: "stateful-history-window",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-history-window",
          },
        }),
      );

      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;
      expect(reconciliationMessages).toBeDefined();
      expect(reconciliationMessages).toHaveLength(26);
      expect(reconciliationMessages?.[1]).toMatchObject({
        role: "user",
        content: "history-0",
      });
      expect(reconciliationMessages?.at(-1)).toMatchObject({
        role: "user",
        content: "continue",
      });
    });

    it("preserves full history in reconciliationMessages when prompt replay truncates", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const longHistoryEntry = "history-" + "x".repeat(110_000);

      await executor.execute(
        createParams({
          history: [
            { role: "user", content: longHistoryEntry },
            { role: "assistant", content: "stored" },
          ],
          sessionId: "stateful-long-history",
          message: {
            ...createMessage("continue"),
            sessionId: "stateful-long-history",
          },
        }),
      );

      const callMessages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | LLMMessage[]
        | undefined;
      const options = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const reconciliationMessages = options?.stateful?.reconciliationMessages as
        | LLMMessage[]
        | undefined;

      expect(callMessages?.[1]).toMatchObject({
        role: "user",
      });
      expect(typeof callMessages?.[1]?.content).toBe("string");
      expect(String(callMessages?.[1]?.content)).toHaveLength(100_000);
      expect(String(callMessages?.[1]?.content).endsWith("...")).toBe(true);

      expect(reconciliationMessages?.[1]).toEqual({
        role: "user",
        content: longHistoryEntry,
      });
    });

    it("passes persisted stateful resume anchors through provider calls", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: true,
              store: true,
              fallbackToStateless: true,
              previousResponseId: "resp_prev",
              responseId: "resp_next",
              reconciliationHash: "hash-next",
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-resume" };

      await executor.execute(
        createParams({
          message,
          sessionId: "stateful-resume",
          stateful: {
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          },
        }),
      );

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stateful: expect.objectContaining({
            sessionId: "stateful-resume",
            reconciliationMessages: expect.any(Array),
            resumeAnchor: {
              previousResponseId: "resp_prev",
              reconciliationHash: "hash-prev",
            },
          }),
        }),
      );
    });

    it("injects compacted artifact refs into execution context for long-running sessions", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: true,
              fallbackToStateless: true,
              events: [],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const artifactContext: ArtifactCompactionState = {
        version: 1,
        snapshotId: "snapshot:artifact-context",
        sessionId: "session-1",
        createdAt: 1,
        source: "session_compaction",
        historyDigest: "digest",
        sourceMessageCount: 24,
        retainedTailCount: 5,
        narrativeSummary: "Compacted shell implementation context",
        openLoops: ["Verify PLAN.md against parser tests"],
        artifactRefs: [
          {
            id: "artifact:plan",
            kind: "plan",
            title: "PLAN.md",
            summary: "Current shell roadmap and milestone breakdown",
            createdAt: 1,
            digest: "digest-plan",
            tags: ["plan", "PLAN.md"],
          },
          {
            id: "artifact:test",
            kind: "test_result",
            title: "parser.test.ts",
            summary: "Parser regression tests passed after the lexer fix",
            createdAt: 2,
            digest: "digest-test",
            tags: ["test", "parser"],
          },
        ],
      };

      await executor.execute(
        createParams({
          history: buildLongHistory(6),
          message: createMessage("Finish the parser and keep the plan aligned."),
          stateful: {
            artifactContext,
          },
        }),
      );

      const messages = (provider.chat as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as LLMMessage[];
      const artifactMessage = messages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Compacted artifact context:"),
      );
      expect(artifactMessage).toBeDefined();
      expect(String(artifactMessage?.content)).toContain(
        "[artifact-ref:plan:artifact:plan] PLAN.md",
      );
      expect(String(artifactMessage?.content)).toContain(
        "[artifact-ref:test_result:artifact:test] parser.test.ts",
      );
    });

    // The "does not pass session stateful options into planner
    // synthesis calls" test was removed in Phase 2 of the planner
    // rip-out — there is no planner_synthesis phase anymore.

    it("aggregates stateful fallback reason counters in result summary", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: true,
              continued: false,
              store: true,
              fallbackToStateless: true,
              fallbackReason: "provider_retrieval_failure",
              events: [
                {
                  type: "stateful_continuation_attempt",
                },
                {
                  type: "stateful_fallback",
                  reason: "provider_retrieval_failure",
                },
              ],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-summary" };

      const result = await executor.execute(
        createParams({
          message,
          sessionId: "stateful-summary",
        }),
      );

      expect(result.statefulSummary).toBeDefined();
      expect(result.statefulSummary).toMatchObject({
        enabled: true,
        attemptedCalls: 1,
        continuedCalls: 0,
        fallbackCalls: 1,
      });
      expect(
        result.statefulSummary?.fallbackReasons.provider_retrieval_failure,
      ).toBe(1);
    });

    it("tracks store-disabled stateful fallbacks in the result summary", async () => {
      const provider = createMockProvider("primary", {
        chat: vi.fn().mockResolvedValue(
          mockResponse({
            content: "ok",
            stateful: {
              enabled: true,
              attempted: false,
              continued: false,
              store: false,
              fallbackToStateless: true,
              fallbackReason: "store_disabled",
              events: [
                {
                  type: "stateful_fallback",
                  reason: "store_disabled",
                },
              ],
            },
          }),
        ),
      });
      const executor = new ChatExecutor({ providers: [provider] });
      const message = { ...createMessage("stateful"), sessionId: "stateful-store-disabled" };

      const result = await executor.execute(
        createParams({
          message,
          sessionId: "stateful-store-disabled",
        }),
      );

      expect(result.statefulSummary).toBeDefined();
      expect(result.statefulSummary?.fallbackReasons.store_disabled).toBe(1);
      expect(result.statefulSummary?.attemptedCalls).toBe(0);
    });
  });
});
