import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const venice = vi.hoisted(() => ({
  load: vi.fn(),
}));
const discovery = vi.hoisted(() => ({
  discoverOllamaCloudModels: vi.fn(),
  discoverOpenRouterModels: vi.fn(),
}));

vi.mock("../../src/commands/venice-menu-models.js", () => ({
  loadVeniceMenuModels: venice.load,
}));

vi.mock("../../src/llm/model-metadata.js", () => ({
  ModelMetadataResolver: class {
    discoverOllamaCloudModels = discovery.discoverOllamaCloudModels;
    discoverOpenRouterModels = discovery.discoverOpenRouterModels;
  },
}));

import { ensureLiveModelCatalog } from "../../src/commands/live-model-catalog.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

/**
 * `/effort` and the status line read Venice, Ollama Cloud and OpenRouter
 * through this helper. The effort and hook suites mock it away. These
 * cases lock the shared cache: unknown providers never ask the network,
 * a bundled or failed read is not reused, Ollama Cloud keys include the
 * model, and a live read is reused for the next call.
 */

function ctx(): SlashCommandContext {
  return {
    session: {
      services: {
        providerEnvironment: {},
        configStore: { current: () => ({}) },
      },
    },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  } as unknown as SlashCommandContext;
}

describe("ensureLiveModelCatalog", () => {
  // The helper remembers a live read for 10 minutes. Advance past that
  // between cases so one case never reuses another's list.
  let now = Date.parse("2026-10-22T10:00:00Z");

  beforeEach(() => {
    now += 11 * 60_000;
    vi.useFakeTimers({ now });
    venice.load.mockReset();
    discovery.discoverOllamaCloudModels.mockReset();
    discovery.discoverOpenRouterModels.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not ask a provider that has no live catalog", async () => {
    await ensureLiveModelCatalog(ctx(), "deepseek", "deepseek-flash");
    await ensureLiveModelCatalog(ctx(), "abliteration", "llama-3");
    expect(venice.load).not.toHaveBeenCalled();
    expect(discovery.discoverOllamaCloudModels).not.toHaveBeenCalled();
    expect(discovery.discoverOpenRouterModels).not.toHaveBeenCalled();
  });

  it("does not reuse a Venice list that was not live", async () => {
    venice.load
      .mockResolvedValueOnce({ source: "bundled", reason: "no-key", models: [] })
      .mockResolvedValueOnce({ source: "live", models: [] });
    await ensureLiveModelCatalog(ctx(), "venice", "llama-3.3-70b");
    await ensureLiveModelCatalog(ctx(), "venice", "llama-3.3-70b");
    expect(venice.load).toHaveBeenCalledTimes(2);
  });

  it("reuses a live Venice list across models", async () => {
    venice.load.mockResolvedValue({ source: "live", models: [] });
    await ensureLiveModelCatalog(ctx(), "venice", "llama-3.3-70b");
    await ensureLiveModelCatalog(ctx(), "venice", "qwen3-235b");
    expect(venice.load).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a failed OpenRouter discovery", async () => {
    discovery.discoverOpenRouterModels
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await ensureLiveModelCatalog(ctx(), "openrouter", "openai/gpt-6-luna");
    await ensureLiveModelCatalog(ctx(), "openrouter", "openai/gpt-6-luna");
    await ensureLiveModelCatalog(ctx(), "openrouter", "openai/gpt-6-luna");
    expect(discovery.discoverOpenRouterModels).toHaveBeenCalledTimes(3);
  });

  it("reuses a live Ollama Cloud list per model and not across models", async () => {
    discovery.discoverOllamaCloudModels.mockResolvedValue([{ model: "kept" }]);
    await ensureLiveModelCatalog(ctx(), "ollama-cloud", "gemma4:31b");
    await ensureLiveModelCatalog(ctx(), "ollama-cloud", "gemma4:31b");
    await ensureLiveModelCatalog(ctx(), "ollama-cloud", "deepseek-v4.1-flash:1017");
    expect(discovery.discoverOllamaCloudModels).toHaveBeenCalledTimes(2);
    expect(discovery.discoverOllamaCloudModels.mock.calls.map((call) => call[1])).toEqual([
      "gemma4:31b",
      "deepseek-v4.1-flash:1017",
    ]);
  });
});
