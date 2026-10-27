import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { bootstrapLocalRuntimeSession } from "./bootstrap.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([
  { mode: "test", injected: false, requests: 0 },
  { mode: "test", injected: true, requests: 1 },
  { mode: "production", injected: false, requests: 1 },
])("OpenRouter startup catalog transport: $mode, injected=$injected", async ({ mode, injected, requests }) => {
  const home = await mkdtemp(join(tmpdir(), "agenc-openrouter-startup-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "agenc-openrouter-startup-work-"));
  // A failed listing has no background cache write to outlive this fixture.
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", transport);
  vi.stubEnv("NODE_ENV", mode);
  try {
    await expect(bootstrapLocalRuntimeSession({
      conversationId: "openrouter-catalog-transport",
      ...(injected ? { fetchImpl: transport } : {}),
      env: {
        HOME: home,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        AGENC_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "",
      },
    })).rejects.toThrow(/openrouter provider requires credentials/);
    expect(transport).toHaveBeenCalledTimes(requests);
    if (requests > 0) {
      expect(String(transport.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/models");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
