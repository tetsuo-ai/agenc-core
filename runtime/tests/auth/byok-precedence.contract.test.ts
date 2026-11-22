import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import { Session } from "../session/session.js";

describe("BYOK precedence", () => {
  it("uses env-var BYOK keys", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-byok-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-byok-ws-"));

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
          model: "grok-4.6",
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
