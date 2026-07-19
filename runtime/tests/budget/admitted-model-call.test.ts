import { describe, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type { AuthBackend } from "../../src/auth/backend.js";
import { AgenCProvider } from "../../src/llm/providers/agenc/index.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "ok",
    toolCalls: [],
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      availability: "reported",
      provenance: "provider",
      cachedInputTokens: 20,
      reasoningOutputTokens: 10,
      webSearchRequests: 0,
    },
    model: "grok-4.5",
    finishReason: "stop",
    ...overrides,
  };
}

function harness(options: {
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly hasHardCostCap?: boolean;
  readonly hasHardTokenCap?: boolean;
  readonly authoritative?: boolean;
  readonly supportsMaxOutputTokens?: boolean;
}) {
  const leaseController = new AbortController();
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: "reconciled" as const,
  }));
  const holdUnknown = vi.fn();
  const cancelRun = vi.fn();
  const acknowledgeCompletion = vi.fn();
  const voidReservation = vi.fn();
  const recordFallback = vi.fn();
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => {
      if (input.denialReason !== undefined) {
        throw new AdmissionDeniedError(input.denialReason);
      }
      return {
        decision: "allow",
        reservation: {
          reservationId: "reservation-1",
          step: { runId: "run-1", stepId: input.stepId },
          reservedCostUsd: input.maxCostUsd ?? 0,
          reservedTokens: input.maxInputTokens + input.maxOutputTokens,
          reservedAt: "2026-07-18T00:00:00.000Z",
        },
        request: {
          step: { runId: "run-1", stepId: input.stepId },
          kind: input.kind,
          estimate: {
            maxInputTokens: input.maxInputTokens,
            maxOutputTokens: input.maxOutputTokens,
            maxCostUsd: input.maxCostUsd,
          },
          workspaceId: "workspace-1",
          sessionId: "session-1",
          parentScopeId: "session-1",
          autonomous: false,
        },
        signal: leaseController.signal,
      };
    },
  );
  const admission = {
    scope: {
      runId: "run-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      autonomous: false,
      ...(options.maxCostUsd !== undefined
        ? { maxCostUsd: options.maxCostUsd }
        : {}),
      ...(options.maxTokens !== undefined
        ? { maxTokens: options.maxTokens }
        : {}),
      ...(options.hasHardCostCap === true ? { hasHardCostCap: true } : {}),
      ...(options.hasHardTokenCap === true ? { hasHardTokenCap: true } : {}),
    },
    acquire,
    markDispatched: vi.fn(),
    reconcile,
    holdUnknown,
    cancelRun,
    void: voidReservation,
    acknowledgeCompletion,
    recordFallback,
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  const abortTerminal = vi.fn();
  const session = {
    conversationId: "session-1",
    services: {
      executionAdmission: admission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: vi.fn() },
    },
    abortTerminal,
  } as unknown as Session;
  const provider = {
    name: "grok",
    getExecutionProfile: async () => ({
      usageReporting:
        options.authoritative === false ? "unavailable" : "authoritative",
      supportsMaxOutputTokens: options.supportsMaxOutputTokens !== false,
    }),
  } as unknown as LLMProvider;
  return {
    acknowledgeCompletion,
    acquire,
    admission,
    cancelRun,
    holdUnknown,
    leaseController,
    provider,
    recordFallback,
    reconcile,
    session,
    voidReservation,
  };
}

function callOptions(
  state: ReturnType<typeof harness>,
  options: LLMChatOptions,
  invoke: (options: LLMChatOptions) => Promise<LLMResponse>,
) {
  return runAdmittedModelCall({
    session: state.session,
    provider: state.provider,
    messages: [{ role: "user", content: "hello" }],
    options,
    stepId: "model:1",
    model: "grok-4.5",
    providerName: "grok",
    invoke,
  });
}

describe("runAdmittedModelCall", () => {
  test("reserves a conservative input bound and reconciles all billed usage", async () => {
    const state = harness({ maxCostUsd: 1 });

    await callOptions(state, { maxOutputTokens: 200 }, async (options) => {
      expect(options.maxOutputTokens).toBe(200);
      expect(options.singleWireAttempt).toBe(true);
      expect(options.signal).toBe(state.leaseController.signal);
      return response();
    });

    const request = state.acquire.mock.calls[0]?.[0];
    expect(request?.maxInputTokens).toBeGreaterThanOrEqual(
      Buffer.byteLength(
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          systemPrompt: "",
          tools: [],
          structuredOutput: null,
        }),
        "utf8",
      ),
    );
    expect(request?.maxCostUsd).toBeGreaterThan(0);
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
      inputTokens: 100,
      outputTokens: 50,
      // Grok 4.5: input + cached input + output.
      costUsd: 0.00051,
    });
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(state.acknowledgeCompletion).toHaveBeenCalledWith("reservation-1");
  });

  test("rejects a late provider success after durable cancellation", async () => {
    const state = harness({ maxCostUsd: 1 });
    const invoked = Promise.withResolvers<void>();
    const providerResult = Promise.withResolvers<LLMResponse>();
    const running = callOptions(
      state,
      { maxOutputTokens: 200 },
      async () => {
        invoked.resolve();
        // Deliberately ignore the admitted AbortSignal and resolve later.
        return providerResult.promise;
      },
    );
    await invoked.promise;
    const cancellation = new AdmissionDeniedError(
      "operator_cancelled",
      "cancelled",
    );
    state.leaseController.abort(cancellation);
    providerResult.resolve(response());

    await expect(running).rejects.toBe(cancellation);
    // Reported late usage still replaces the conservative unknown hold in the
    // real repository; it must not make the cancelled call successful.
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.00051,
    });
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
  });

  test("reserves a finite conservative ceiling for provider-native search fees", async () => {
    const state = harness({});

    await callOptions(
      state,
      {
        maxOutputTokens: 200,
        toolRouting: { allowedToolNames: ["web_search"] },
      },
      async () => response({
        usage: { ...response().usage, webSearchRequests: 2 },
      }),
    );

    const request = state.acquire.mock.calls[0]?.[0];
    expect(request?.maxCostUsd).toBeGreaterThanOrEqual(2);
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.02051,
    });
  });

  test("requires an authoritative bounded provider for token-only hard caps", async () => {
    const state = harness({ maxTokens: 1_000, authoritative: false });

    await expect(
      callOptions(state, { maxOutputTokens: 200 }, async () => response()),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "provider_budget_contract_unavailable",
    });
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        denialReason: "provider_budget_contract_unavailable",
      }),
      undefined,
    );
  });

  test("denies an uncapped call when the provider cannot enforce its output bound", async () => {
    const state = harness({ supportsMaxOutputTokens: false });
    const invoke = vi.fn(async () => response());

    await expect(
      callOptions(state, { maxOutputTokens: 200 }, invoke),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "provider_budget_contract_unavailable",
    });
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 200,
        denialReason: "provider_budget_contract_unavailable",
      }),
      undefined,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test("recognizes period-only hard caps even when the run itself is uncapped", async () => {
    const state = harness({ hasHardTokenCap: true, authoritative: false });

    await expect(
      callOptions(state, { maxOutputTokens: 200 }, async () => response()),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "provider_budget_contract_unavailable",
    });
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        denialReason: "provider_budget_contract_unavailable",
      }),
      undefined,
    );
  });

  test("denies unbounded provider-native paid tools under a hard USD cap", async () => {
    const state = harness({ maxCostUsd: 1 });

    await expect(
      callOptions(
        state,
        {
          maxOutputTokens: 200,
          toolRouting: { allowedToolNames: ["web_search"] },
        },
        async () => response(),
      ),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "unbounded_provider_tool_under_hard_cap",
    });
    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        denialReason: "unbounded_provider_tool_under_hard_cap",
      }),
      undefined,
    );
  });

  test("keeps the full reservation held when provider pricing is unknown", async () => {
    const state = harness({});

    await expect(
      callOptions(state, { maxOutputTokens: 200 }, async () =>
        response({ model: "unknown-model" }),
      ),
    ).resolves.toMatchObject({ model: "unknown-model" });
    expect(state.holdUnknown).toHaveBeenCalledWith(
      "reservation-1",
      "unpriced_provider_response",
    );
    expect(state.reconcile).not.toHaveBeenCalled();
  });

  test("durably cancel-locks an unpriced provider response under a hard USD cap", async () => {
    const state = harness({ maxCostUsd: 1 });

    await expect(
      callOptions(state, { maxOutputTokens: 200 }, async () =>
        response({ model: "unknown-model" }),
      ),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "unpriced_provider_response",
    });
    expect(state.cancelRun).toHaveBeenCalledOnce();
    expect(state.cancelRun).toHaveBeenCalledWith("unpriced_provider_response");
    // cancelRun owns both the full unknown hold and run-tree cascade in one
    // transaction; a separate hold would reintroduce a crash gap.
    expect(state.holdUnknown).not.toHaveBeenCalled();
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(state.session.abortTerminal).toHaveBeenCalledWith(
      "provider_overrun",
    );
  });

  test("accounts managed routing with the concrete provider and model", async () => {
    const state = harness({ maxCostUsd: 1 });
    const routedProvider = {
      name: "agenc",
      getExecutionProfile: async () => ({
        provider: "grok",
        model: "grok-4.5",
        usageReporting: "authoritative" as const,
        supportsMaxOutputTokens: true,
      }),
    } as unknown as LLMProvider;

    await runAdmittedModelCall({
      session: state.session,
      provider: routedProvider,
      messages: [{ role: "user", content: "hello" }],
      options: { model: "managed-default", maxOutputTokens: 200 },
      stepId: "model:routed",
      model: "managed-default",
      providerName: "agenc",
      invoke: async () => response(),
    });

    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-4.5",
        provider: "grok",
        maxCostUsd: expect.any(Number),
      }),
      undefined,
    );
    expect(state.admission.recordFallback).toHaveBeenCalledWith({
      stepId: "model:routed",
      fromModel: "managed-default",
      toModel: "grok-4.5",
      fromProvider: "agenc",
      toProvider: "grok",
      reason: "provider_execution_profile_resolution",
    });
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.00051,
    });
  });

  test("voids and releases an acquired lease when routing evidence cannot be journaled", async () => {
    const state = harness({ maxCostUsd: 1 });
    const invoke = vi.fn(async () => response());
    const onFallbackRecorded = vi.fn();
    state.recordFallback.mockImplementationOnce(() => {
      throw new Error("fallback journal unavailable");
    });

    await expect(
      runAdmittedModelCall({
        session: state.session,
        provider: state.provider,
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 200 },
        stepId: "model:fallback-journal-failure",
        model: "grok-4.5",
        providerName: "grok",
        fallback: {
          fromModel: "grok-4",
          fromProvider: "grok",
          reason: "provider_fallback_ladder",
        },
        onFallbackRecorded,
        invoke,
      }),
    ).rejects.toThrow("fallback journal unavailable");

    expect(state.acquire).toHaveBeenCalledOnce();
    expect(onFallbackRecorded).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(state.voidReservation).toHaveBeenCalledWith(
      "reservation-1",
      "provider_call_failed_before_dispatch",
    );
    expect(state.acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(state.acknowledgeCompletion).toHaveBeenCalledWith("reservation-1");
  });

  test("pins the request-option managed route through queue delay to one wire", async () => {
    const state = harness({ maxCostUsd: 1 });
    let nowMs = 1_000;
    const inferAgencModel = vi.fn(
      ({ requestedModel }: { readonly requestedModel?: string } = {}) => ({
        provider: "grok",
        model:
          requestedModel === "agenc:override"
            ? "grok-4.5"
            : "grok-default-should-not-run",
      }),
    );
    const authBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      inferAgencModel,
      vendKey: (provider: string, sessionId: string) => ({
        provider,
        sessionId,
        apiKey: "managed-key",
        expiresAt: new Date(nowMs + 5).toISOString(),
      }),
      getSubscriptionTier: () => "team" as const,
    } as AuthBackend;
    const delegate = {
      name: "grok",
      chat: vi.fn(async () => response()),
      chatStream: vi.fn(),
      healthCheck: vi.fn(async () => true),
      getExecutionProfile: vi.fn(async () => ({
        provider: "grok",
        model: "grok-4.5",
        usageReporting: "authoritative" as const,
        supportsMaxOutputTokens: true,
      })),
    } as unknown as LLMProvider;
    const providerFactory = vi.fn(() => delegate);
    const managed = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      model: "agenc:default",
      providerFactory,
      nowMs: () => nowMs,
    });
    const messages = [{ role: "user" as const, content: "hello" }];

    await runAdmittedModelCall({
      session: state.session,
      provider: managed,
      messages,
      options: { model: "agenc:override", maxOutputTokens: 200 },
      stepId: "model:managed-pinned",
      model: "agenc:override",
      providerName: "agenc",
      invoke: async (admittedOptions) => {
        // Force the vended route to expire while admission is pending. The
        // dispatched call must use the profiled delegate, not refresh/reroute.
        nowMs += 10;
        return managed.chat(messages, admittedOptions);
      },
    });

    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-4.5",
        provider: "grok",
        maxCostUsd: expect.any(Number),
      }),
      undefined,
    );
    expect(inferAgencModel).toHaveBeenCalledTimes(1);
    expect(inferAgencModel).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: "agenc:override" }),
    );
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(delegate.chat).toHaveBeenCalledTimes(1);
    expect(delegate.chat).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({
        model: "grok-4.5",
        maxOutputTokens: 200,
        singleWireAttempt: true,
      }),
    );
    expect(delegate.chat.mock.calls[0]?.[1]).not.toHaveProperty(
      "providerExecutionHandle",
    );
  });
});
