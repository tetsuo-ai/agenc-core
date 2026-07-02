import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgenCDaemonRuntimeAuthBackend } from "../app-server/provider-key-vending.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";
import { RemoteAuthBackend } from "./backends/remote.js";

;(globalThis as Record<string, unknown>).MACRO ??= {
  FEEDBACK_CHANNEL: "https://github.com/tetsuo-ai/agenc-core/issues",
  ISSUES_EXPLAINER: "open an issue",
  PACKAGE_URL: "@tetsuo-ai/runtime",
  VERSION: "test",
};

describe("remote subscription gating", () => {
  it("rejects remote free-tier managed key startup before key vending", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-tier-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tier-ws-"));
    const keyVendor = vi.fn(() => ({
      provider: "grok",
      sessionId: "conv-free-managed",
      apiKey: "managed-key",
    }));
    const authBackend = new RemoteAuthBackend({
      keyVendor,
      managedKeysEnabled: true,
      subscriptionTierResolver: () => "free",
    });

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-free-managed",
          env: {
            AGENC_HOME: agencHome,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            GROK_API_KEY: "",
            HOME: agencHome,
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/Managed provider keys require an active AgenC subscription/);
      expect(keyVendor).not.toHaveBeenCalled();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects remote free-tier managed key startup through the daemon wrapper", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-tier-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tier-ws-"));
    const keyVendor = vi.fn(() => ({
      provider: "grok",
      sessionId: "conv-free-daemon-managed",
      apiKey: "managed-key",
    }));
    const authBackend = createAgenCDaemonRuntimeAuthBackend(
      new RemoteAuthBackend({
        keyVendor,
        subscriptionTierResolver: () => "free",
      }),
    );

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-free-daemon-managed",
          env: {
            AGENC_HOME: agencHome,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            GROK_API_KEY: "",
            HOME: agencHome,
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/Managed provider keys require an active AgenC subscription/);
      expect(keyVendor).not.toHaveBeenCalled();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects remote free-tier hosted model routing before inference", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-tier-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tier-ws-"));
    const modelInferer = vi.fn(() => ({
      provider: "grok",
      model: "grok-4-fast",
    }));
    const authBackend = new RemoteAuthBackend({
      modelInferer,
      subscriptionTierResolver: () => "free",
    });

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-free-hosted",
          argv: ["node", "agenc", "--provider", "agenc"],
          env: {
            AGENC_HOME: agencHome,
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            GROK_API_KEY: "",
            HOME: agencHome,
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/Hosted AgenC model routing requires an active AgenC subscription/);
      expect(modelInferer).not.toHaveBeenCalled();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects remote free-tier hosted OpenRouter free model startup", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-tier-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tier-ws-"));
    const keyVendor = vi.fn(() => ({
      provider: "openrouter",
      sessionId: "conv-free-openrouter",
      apiKey: "managed-free-key",
      baseUrl: "https://llm.agenc.tech",
    }));
    const authBackend = new RemoteAuthBackend({
      keyVendor,
      managedKeysEnabled: true,
      subscriptionTierResolver: () => "free",
    });

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-free-openrouter",
          argv: [
            "node",
            "agenc",
            "--provider",
            "openrouter",
            "--model",
            "openai/gpt-oss-20b:free",
          ],
          env: {
            AGENC_HOME: agencHome,
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
            AGENC_WORKSPACE: workspace,
            HOME: agencHome,
            OPENROUTER_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/unknown model 'openai\/gpt-oss-20b:free'/);
      expect(keyVendor).not.toHaveBeenCalled();
    } finally {
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("allows remote free-tier BYOK startup without managed key vending", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-tier-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-tier-ws-"));
    const keyVendor = vi.fn(() => {
      throw new Error("key vending should not run");
    });
    const authBackend = new RemoteAuthBackend({
      keyVendor,
      subscriptionTierResolver: () => "free",
    });
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
        authBackend,
        conversationId: "conv-free-byok",
        env: {
          AGENC_HOME: agencHome,
          AGENC_WORKSPACE: workspace,
          HOME: agencHome,
          XAI_API_KEY: "byok-key",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.authSubscriptionTier).toBe("free");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "byok-key",
          model: "grok-4.3",
        }),
      );
      expect(keyVendor).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(agencHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
