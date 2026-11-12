import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { OpenRouterCatalog, OPENROUTER_CATALOG_TTL_MS, openRouterCatalogFor } from "../../../src/llm/registry/openrouter-live-catalog.js";
import { clearPublishedModelCatalogs, publishedModelCatalogEntries, publishedModelCatalogReadAt } from "../../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../../src/llm/registry/published-model-costs.js";
import { OPENROUTER_MODEL_IDS } from "../../../src/llm/registry/openrouter-model-ids.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { modelCommand } from "../../../src/commands/model.js";
import { ensureLiveModelCatalog } from "../../../src/commands/live-model-catalog.js";
import { assertModelCatalogSelection, openRouterSelectionNotice } from "../../../src/llm/model-catalog-selection.js";
import { resolveProviderModelLayer } from "../../../src/config/provider-model-authority.js";
import { defaultModelForProvider } from "../../../src/config/resolve-model.js";
import { resolveCanonicalStartupSelection, resolveDiscoveredStartupDefault } from "../../../src/bin/startup-selection.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../../src/session/cost.js";
import { resolveProviderModelCapabilities } from "../../../src/llm/capabilities.js";
import { readModelMenuSnapshot } from "../../../src/commands/model-menu-snapshot.js";
import { readProvidersHubModels } from "../../../src/commands/providers-hub-snapshot.js";
import { searchModels } from "../../../src/commands/model-search.js";
import { recordOpenRouterZdrEndpoints, resetOpenRouterZdrEndpointsForTesting } from "../../../src/llm/registry/openrouter-zdr-endpoints.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";

// The bundled snapshot's generation day: none of its rows has reached its
// retirement date yet, so the bundled list is offered whole. Later clocks
// leave the retired rows out (tests/commands/model-menu-snapshot.retirement.test.ts).
const SNAPSHOT_DAY = { now: new Date("2026-10-20T00:00:00Z") };

const homes: string[] = [];
function home() {
  const path = mkdtempSync(join(tmpdir(), "or-catalog-"));
  homes.push(path);
  return path;
}
const row = (id = "test/live-only", tools = true) => ({
  id, name: id, context_length: 345678,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: [...(tools ? ["tools"] : []), "reasoning_effort"],
  top_provider: { max_completion_tokens: 8192 },
  pricing: { prompt: "0.000002", completion: "0.000005", input_cache_read: "0.0000002" },
});
const listing = { data: Array.from({ length: 468 }, (_, index) => row(
  index === 0 ? "x-ai/grok-4.5" : `test/model-${index}`, index < 399,
)) };
const json = (body: unknown) => new Response(JSON.stringify(body));
const fakeFetch = (body: unknown = listing) => vi.fn<typeof fetch>().mockImplementation(async () => json(body));

function context(path: string, config = {}): SlashCommandContext {
  const environment = { AGENC_HOME: path };
  return {
    argsRaw: "", cwd: path, home: path,
    session: {
      state: { unsafePeek: () => ({ sessionConfiguration: {
        provider: { slug: "openrouter" }, collaborationMode: { model: "x-ai/grok-4.5" },
      }, history: [] }) },
      activeTurn: { unsafePeek: () => null },
      setPendingProviderSwitch: vi.fn(),
      services: { providerEnvironment: environment, configStore: {
        homeContext: resolveHomeContext(environment, { platformHome: path }), current: () => config,
      } },
    },
  } as unknown as SlashCommandContext;
}

afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
  resetOpenRouterZdrEndpointsForTesting();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("default catalog and background refreshes stay offline in hermetic tests", async () => {
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch());
  const path = home();
  const ctx = context(path);
  expect((await new OpenRouterCatalog({ home: path }).refresh()).source).toBe("bundled");
  await ensureLiveModelCatalog(ctx, "openrouter", "x-ai/grok-4.5");
  await modelCommand.execute(ctx);
  const config = { model_provider: "openrouter", model: "x-ai/grok-4.5" };
  expect(await resolveDiscoveredStartupDefault({ provider: "openrouter", model: config.model, config },
    "provider_default", { catalogHome: path, env: {} })).toMatchObject({ model: "x-ai/grok-4.5" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a resolver without a transport stays offline even outside test mode", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch());
  const resolver = new ModelMetadataResolver({ env: {}, catalogHome: home() });
  expect(await resolver.discoverOpenRouterModels()).toBe(false);
  expect((await resolver.resolve({ provider: "openrouter", model: "test/unknown", config: {} })).contextWindow)
    .toBeGreaterThan(0);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("production catalogs still use the default transport", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch());
  expect((await new OpenRouterCatalog().refresh()).source).toBe("live");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("offline refresh keeps an expired disk catalog without requesting or rewriting it", async () => {
  const path = home();
  const original = new OpenRouterCatalog({ home: path, now: () => 100, fetchImpl: fakeFetch() });
  await original.refresh();
  const cached = readFileSync(original.cachePath!, "utf8");
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch());
  const catalog = new OpenRouterCatalog({ home: path });
  expect((await catalog.refresh()).source).toBe("cache");
  expect(catalog.read().models).toHaveLength(468);
  await ensureLiveModelCatalog(context(path), "openrouter", "x-ai/grok-4.5");
  expect(readModelMenuSnapshot(context(path)).providerCounts.openrouter).toBe(468);
  expect(readFileSync(original.cachePath!, "utf8")).toBe(cached);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a mocked 468-model catalog replaces all 300 menu rows and remains searchable", async () => {
  const path = home();
  const ctx = context(path);
  let finish!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
  const catalog = openRouterCatalogFor({ home: path, fetchImpl });
  expect(OPENROUTER_MODEL_IDS).toHaveLength(300);
  expect(readModelMenuSnapshot(ctx, SNAPSHOT_DAY).providerCounts.openrouter).toBe(300);
  const pending = catalog.refresh();
  expect(readProvidersHubModels(ctx, "openrouter", SNAPSHOT_DAY)).toHaveLength(300);
  finish(json(listing));
  await pending;
  const rows = readProvidersHubModels(ctx, "openrouter");
  expect(rows).toHaveLength(468);
  expect(readModelMenuSnapshot(ctx).providerCounts.openrouter).toBe(468);
  expect(rows.filter(model => model.tags?.includes("no tools"))).toHaveLength(69);
  expect(searchModels(rows, "model-467", model => ({ ids: [model.model] }))).toHaveLength(1);
  expect(rows.find(model => model.model === "test/model-467")?.catalogDetail)
    .toBe("345,678 context · $2/M input · $5/M output");
  expect(defaultModelForProvider("openrouter")).toBe("x-ai/grok-4.5");
});

test("cache survives another resolver, refreshes after one hour and coalesces requests", async () => {
  const path = home();
  let now = 1_000_000;
  const fetchImpl = fakeFetch();
  const first = new OpenRouterCatalog({ home: path, now: () => now, fetchImpl, apiKey: "fixture-only-key" });
  await Promise.all([first.refresh(), first.refresh()]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer fixture-only-key");
  expect(readFileSync(first.cachePath!, "utf8")).not.toContain("fixture-only-key");
  now += OPENROUTER_CATALOG_TTL_MS - 1;
  const second = new OpenRouterCatalog({ home: path, now: () => now, fetchImpl, apiKey: "fixture-only-key" });
  expect(second.read().source).toBe("cache");
  await second.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now += 1;
  await second.refresh();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(new OpenRouterCatalog({ home: path, apiKey: "different-fixture" }).read().source).toBe("bundled");
});

test("public catalog works without a key and metadata sends a saved fixture key when available", async () => {
  const fetchImpl = fakeFetch();
  await new OpenRouterCatalog({ fetchImpl }).refresh();
  expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  await new ModelMetadataResolver({ fetchImpl, env: {}, readSavedApiKey: () => "saved-fixture" }).discoverOpenRouterModels();
  expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer saved-fixture");
});

test.each(["network", "http", "malformed", "empty"])("%s failure uses the bundled list and permits a later retry", async failure => {
  const fetchImpl = fakeFetch();
  let now = 100;
  const catalog = new OpenRouterCatalog({ fetchImpl, now: () => now });
  await catalog.refresh();
  now += OPENROUTER_CATALOG_TTL_MS;
  if (failure === "network") fetchImpl.mockRejectedValueOnce(new Error("offline"));
  if (failure === "http") fetchImpl.mockResolvedValueOnce(new Response("", { status: 503 }));
  if (failure === "malformed") fetchImpl.mockResolvedValueOnce(json({ data: [{ name: "missing id" }] }));
  if (failure === "empty") fetchImpl.mockResolvedValueOnce(json({ data: [] }));
  expect((await catalog.refresh()).source).toBe("bundled");
  expect(catalog.read().models).toHaveLength(300);
  expect(() => assertModelCatalogSelection({}, "openrouter", "future/new-model", {})).not.toThrow();
  expect(openRouterSelectionNotice("future/new-model")).toContain("unverified");
  expect((await catalog.refresh()).models).toHaveLength(468);
});

/** The models OpenRouter's published list has in this process, if one is recorded. */
const published = () => publishedModelCatalogEntries("openrouter")?.map(entry => entry.model);

test("a catalog built before the cache existed takes the list another catalog cached", async () => {
  const path = home();
  // Two objects on one home and key, as the daemon and the TUI each have one.
  const early = new OpenRouterCatalog({ home: path, apiKey: "fixture-only-key" });
  expect(early.read().source).toBe("bundled");
  const other = new OpenRouterCatalog({ home: path, apiKey: "fixture-only-key", fetchImpl: fakeFetch({ data: [row()] }) });
  expect((await other.refresh()).source).toBe("live");
  // A second process has none of the first one's memory.
  clearPublishedModelCatalogs();
  // Reading alone does not look at the file again.
  expect(early.read().source).toBe("bundled");
  expect(published()).toBeUndefined();

  const taken = early.refreshFromCache();
  expect(taken).toMatchObject({ source: "cache", models: [{ model: "test/live-only" }] });
  expect(published()).toEqual(["test/live-only"]);
  expect(early.read()).toBe(taken);
  expect(early.refreshFromCache()).toBe(taken);
});

test("a list is recorded with the time OpenRouter gave it, not the time its cache was opened", async () => {
  const path = home();
  const downloaded = Date.parse("2026-11-05T12:00:00Z");
  const first = new OpenRouterCatalog({ home: path, fetchImpl: fakeFetch({ data: [row()] }), now: () => downloaded });
  expect((await first.refresh()).source).toBe("live");
  expect(publishedModelCatalogReadAt("openrouter")).toBe(downloaded);

  // Another process opens that cache a week later: the list is a week old.
  clearPublishedModelCatalogs();
  const weekLater = downloaded + 7 * 24 * 60 * 60_000;
  const later = new OpenRouterCatalog({ home: path, now: () => weekLater });
  expect(later.read().source).toBe("cache");
  expect(publishedModelCatalogReadAt("openrouter")).toBe(downloaded);
  // So is a list taken from the cache by a catalog that was built before it.
  clearPublishedModelCatalogs();
  const other = home();
  const early = new OpenRouterCatalog({ home: other, now: () => weekLater });
  const writer = new OpenRouterCatalog({ home: other, fetchImpl: fakeFetch({ data: [row()] }), now: () => downloaded });
  expect((await writer.refresh()).source).toBe("live");
  clearPublishedModelCatalogs();
  expect(early.refreshFromCache().source).toBe("cache");
  expect(publishedModelCatalogReadAt("openrouter")).toBe(downloaded);

  // The bundled list is not an answer from OpenRouter: no time goes with it.
  expect(new OpenRouterCatalog().read().source).toBe("bundled");
  expect(publishedModelCatalogReadAt("openrouter")).toBeUndefined();
});

test("a cached list replaces the one held only when it is newer", async () => {
  const path = home();
  let now = 1_000;
  await new OpenRouterCatalog({ home: path, now: () => now, fetchImpl: fakeFetch({ data: [row("test/first")] }) }).refresh();
  const fetchImpl = fakeFetch({ data: [row("test/third")] });
  const holder = new OpenRouterCatalog({ home: path, now: () => now, fetchImpl });
  const held = holder.read();
  expect(held.models.map(entry => entry.model)).toEqual(["test/first"]);
  // The file it already read is not taken again.
  expect(holder.refreshFromCache()).toBe(held);

  // Another catalog downloads the list again once the first one is an hour old.
  now += OPENROUTER_CATALOG_TTL_MS;
  const other = new OpenRouterCatalog({ home: path, now: () => now, fetchImpl: fakeFetch({ data: [row("test/second")] }) });
  expect((await other.refresh()).source).toBe("live");
  clearPublishedModelCatalogs();
  expect(holder.refreshFromCache().models.map(entry => entry.model)).toEqual(["test/second"]);
  expect(published()).toEqual(["test/second"]);
  // It is as fresh as the download that wrote it: no request of its own for an hour.
  now += OPENROUTER_CATALOG_TTL_MS - 1;
  await holder.refresh();
  expect(fetchImpl).not.toHaveBeenCalled();
  now += 1;
  expect((await holder.refresh()).models.map(entry => entry.model)).toEqual(["test/third"]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("a list this catalog gave up after a failed refresh is not taken back from the cache", async () => {
  const path = home();
  let now = 1_000;
  const fetchImpl = fakeFetch({ data: [row()] });
  const catalog = new OpenRouterCatalog({ home: path, now: () => now, fetchImpl });
  await catalog.refresh();
  now += OPENROUTER_CATALOG_TTL_MS;
  fetchImpl.mockRejectedValueOnce(new Error("offline"));
  expect((await catalog.refresh()).source).toBe("bundled");
  // The file still holds the list of the first download: no newer than the one given up.
  expect(catalog.refreshFromCache().source).toBe("bundled");
  expect(published()).toBeUndefined();
});

test.each([
  ["missing", undefined],
  ["corrupt", "{bad json"],
  ["of another version", JSON.stringify({ version: 2, at: 500, body: { data: [row()] } })],
  ["dated in the future", JSON.stringify({ version: 1, at: 5_000, body: { data: [row()] } })],
  ["dated with text", JSON.stringify({ version: 1, at: "500", body: { data: [row()] } })],
  ["dated with no finite number", `{"version":1,"at":-1e999,"body":${JSON.stringify({ data: [row()] })}}`],
  ["without a usable list", JSON.stringify({ version: 1, at: 500, body: { data: [] } })],
])("a cache file that is %s changes nothing, and nothing recorded in this process is cleared", async (_what, content) => {
  const path = home();
  const catalog = new OpenRouterCatalog({ home: path, now: () => 1_000 });
  // Another catalog object of this process has recorded a list (another key's, here).
  await new OpenRouterCatalog({ home: path, apiKey: "fixture-only-key", fetchImpl: fakeFetch({ data: [row("test/recorded")] }) }).refresh();
  expect(published()).toEqual(["test/recorded"]);
  if (content !== undefined) writeFileSync(catalog.cachePath!, content);

  expect(catalog.refreshFromCache()).toMatchObject({ source: "bundled" });
  expect(published()).toEqual(["test/recorded"]);
  // read() is the call that makes this catalog's own rows the published ones.
  expect(catalog.read().source).toBe("bundled");
  expect(published()).toBeUndefined();
});

test("a catalog without a home has no cache to read", () => {
  expect(new OpenRouterCatalog().refreshFromCache().source).toBe("bundled");
  expect(published()).toBeUndefined();
});

test("a corrupt disk cache cannot break the menu", async () => {
  const path = home();
  const catalog = new OpenRouterCatalog({ home: path, fetchImpl: fakeFetch() });
  await catalog.refresh();
  writeFileSync(catalog.cachePath!, "{bad json");
  const snapshot = readModelMenuSnapshot(context(path), SNAPSHOT_DAY);
  expect(snapshot.providerCounts.openrouter).toBe(300);
  expect(snapshot.catalogNote).toContain("showing bundled models");
});

test("all advertised models remain listed with tools, vision, thinking, free and ZDR markings", async () => {
  const path = home();
  const data = [row(), { ...row("test/zero", false), pricing: { prompt: "0", completion: "0" } },
    row("test/suffix:free", false), { id: "~test/media:batch", architecture: { output_modalities: ["image"] }, expiration_date: "2000-01-01" }];
  await openRouterCatalogFor({ home: path, fetchImpl: fakeFetch({ data }) }).refresh();
  recordOpenRouterZdrEndpoints({ data: [{ model_id: "test/live-only" }] });
  const rows = readProvidersHubModels(context(path), "openrouter");
  expect(rows.find(model => model.model === "test/zero")).toMatchObject({ tags: "vision · thinking · no tools · free", zdrUnavailable: true });
  expect(rows.find(model => model.model === "test/live-only")).toMatchObject({ tags: "vision · thinking · tools" });
  expect(modelCapabilityTags("openrouter", "test/suffix:free")).toContain("free");
  expect(rows.some(model => model.model === "~test/media:batch")).toBe(true);
  expect(resolveProviderModelCapabilities({ provider: "openrouter", model: "test/zero" }).supportsToolUse).toBe(false);
  expect(readProvidersHubModels(context(path, { providers: { openrouter: { zero_data_retention: false } } }), "openrouter")
    .every(model => model.zdrUnavailable === undefined)).toBe(true);
  expect(defaultModelForProvider("openrouter")).toBe("test/live-only");
});

test("CLI and model selection accept live-only ids and explain models without tools", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const path = home();
  await openRouterCatalogFor({ home: path, fetchImpl: fakeFetch({ data: [row("test/live-only", false)] }) }).refresh();
  const config = resolveProviderModelLayer({}, { model: "openrouter:test/live-only" });
  expect(resolveCanonicalStartupSelection({ config, env: {}, explicitModel: "openrouter:test/live-only" }).model).toBe("test/live-only");
  expect(warning).toHaveBeenCalledWith("Agent tools will not work with this model.");
  expect(() => assertModelCatalogSelection({}, "openrouter", "test/not-listed", {})).toThrow("does not list");
  const ctx = context(path, { providers: { openrouter: { zero_data_retention: false } } });
  const result = await modelCommand.execute({ ...ctx, argsRaw: "openrouter:test/live-only" });
  expect(result).toMatchObject({ kind: "text", text: expect.stringContaining("Agent tools will not work") });
});

test("offline CLI accepts an unknown well-formed id with a warning", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const config = resolveProviderModelLayer({}, { model: "openrouter:future/new-model:free" });
  expect(resolveCanonicalStartupSelection({ config, env: {}, explicitModel: "openrouter:future/new-model:free" }).model)
    .toBe("future/new-model:free");
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("accepting unverified model"));
});

test("cached live-only metadata is available synchronously in a new resolver", async () => {
  const path = home();
  await new OpenRouterCatalog({ home: path, fetchImpl: fakeFetch({ data: [row()] }) }).refresh();
  const fetchImpl = fakeFetch();
  const resolver = new ModelMetadataResolver({ catalogHome: path, env: {}, fetchImpl });
  expect(resolver.resolveSync({ provider: "openrouter", model: "test/live-only", config: {} }).contextWindow).toBe(345678);
  expect(fetchImpl).not.toHaveBeenCalled();
  const config = resolveProviderModelLayer({}, { model: "openrouter:test/live-only" });
  clearPublishedModelCatalogs();
  const metadata = { catalogHome: path };
  expect(resolveCanonicalStartupSelection({ config, env: {}, metadata, explicitModel: "openrouter:test/live-only" }).model)
    .toBe("test/live-only");
  expect(() => resolveCanonicalStartupSelection({ config: { ...config, model: "test/missing" }, env: {}, metadata, explicitModel: "openrouter:test/missing" }))
    .toThrow("does not list");
});

test("startup uses the captured home and saved credential partition for cached validation", async () => {
  const path = home();
  const otherHome = home();
  await new OpenRouterCatalog({ home: path, apiKey: "saved-fixture", fetchImpl: fakeFetch({ data: [row()] }) }).refresh();
  await new OpenRouterCatalog({ home: otherHome, fetchImpl: fakeFetch({ data: [row("other/model")] }) }).refresh();
  clearPublishedModelCatalogs();
  const readSavedApiKey = vi.fn(() => "saved-fixture");
  const metadata = { catalogHome: path, readSavedApiKey };
  const env = { AGENC_HOME: otherHome };
  const config = { model_provider: "openrouter", model: "test/live-only" };
  expect(resolveCanonicalStartupSelection({ config, env, metadata, explicitModel: config.model }).model).toBe(config.model);
  expect(readSavedApiKey).toHaveBeenCalledWith("openrouter");
  expect(() => resolveCanonicalStartupSelection({ config: { ...config, model: "other/model" }, env, metadata, explicitModel: "other/model" }))
    .toThrow("does not list");
});

test("startup reads a cached replacement default without waiting for refresh", async () => {
  const path = home();
  const original = new OpenRouterCatalog({ home: path, now: () => 100, fetchImpl: fakeFetch({ data: [row()] }) });
  await original.refresh();
  let finish!: (value: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
  const config = { model_provider: "openrouter", model: "x-ai/grok-4.5" };
  const selected = await resolveDiscoveredStartupDefault({ provider: "openrouter", model: config.model, config },
    "provider_default", { catalogHome: path, env: {}, fetchImpl });
  expect(selected.model).toBe("test/live-only");
  finish(json({ data: [row()] }));
  // Drain the background write before removing this test's temporary home.
  await vi.waitFor(() => expect(JSON.parse(readFileSync(original.cachePath!, "utf8")).at).toBeGreaterThan(100));
});

test("catalog prices preserve context tiers and UTC price schedules", async () => {
  let now = Date.parse("2026-10-23T01:00:00Z");
  const catalog = new OpenRouterCatalog({ now: () => now, fetchImpl: fakeFetch({ data: [{ ...row(), pricing: {
    prompt: "0.000002", completion: "0.000005", overrides: [
      { utc_days: ["friday"], utc_start: 100, utc_end: 200, prompt: "0.000001", completion: "0.000003" },
      { min_prompt_tokens: 10000, prompt: "0.000004", completion: "0.00001" },
      { min_prompt_tokens: 20000, prompt: "0.000008", completion: "0.00002" },
    ],
  } }] }) });
  await catalog.refresh();
  const price = () => resolveModelCostEntry({ provider: "openrouter", model: "test/live-only" }, DEFAULT_MODEL_COSTS)!.entry;
  expect(price().inputUsdPer1K).toBe(0.001);
  expect(price().longContext).toMatchObject({ aboveInputTokens: 9999, rates: {
    inputUsdPer1K: 0.004, longContext: { aboveInputTokens: 19999, rates: { inputUsdPer1K: 0.008 } },
  } });
  now = Date.parse("2026-10-23T02:00:00Z");
  catalog.read();
  expect(price().inputUsdPer1K).toBe(0.002);
});

test.each(["bad id", "vendor/", "vendor//model", "vendor/model\nheader", "../model"])("offline selection rejects malformed id %j", model => {
  expect(() => assertModelCatalogSelection({}, "openrouter", model, {})).toThrow("Invalid OpenRouter");
});

test("a live-only model supplies context, capability and prices to runtime accounting", async () => {
  const resolver = new ModelMetadataResolver({ fetchImpl: fakeFetch({ data: [row()] }), env: {} });
  expect(await resolver.resolve({ provider: "openrouter", model: "test/live-only", config: {} }))
    .toMatchObject({ contextWindow: 345678, maxOutputTokensUpperLimit: 8192 });
  expect(resolveModelCostEntry({ provider: "openrouter", model: "test/live-only" }, DEFAULT_MODEL_COSTS)?.entry)
    .toMatchObject({ inputUsdPer1K: 0.002, outputUsdPer1K: 0.005, cachedInputUsdPer1K: expect.closeTo(0.0002, 10) });
  const usage = { provider: "openrouter", model: "test/live-only", inputTokens: 1000, outputTokens: 1000,
    cachedInputTokens: 500, cacheCreationInputTokens: 0, reasoningOutputTokens: 0,
    webSearchRequests: 0, totalTokens: 2000, turns: 1, singleCall: true };
  expect(computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS)).toMatchObject({ costUsd: expect.closeTo(0.0061, 10), known: false, costEstimated: true });
  expect(computeUsdCostWithResolution({ ...usage, providerCostUsd: 0.012 }, DEFAULT_MODEL_COSTS))
    .toMatchObject({ costUsd: 0.012, known: true });
});
