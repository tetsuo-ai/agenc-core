import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "./backend.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";

function localBackendThatCannotVend(calls: string[]): AuthBackend {
  return {
    login: () => ({ authenticated: true, provider: "local" }),
    logout: () => ({ authenticated: false }),
    whoami: () => ({ authenticated: true, provider: "local" }),
    vendKey: (provider, sessionId) => {
      calls.push(`vendKey:${provider}:${sessionId}`);
      throw new Error("local auth backend cannot vend managed keys");
    },
    inferAgencModel: () => {
      calls.push("inferAgencModel");
      throw new Error("not expected");
    },
    getSubscriptionTier: ({ sessionId } = {}) => {
      calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
      return "free";
    },
  };
}

describe("BYOK fallback", () => {
  it("uses configured BYOK api_key_env when local managed-key vending is unavailable", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));
    const calls: string[] = [];
    await writeFile(
      join(agencHome, "config.toml"),
      "[providers.grok]\napi_key_env = \"CUSTOM_GROK_KEY\"\n",
    );

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend: localBackendThatCannotVend(calls),
        conversationId: "conv-config-byok",
        env: {
          AGENC_HOME: agencHome,
          AGENC_WORKSPACE: workspace,
          CUSTOM_GROK_KEY: "configured-byok-key",
          HOME: agencHome,
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "configured-byok-key",
          model: "grok-4.3",
        }),
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-config-byok"]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it("reports a clear BYOK fallback error when neither managed nor BYOK keys are available", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));
    const calls: string[] = [];

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend: localBackendThatCannotVend(calls),
          conversationId: "conv-no-key",
          env: {
            AGENC_HOME: agencHome,
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            GROK_API_KEY: "",
            HOME: agencHome,
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(
        // Since e4a54ec1 ("route managed bootstrap through OpenRouter") grok
        // has no live managed route, so the actionable error explains the
        // OpenRouter-only managed surface plus both BYOK escape hatches.
        /grok provider requires an API key.*Subscription-managed access is currently live for OpenRouter only.*XAI_API_KEY.*providers\.grok\.api_key_env/,
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-no-key"]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("points at auth.managedKeys.enabled when managed vending is disabled for the live OpenRouter route", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-fallback-ws-"));
    const calls: string[] = [];

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend: localBackendThatCannotVend(calls),
          conversationId: "conv-no-key-openrouter",
          env: {
            AGENC_HOME: agencHome,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "false",
            AGENC_PROVIDER: "openrouter",
            AGENC_WORKSPACE: workspace,
            HOME: agencHome,
            OPENROUTER_API_KEY: "",
          },
        }),
      ).rejects.toThrow(
        /openrouter provider requires an API key.*auth\.managedKeys\.enabled.*OPENROUTER_API_KEY.*providers\.openrouter\.api_key_env/,
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-no-key-openrouter"]);
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
