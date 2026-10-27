import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import { EndpointMetadataCache } from "../../src/llm/endpoint-metadata-cache.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";

const selection = { provider: "deepseek", model: "deepseek-flash" };
const config = mergeConfigs(defaultConfig(), {
  model_provider: selection.provider,
  model: selection.model,
});
const listing = (contextWindow: number) => new Response(JSON.stringify({
  data: [{ id: selection.model, context_window: contextWindow }],
}));
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("catalogued DeepSeek session metadata", () => {
  it("starts with the catalog while a custom endpoint refresh is pending, then uses refreshed limits", async () => {
    const download = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(download.promise);
    const manager = new StaticModelsManager({ config, metadata: {
      fetchImpl, env: { DEEPSEEK_BASE_URL: "https://proxy.example/v1" },
    } });
    expect(manager.tryGetModelInfoForProvider(selection.provider, selection.model)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    let resolved = false;
    const first = manager.getModelInfoForProvider(selection.provider, selection.model)
      .then((info) => { resolved = true; return info; });
    await nextTick();
    const resolvedBeforeDownload = resolved;
    expect(manager.tryGetModelInfoForProvider(selection.provider, selection.model)).toBeUndefined();
    download.resolve(listing(64_000));
    const initial = await first;
    expect(resolvedBeforeDownload).toBe(true);
    expect(initial.contextWindow).toBe(1_048_576);
    await vi.waitFor(async () => {
      expect((await manager.getModelInfoForProvider(selection.provider, selection.model)).contextWindow).toBe(64_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(manager.tryGetModelInfoForProvider(selection.provider, selection.model)?.contextWindow).toBe(64_000);
    expect(manager.tryGetModelInfoForProvider("openai", selection.model)).toBeUndefined();
  });

  it("deduplicates background refreshes and keeps catalog limits on transport failure", async () => {
    const download = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(download.promise);
    const manager = new StaticModelsManager({ config, metadata: {
      fetchImpl, env: { DEEPSEEK_BASE_URL: "https://proxy.example/v1" },
    } });
    const reads = Array.from({ length: 8 }, () => manager.getModelInfo(selection.model));
    await nextTick();
    download.reject(new Error("offline"));
    expect((await Promise.all(reads)).every((info) => info.contextWindow === 1_048_576)).toBe(true);
    await nextTick();
    expect((await manager.getModelInfo(selection.model)).contextWindow).toBe(1_048_576);
    // Only endpoint discovery runs for a catalogued model, never public fallbacks.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not publish a late old-endpoint refresh into the current session cache", async () => {
    const old = Promise.withResolvers<Response>();
    const fresh = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const env = { DEEPSEEK_BASE_URL: "https://first.example/v1" };
    const manager = new StaticModelsManager({ config, metadata: {
      fetchImpl, env, endpointCatalogs: new EndpointMetadataCache(),
    } });
    const first = manager.getModelInfo(selection.model);
    await nextTick();
    env.DEEPSEEK_BASE_URL = "https://second.example/v1";
    const second = manager.getModelInfo(selection.model);
    await nextTick();
    fresh.resolve(listing(32_000));
    await second;
    await vi.waitFor(async () => expect((await manager.getModelInfo(selection.model)).contextWindow).toBe(32_000));
    old.resolve(listing(64_000));
    await first.catch(() => undefined);
    await nextTick();
    expect((await manager.getModelInfo(selection.model)).contextWindow).toBe(32_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit limits without starting discovery", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new StaticModelsManager({
      config: mergeConfigs(config, { providers: { deepseek: {
        context_window_tokens: 16_000, max_output_tokens: 2_000,
      } } }),
      metadata: { fetchImpl, env: { DEEPSEEK_BASE_URL: "https://proxy.example/v1" } },
    });
    expect(await manager.getModelInfo(selection.model)).toMatchObject({ contextWindow: 16_000, maxOutputTokens: 2_000 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose completed metadata after the endpoint authority changes", async () => {
    const env = { DEEPSEEK_BASE_URL: "https://first.example/v1" };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing(64_000));
    const manager = new StaticModelsManager({ config, metadata: {
      fetchImpl, env, endpointCatalogs: new EndpointMetadataCache(),
    } });
    await manager.getModelInfo(selection.model);
    await vi.waitFor(() => expect(manager.tryGetModelInfoForProvider(selection.provider, selection.model)?.contextWindow).toBe(64_000));
    env.DEEPSEEK_BASE_URL = "https://second.example/v1";
    expect(manager.tryGetModelInfoForProvider(selection.provider, selection.model)).toBeUndefined();
    // A cache-only read must not cause a new request on the changed endpoint.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still waits for an uncatalogued model's actual endpoint limits", async () => {
    const download = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(download.promise);
    const manager = new StaticModelsManager({ config, metadata: {
      fetchImpl, env: { DEEPSEEK_BASE_URL: "https://proxy.example/v1" },
    } });
    let resolved = false;
    const first = manager.getModelInfo("private-model").then((info) => { resolved = true; return info; });
    await nextTick();
    const resolvedBeforeDownload = resolved;
    download.resolve(new Response(JSON.stringify({ data: [{ id: "private-model", context_window: 8_192 }] })));
    expect((await first).contextWindow).toBe(8_192);
    expect(resolvedBeforeDownload).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
