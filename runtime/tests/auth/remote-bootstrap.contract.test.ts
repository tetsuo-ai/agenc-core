import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeConfigs, defaultConfig } from "../config/schema.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";
import { createAuthBackend } from "./selection.js";

const REMOTE_AUTH_TOKEN_ENV = "AGENC_REMOTE_AUTH_TOKEN";
const REMOTE_AUTH_URL_ENV = "AGENC_REMOTE_AUTH_URL";

describe("remote AuthBackend bootstrap key vending", () => {
  it("vends a remote managed key through createAuthBackend during provider startup", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-auth-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-remote-auth-ws-"));
    // Managed subscription vending is OpenRouter-only (e4a54ec1 "route
    // managed bootstrap through OpenRouter"), so the remote key is vended
    // for the openrouter provider.
    const remoteFetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          provider: "openrouter",
          sessionId: "conv-remote-key",
          apiKey: " remote-managed-key ",
        }),
        {
          status: 200,
        },
      ),
    );
    const authBackend = createAuthBackend(
      mergeConfigs(defaultConfig(), {
        auth: { backend: "remote", managedKeys: { enabled: true } },
      }),
      {
        agencHome,
        env: {
          [REMOTE_AUTH_URL_ENV]: "http://127.0.0.1:8787/vend-key",
          [REMOTE_AUTH_TOKEN_ENV]: "remote-token",
        },
        remote: {
          fetchImpl: remoteFetchImpl,
          subscriptionTierResolver: () => "pro",
        },
      },
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
        authBackend,
        conversationId: "conv-remote-key",
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error("offline runtime fixture")),
        env: {
          AGENC_HOME: agencHome,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_MODEL: "x-ai/grok-4.3",
          AGENC_PROVIDER: "openrouter",
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          GROK_API_KEY: "",
          HOME: agencHome,
          OPENROUTER_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "openrouter",
        expect.objectContaining({
          apiKey: "remote-managed-key",
          model: "x-ai/grok-4.3",
        }),
      );
      expect(remoteFetchImpl).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/vend-key",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            provider: "openrouter",
            sessionId: "conv-remote-key",
          }),
        }),
      );
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
