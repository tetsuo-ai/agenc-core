import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import { EndpointMetadataCache, endpointMetadataForTransport, observeEndpointMetadataFailures, refreshEndpointMetadata } from "../../src/llm/endpoint-metadata-cache.js";
import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import type { LLMProvider } from "../../src/llm/types.js";

const config = mergeConfigs(defaultConfig(), { providers: { "openai-compatible": { base_url: "https://models.example/v1" } } });
const lookup = { provider: "openai-compatible", model: "private-model", config };
function response(context = 64000) {
  return new Response(JSON.stringify({ data: [
    { id: "private-model", context_length: context },
    { id: "other-model", context_length: 32000 },
  ] }), { status: 200 });
}

describe("endpoint cache resolver wiring", () => {
  it("shares JSON across resolvers while selecting each model and preserving live-over-explicit context", async () => {
    const endpointCatalogs = new EndpointMetadataCache();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const make = () => new ModelMetadataResolver({ endpointCatalogs, fetchImpl, env: {} });
    expect((await make().resolve(lookup)).contextWindow).toBe(64000);
    expect((await make().resolve({ ...lookup, model: "other-model" })).contextWindow).toBe(32000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const explicit = mergeConfigs(config, { providers: { "openai-compatible": { context_window_tokens: 128000, max_output_tokens: 1000 } } });
    const info = await make().resolve({ ...lookup, config: explicit });
    expect(info.contextWindow).toBe(64000);
    expect(info.maxOutputTokens).toBe(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // configuration invalidation
  });

  it("clears resolver and manager lifetime caches on explicit refresh, but TTL alone preserves active session metadata", async () => {
    let now = 0;
    let limit = 64000;
    const endpointCatalogs = new EndpointMetadataCache({ now: () => now, reuseMs: 10 });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(limit));
    const make = () => new StaticModelsManager({ config, metadata: { endpointCatalogs, fetchImpl, env: {} } });
    const active = make();
    expect((await active.getModelInfoForProvider(lookup.provider, lookup.model)).contextWindow).toBe(64000);
    now = 11;
    limit = 16000;
    expect((await active.getModelInfoForProvider(lookup.provider, lookup.model)).contextWindow).toBe(64000);
    expect((await make().getModelInfoForProvider(lookup.provider, lookup.model)).contextWindow).toBe(16000);
    refreshEndpointMetadata();
    expect((await active.getModelInfoForProvider(lookup.provider, lookup.model)).contextWindow).toBe(16000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("invalidates A to B to A credentials, endpoint changes and existing resolver state", async () => {
    const endpointCatalogs = new EndpointMetadataCache();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const env = { OPENAI_COMPATIBLE_API_KEY: "a" };
    const resolver = new ModelMetadataResolver({ endpointCatalogs, fetchImpl, env });
    await resolver.resolve(lookup);
    env.OPENAI_COMPATIBLE_API_KEY = "b";
    await resolver.resolve(lookup);
    env.OPENAI_COMPATIBLE_API_KEY = "a";
    await resolver.resolve(lookup);
    await resolver.resolve({ ...lookup, config: mergeConfigs(config, { providers: { "openai-compatible": { base_url: "https://other.example/v1" } } }) });
    await resolver.resolve(lookup);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("does not reuse through injected resolvers unless explicitly opted in", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await new ModelMetadataResolver({ fetchImpl, env: {} }).resolve(lookup);
    await new ModelMetadataResolver({ fetchImpl, env: {} }).resolve(lookup);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["http", "json", "abort"])("retries %s discovery errors without stale values or a longer timeout", async (kind) => {
    const endpointCatalogs = new EndpointMetadataCache();
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (!fail) return response(16000);
      if (kind === "http") return new Response("failed", { status: 503 });
      if (kind === "json") return new Response("not json", { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const resolver = () => new ModelMetadataResolver({ endpointCatalogs, fetchImpl, timeoutMs: 5, env: {} });
    const fallback = await resolver().resolve(lookup);
    expect(fallback.usedFallbackModelMetadata).toBe(true);
    fail = false;
    expect((await resolver().resolve(lookup)).contextWindow).toBe(16000);
  });

  it("keeps the catalog fast path for default endpoints but discovers known models on custom endpoints", async () => {
    const endpointCatalogs = new EndpointMetadataCache();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "deepseek-flash", context_length: 64000 }] })));
    const resolver = () => new ModelMetadataResolver({ endpointCatalogs, fetchImpl, env: {} });
    await resolver().resolve({ provider: "deepseek", model: "deepseek-flash", config: defaultConfig() });
    expect(fetchImpl).not.toHaveBeenCalled();
    const params = { provider: "deepseek", model: "deepseek-flash", config: mergeConfigs(defaultConfig(), { providers: { deepseek: { base_url: "https://custom.example/v1" } } }) };
    const cold = await resolver().resolve(params);
    const warm = await resolver().resolve(params);
    expect(warm).toEqual(cold);
    expect(warm.contextWindow).toBe(64000);
    expect(warm.maxOutputTokens).toBeLessThanOrEqual(32000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("invalidates private metadata after a surfaced SDK failure and preserves the exact error", async () => {
    const cache = endpointMetadataForTransport(globalThis.fetch);
    const scope = cache.observe("openai", "test-account");
    const error = new Error("provider failed");
    const provider = observeEndpointMetadataFailures({
      name: "openai", chat: async () => { throw error; }, chatStream: async () => { throw error; },
    } as unknown as LLMProvider, "openai");
    await expect(provider.chat([])).rejects.toBe(error);
    expect(cache.observe("openai", "test-account")).not.toBe(scope);
    const next = cache.observe("openai", "test-account");
    await expect(provider.chatStream([], () => {})).rejects.toBe(error);
    expect(cache.observe("openai", "test-account")).not.toBe(next);
  });
});
