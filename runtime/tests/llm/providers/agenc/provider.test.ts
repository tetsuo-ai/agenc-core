import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../../auth/backend.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  StreamProgressCallback,
} from "../../types.js";
import { AgenCProvider } from "./index.js";

function response(model: string): LLMResponse {
  return {
    content: "ok",
    toolCalls: [],
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
    model,
    finishReason: "stop",
  };
}

function makeDelegateProvider(model: string): LLMProvider {
  return {
    name: "grok",
    chat: vi.fn(async () => response(model)),
    chatStream: vi.fn(
      async (
        _messages: LLMMessage[],
        onChunk: StreamProgressCallback,
      ) => {
        const chunk: LLMStreamChunk = {
          content: "ok",
          done: true,
        };
        onChunk(chunk);
        return response(model);
      },
    ),
    healthCheck: vi.fn(async () => true),
    getExecutionProfile: vi.fn(async () => ({
      provider: "grok",
      model,
      usageReporting: "authoritative" as const,
      supportsMaxOutputTokens: true,
      contextWindowTokens: 131_072,
    })),
  };
}

describe("AgenCProvider", () => {
  it("routes hosted model aliases through AuthBackend inference and key vending", async () => {
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return { provider, sessionId, apiKey: "managed-key" };
      },
      inferAgencModel: ({
        provider,
        requestedModel,
        sessionId,
        subscriptionTier,
      } = {}) => {
        calls.push(
          `infer:${provider ?? ""}:${requestedModel ?? ""}:${sessionId ?? ""}:${subscriptionTier ?? ""}`,
        );
        return {
          provider: "grok",
          model: "grok-4-fast",
          subscriptionTier,
        };
      },
      getSubscriptionTier: () => "team",
    };
    const delegate = makeDelegateProvider("grok-4-fast");
    const providerFactory = vi.fn(() => delegate);
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      subscriptionTier: "team",
      model: "agenc",
      providerFactory,
      providerOptions: {
        baseURL: "http://127.0.0.1:8000/v1",
      },
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }], {
        model: "agenc:fast",
        singleWireAttempt: true,
      }),
    ).resolves.toMatchObject({
      content: "ok",
      model: "grok-4-fast",
    });

    expect(calls).toEqual([
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
    ]);
    expect(providerFactory).toHaveBeenCalledWith(
      "grok",
      expect.objectContaining({
        apiKey: "managed-key",
        baseURL: "http://127.0.0.1:8000/v1",
        model: "grok-4-fast",
      }),
    );
    expect(delegate.chat).toHaveBeenCalledWith(
      [{ role: "user", content: "hello" }],
      expect.objectContaining({
        model: "grok-4-fast",
        singleWireAttempt: true,
      }),
    );

    const chunks: LLMStreamChunk[] = [];
    await expect(
      provider.chatStream(
        [{ role: "user", content: "stream" }],
        (chunk) => chunks.push(chunk),
        { model: "agenc:fast", singleWireAttempt: true },
      ),
    ).resolves.toMatchObject({
      content: "ok",
      model: "grok-4-fast",
    });
    await expect(provider.healthCheck()).resolves.toBe(true);
    await expect(provider.getExecutionProfile()).resolves.toMatchObject({
      provider: "grok",
      model: "grok-4-fast",
      contextWindowTokens: 131_072,
    });
    expect(chunks).toEqual([{ content: "ok", done: true }]);
    expect(delegate.chatStream).toHaveBeenCalledWith(
      [{ role: "user", content: "stream" }],
      expect.any(Function),
      expect.objectContaining({
        model: "grok-4-fast",
        singleWireAttempt: true,
      }),
    );
    expect(delegate.healthCheck).toHaveBeenCalledOnce();
    expect(delegate.getExecutionProfile).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
      "infer:agenc:agenc:session-1:team",
      "vendKey:grok:session-1",
    ]);
  });

  it("refreshes routed delegates after the vended key expires", async () => {
    let nowMs = 1_000;
    let vendCount = 0;
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        vendCount += 1;
        return {
          provider,
          sessionId,
          apiKey: `managed-key-${vendCount}`,
          expiresAt: new Date(nowMs + 50).toISOString(),
        };
      },
      inferAgencModel: ({
        provider,
        requestedModel,
        sessionId,
        subscriptionTier,
      } = {}) => {
        calls.push(
          `infer:${provider ?? ""}:${requestedModel ?? ""}:${sessionId ?? ""}:${subscriptionTier ?? ""}`,
        );
        return {
          provider: "grok",
          model: "grok-4-fast",
          subscriptionTier,
        };
      },
      getSubscriptionTier: () => "team",
    };
    const firstDelegate = makeDelegateProvider("grok-4-fast");
    const secondDelegate = makeDelegateProvider("grok-4-fast");
    let factoryIndex = 0;
    const providerFactory = vi.fn(() => {
      const delegate = [firstDelegate, secondDelegate][factoryIndex];
      factoryIndex += 1;
      return delegate ?? makeDelegateProvider("grok-4-fast");
    });
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      subscriptionTier: "team",
      model: "agenc:fast",
      providerFactory,
      nowMs: () => nowMs,
    });

    await provider.chat([{ role: "user", content: "first" }]);
    nowMs += 49;
    await provider.chat([{ role: "user", content: "still cached" }]);
    nowMs += 2;
    await provider.chat([{ role: "user", content: "refresh" }]);

    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(firstDelegate.chat).toHaveBeenCalledTimes(2);
    expect(secondDelegate.chat).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
    ]);
  });

  it("pins an option-specific profiled delegate for exactly one invocation", async () => {
    let nowMs = 1_000;
    const inferAgencModel = vi.fn(
      ({ requestedModel }: { readonly requestedModel?: string } = {}) => ({
        provider: "grok",
        model:
          requestedModel === "agenc:fast"
            ? "grok-4-fast"
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
    const firstDelegate = makeDelegateProvider("grok-4-fast");
    const secondDelegate = makeDelegateProvider("grok-4-fast");
    const providerFactory = vi
      .fn()
      .mockReturnValueOnce(firstDelegate)
      .mockReturnValueOnce(secondDelegate);
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      model: "agenc:default",
      providerFactory,
      nowMs: () => nowMs,
    });

    const profile = await provider.getExecutionProfile({
      model: "agenc:fast",
      maxOutputTokens: 32,
    });
    expect(profile).toMatchObject({
      provider: "grok",
      model: "grok-4-fast",
      providerExecutionHandle: expect.any(Object),
    });
    nowMs += 10;
    const admittedOptions = {
      model: "agenc:fast",
      maxOutputTokens: 32,
      singleWireAttempt: true as const,
      providerExecutionHandle: profile.providerExecutionHandle,
    };
    await expect(
      provider.chat([{ role: "user", content: "one wire" }], admittedOptions),
    ).resolves.toMatchObject({ model: "grok-4-fast" });

    expect(inferAgencModel).toHaveBeenCalledTimes(1);
    expect(inferAgencModel).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: "agenc:fast" }),
    );
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(firstDelegate.chat).toHaveBeenCalledOnce();
    expect(firstDelegate.chat).toHaveBeenCalledWith(
      [{ role: "user", content: "one wire" }],
      expect.objectContaining({
        model: "grok-4-fast",
        maxOutputTokens: 32,
        singleWireAttempt: true,
      }),
    );
    expect(firstDelegate.chat.mock.calls[0]?.[1]).not.toHaveProperty(
      "providerExecutionHandle",
    );

    await expect(
      provider.chat([{ role: "user", content: "duplicate" }], admittedOptions),
    ).rejects.toThrow("invalid or already-consumed execution handle");
    expect(secondDelegate.chat).not.toHaveBeenCalled();
  });

  it("bounds routed delegate caching when vended keys have no expiry", async () => {
    let nowMs = 2_000;
    let vendCount = 0;
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        vendCount += 1;
        return {
          provider,
          sessionId,
          apiKey: `managed-key-${vendCount}`,
        };
      },
      inferAgencModel: ({
        provider,
        requestedModel,
        sessionId,
        subscriptionTier,
      } = {}) => {
        calls.push(
          `infer:${provider ?? ""}:${requestedModel ?? ""}:${sessionId ?? ""}:${subscriptionTier ?? ""}`,
        );
        return {
          provider: "grok",
          model: "grok-4-fast",
          subscriptionTier,
        };
      },
      getSubscriptionTier: () => "team",
    };
    const firstDelegate = makeDelegateProvider("grok-4-fast");
    const secondDelegate = makeDelegateProvider("grok-4-fast");
    let factoryIndex = 0;
    const providerFactory = vi.fn(() => {
      const delegate = [firstDelegate, secondDelegate][factoryIndex];
      factoryIndex += 1;
      return delegate ?? makeDelegateProvider("grok-4-fast");
    });
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      subscriptionTier: "team",
      model: "agenc:fast",
      providerFactory,
      delegateCacheTtlMs: 100,
      nowMs: () => nowMs,
    });

    await provider.chat([{ role: "user", content: "first" }]);
    nowMs += 99;
    await provider.chat([{ role: "user", content: "still cached" }]);
    nowMs += 2;
    await provider.chat([{ role: "user", content: "refresh" }]);

    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(firstDelegate.chat).toHaveBeenCalledTimes(2);
    expect(secondDelegate.chat).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
      "infer:agenc:agenc:fast:session-1:team",
      "vendKey:grok:session-1",
    ]);
  });

  it("converts delegate health check rejections to false", async () => {
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey: (provider, sessionId) => ({
        provider,
        sessionId,
        apiKey: "managed-key",
      }),
      inferAgencModel: () => ({
        provider: "grok",
        model: "grok-4-fast",
      }),
      getSubscriptionTier: () => "team",
    };
    const delegate = {
      ...makeDelegateProvider("grok-4-fast"),
      healthCheck: vi.fn(async () => {
        throw new Error("delegate unavailable");
      }),
    };
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      model: "agenc",
      providerFactory: () => delegate,
    });

    await expect(provider.healthCheck()).resolves.toBe(false);
    expect(delegate.healthCheck).toHaveBeenCalledOnce();
  });

  it("fails closed when model inference returns the AgenC provider again", async () => {
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey: () => {
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => ({
        provider: "agenc",
        model: "agenc",
      }),
      getSubscriptionTier: () => "team",
    };
    const provider = new AgenCProvider({
      authBackend,
      sessionId: "session-1",
      model: "agenc",
      providerFactory: () => makeDelegateProvider("grok-4-fast"),
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(/provider agenc/);
  });
});
