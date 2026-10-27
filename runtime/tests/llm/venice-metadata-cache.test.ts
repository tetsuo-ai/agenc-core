import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { VeniceProvider } from "../../src/llm/providers/venice/index.js";
import { EndpointMetadataCache, endpointMetadataFailureHandler } from "../../src/llm/endpoint-metadata-cache.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
const listing = (context = 1_000_000) => ({ data: [{ id: "gateway-cache-test", type: "text", model_spec: {
  availableContextTokens: context, maxCompletionTokens: 64000,
  capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true,
    reasoningEffortOptions: ["none", "high"], defaultReasoningEffort: "high" },
} }] });
const response = () => new Response(JSON.stringify(listing()), { headers: { "content-type": "application/json" } });
const config = { providers: { venice: { base_url: "https://api.venice.ai/api/v1" } } };

describe("Venice model list reuse", () => {
  afterEach(() => { clearPublishedModelCatalogs(); vi.unstubAllGlobals(); });
  test("inference errors do not evict a reusable Venice list before a metadata outage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
      .mockImplementation(async () => new Response("offline", { status: 503 }));
    vi.stubGlobal("fetch", fetchImpl);
    const resolver = () => new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: "fixture" } });
    expect((await resolver().discoverVeniceModels(config))?.[0]?.contextWindow).toBe(1_000_000);
    // ProviderClientSession invokes this same hook for an HTTP 429/503.
    endpointMetadataFailureHandler("venice")();
    expect((await resolver().discoverVeniceModels(config))?.[0]?.contextWindow).toBe(1_000_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test("new provider sessions reuse one download through their underlying transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    for (let i = 0; i < 3; i++) {
      const provider = new VeniceProvider({ model: "gateway-cache-test", apiKey: "fixture", fetchImpl });
      await provider.getExecutionProfile();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test("stale lists return immediately and refresh once in the background; failed refresh keeps limits", async () => {
    let now = 0;
    const cache = new EndpointMetadataCache({ now: () => now, reuseMs: 10 });
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(new Response("offline", { status: 503 }));
    const resolver = () => new ModelMetadataResolver({ fetchImpl, endpointCatalogs: cache, env: { VENICE_API_KEY: "fixture" } });
    await resolver().discoverVeniceModels(config);
    now = 11;
    const stale = resolver();
    expect((await stale.discoverVeniceModels(config))?.[0]?.contextWindow).toBe(1_000_000);
    expect((await resolver().discoverVeniceModels(config))?.[0]?.contextWindow).toBe(1_000_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    finish(new Response("offline", { status: 503 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await resolver().discoverVeniceModels(config))?.[0]?.contextWindow).toBe(1_000_000);
    expect(stale.resolveSync({ provider: "venice", model: "gateway-cache-test", config }).contextWindow).toBe(1_000_000);
  });
  test("does not reuse another credential's list", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    for (const key of ["one", "two", "one"]) {
      await new VeniceProvider({ model: "gateway-cache-test", apiKey: key, fetchImpl }).getExecutionProfile();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
