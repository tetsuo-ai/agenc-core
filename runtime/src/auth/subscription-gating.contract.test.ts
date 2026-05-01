import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";
import { RemoteAuthBackend } from "./backends/remote.js";

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
      subscriptionTierResolver: () => "free",
    });

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-free-managed",
          env: {
            AGENC_HOME: agencHome,
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
          model: "grok-4-fast",
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
