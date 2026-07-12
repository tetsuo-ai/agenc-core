import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "./backend.js";
import { selectByokPrecedenceApiKey } from "./byok-precedence.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";

describe("BYOK precedence", () => {
  it("selects explicit keys, then BYOK keys, then managed keys", () => {
    expect(
      selectByokPrecedenceApiKey({
        explicitApiKey: " explicit-key ",
        byokApiKey: "env-key",
        managedKeysEnabled: true,
        managedApiKey: "managed-key",
      }),
    ).toBe("explicit-key");
    expect(
      selectByokPrecedenceApiKey({
        explicitApiKey: " ",
        byokApiKey: " env-key ",
        managedKeysEnabled: true,
        managedApiKey: "managed-key",
      }),
    ).toBe("env-key");
    expect(
      selectByokPrecedenceApiKey({
        byokApiKey: "",
        managedKeysEnabled: true,
        managedApiKey: " managed-key ",
      }),
    ).toBe("managed-key");
    expect(
      selectByokPrecedenceApiKey({
        byokApiKey: "",
        managedKeysEnabled: false,
        managedApiKey: " managed-key ",
      }),
    ).toBeUndefined();
  });

  it("uses env-var BYOK keys without vending managed keys", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return { provider, sessionId, apiKey: "managed-key" };
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
        conversationId: "conv-byok",
        env: {
          AGENC_HOME: agencHome,
          AGENC_WORKSPACE: workspace,
          HOME: agencHome,
          XAI_API_KEY: "env-key",
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "env-key",
          model: "grok-4.5",
        }),
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-byok"]);
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
