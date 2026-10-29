import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { resolveGeminiThinkingModel } from "../../src/llm/registry/gemini-thinking-models.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../src/llm/registry/provider-info.js";
import { resolveProviderModelCapabilities } from "../../src/llm/capabilities.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import type { AgenCConfig } from "../../src/utils/config.js";
import { defaultConfig } from "../../src/config/schema.js";
import { loadCanonicalConfig, loadCanonicalDaemonConfig } from "../../src/config/repository.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import { createTokenAccountingRequest } from "../../src/llm/token-accounting.js";
import type { LLMChatOptions } from "../../src/llm/types.js";

const MODEL_LEVELS = [
  // Thinking guide (generate-content) 2026-10-28: low, medium (default),
  // high; a live MINIMAL request answers HTTP 400.
  ["gemini-4-argon", ["low", "medium", "high"]],
  ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
  ["gemini-3.8-flash", ["low", "medium", "high"]],
  ["gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
  ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]],
  ["gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"]],
  ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
  ["gemini-3-pro-preview", ["low", "high"]],
  ["gemini-2.5-pro", []],
  ["gemini-2.5-flash", []],
  ["gemini-2.5-flash-lite", []],
] as const;
// Deprecated 2026-10-08: Google serves these ids with gemini-3.8-flash and
// gemini-3.6-flash. They keep the levels of the model that answers.
const ROUTED_MODEL_LEVELS = [
  ["gemini-3.7-flash", ["low", "medium", "high"], "gemini-3.8-flash"],
  ["gemini-3.5-flash", ["minimal", "low", "medium", "high"], "gemini-3.6-flash"],
] as const;
const WIRE_MODEL_LEVELS = [
  ...MODEL_LEVELS,
  ...ROUTED_MODEL_LEVELS.map(([model, levels]) => [model, levels] as const),
] as const;
const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Gemini reasoning metadata", () => {
  test.each(MODEL_LEVELS)("shares exact %s levels without imposing a session default", async (model, levels) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })?.supportedReasoningLevels).toEqual(levels);
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsReasoningEffort).toBe(levels.length > 0);
    const manager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "gemini", model },
    });
    const info = await manager.getModelInfo(model);
    expect(info.supportedReasoningLevels).toEqual(levels);
    expect(info.defaultReasoningLevel).toBeUndefined();
    expect(info.visibility).toBe("list");
    expect(info.showInPicker).toBe(true);
    expect(info.defaultReasoningSummary).toBe("auto");
    expect((await manager.listModels()).some((entry) => entry.slug === model)).toBe(true);
  });

  // GET /v1beta/models (2026-09-26): inputTokenLimit 1,048,576 and
  // outputTokenLimit 65,536 on every Gemini chat model listed.
  test.each(WIRE_MODEL_LEVELS)("plans %s against the API's 1,048,576 window and 65,536 output", async (model) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toMatchObject({
      contextWindow: 1_048_576,
      maxContextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      maxOutputTokensUpperLimit: 65_536,
    });
    expect(new ModelMetadataResolver({ env: {} }).resolveSync({
      provider: "gemini",
      model,
      config: {} as unknown as AgenCConfig,
    })).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      maxOutputTokensUpperLimit: 65_536,
      source: "built_in_heuristic",
      usedFallbackModelMetadata: false,
    });
    const manager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "gemini", model },
    });
    expect((await manager.getModelInfo(model)).contextWindow).toBe(1_048_576);
  });

  test.each(["gemini-3.1-pro-preview-unverified", "gemini-3.5-flash-unverified", "gemini-4-argon-unverified"])("does not grant levels to %s", (model) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toBeUndefined();
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsReasoningEffort).toBe(false);
  });

  test.each(ROUTED_MODEL_LEVELS)("keeps deprecated %s resolvable but out of the picker", async (model, levels, servedBy) => {
    expect(resolveGeminiThinkingModel(model)?.routedTo).toBe(servedBy);
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toMatchObject({
      supportedReasoningLevels: levels,
      visibility: "hide",
    });
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsReasoningEffort).toBe(true);
    const manager = new StaticModelsManager({
      config: { ...defaultConfig(), model_provider: "gemini", model },
    });
    const info = await manager.getModelInfo(model);
    expect(info.supportedReasoningLevels).toEqual(levels);
    expect(info.defaultReasoningLevel).toBeUndefined();
    expect(info.visibility).toBe("hide");
    expect(info.showInPicker).toBe(false);
    expect(info.defaultReasoningSummary).toBe("auto");
    // Saved settings that name the id still resolve it.
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.gemini).toContain(model);
    // The model that now answers is offered in its place.
    expect((await manager.getModelInfo(servedBy)).showInPicker).toBe(true);
  });

  // Defaults from the generate-content thinking guide (2026-10-28). The
  // native default is what /effort default sends, so a wrong row makes a
  // Flash-Lite session think at medium instead of its documented minimal.
  test.each([
    ["gemini-4-argon", "medium"],
    ["gemini-3.8-flash", "medium"],
    ["gemini-3.6-flash", "medium"],
    ["gemini-3.5-flash-lite", "minimal"],
    ["gemini-3.1-flash-lite", "minimal"],
    ["gemini-3.1-pro-preview", "high"],
    ["gemini-3-flash-preview", "high"],
  ] as const)("records the documented default thinking level of %s", (model, level) => {
    expect(resolveGeminiThinkingModel(model)?.defaultLevel).toBe(level);
  });

  test("leads the picker with Gemini 4 Argon and keeps 3.8 Flash as the provider default", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.gemini[0]).toBe("gemini-4-argon");
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.gemini).toBe("gemini-3.8-flash");
  });
});

describe.each(["chat", "stream", "count"] as const)("Gemini %s reasoning wire contract", (operation) => {
  async function request(model: string, effort: LLMChatOptions["reasoningEffort"]) {
    const payload = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => operation === "stream"
      ? new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json(operation === "count" ? { totalTokens: 1 } : payload));
    const provider = new GeminiProvider({
      model: "gemini-2.5-flash",
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" },
      fetchImpl,
    });
    const messages = [{ role: "user" as const, content: "fixture" }];
    const options = { model, reasoningEffort: effort };
    const result = operation === "chat" ? provider.chat(messages, options)
      : operation === "stream" ? provider.chatStream(messages, () => {}, options)
        : provider.tokenCountCapability.countTokens(createTokenAccountingRequest({ provider: "gemini", model, messages, options, reservedOutputTokens: 0 }), new AbortController().signal);
    return { result, fetchImpl };
  }

  for (const [model, levels] of WIRE_MODEL_LEVELS) {
    for (const effort of levels) test(`${model} sends exact ${effort}`, async () => {
      const { result, fetchImpl } = await request(model, effort);
      await result;
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      const generationConfig = operation === "count" ? body.generateContentRequest.generationConfig : body.generationConfig;
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: effort });
    });

    test.each([undefined, "none"] as const)(`${model} omits thinking for %s`, async (effort) => {
      const { result, fetchImpl } = await request(model, effort);
      await result;
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      const generationConfig = operation === "count" ? body.generateContentRequest.generationConfig : body.generationConfig;
      expect(generationConfig).not.toHaveProperty("thinkingConfig");
    });
  }

  test.each([
    ["gemini-4-argon", "minimal"],
    ["gemini-4-argon", "xhigh"],
    ["gemini-4-argon", "max"],
    ["gemini-3.1-pro-preview", "minimal"],
    ["gemini-3.1-pro-preview", "xhigh"],
    ["gemini-3.1-pro-preview", "max"],
    ["gemini-3-pro-preview", "medium"],
    ["gemini-2.5-flash", "high"],
    ["gemini-3.1-pro-preview-unverified", "low"],
  ] as const)("rejects %s %s before transport", async (model, effort) => {
    const { result, fetchImpl } = await request(model, effort);
    await expect(result).rejects.toThrow(/reasoning effort/iu);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Gemini per-call output ceilings", () => {
  function provider(fetchImpl: typeof fetch) {
    return new GeminiProvider({
      model: "gemini-4-argon",
      endpointPlan: createGeminiEndpointPlan(),
      credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" },
      fetchImpl,
    });
  }
  const payload = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
  const messages = [{ role: "user" as const, content: "fixture" }];
  const sentMaxOutput = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
    JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).generationConfig.maxOutputTokens;

  // ai.google.dev/gemini-api/docs/generate-content/long-decode: one stream
  // returns up to 65,536 tokens; a non-streaming REST call over 32,768
  // without a continuation token is refused.
  test("caps a non-streaming Gemini 4 Argon call at 32,768 output tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    await provider(fetchImpl).chat(messages, { maxOutputTokens: 65_536 });
    expect(sentMaxOutput(fetchImpl)).toBe(32_768);
  });

  test("keeps a smaller non-streaming request as asked", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    await provider(fetchImpl).chat(messages, { maxOutputTokens: 8_000 });
    expect(sentMaxOutput(fetchImpl)).toBe(8_000);
  });

  test("lets a Gemini 4 Argon stream use 65,536 output tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await provider(fetchImpl).chatStream(messages, () => {}, { maxOutputTokens: 65_536 });
    expect(sentMaxOutput(fetchImpl)).toBe(65_536);
  });

  test("leaves other models' non-streaming calls at 65,536", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    await provider(fetchImpl).chat(messages, { model: "gemini-3.8-flash", maxOutputTokens: 65_536 });
    expect(sentMaxOutput(fetchImpl)).toBe(65_536);
  });
});

describe("Gemini canonical effort configuration", () => {
  test.each([loadCanonicalConfig, loadCanonicalDaemonConfig])("preserves provider defaults and explicit settings through %s", async (load) => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-gemini-effort-"));
    DIRECTORIES.push(directory);
    const options = { home: directory, env: {}, managedConfigPath: join(directory, "managed.toml") };
    for (const effort of [undefined, "none", "low", "medium", "high"] as const) {
      writeFileSync(join(directory, "config.toml"), `config_version = 2\nmodel_provider = "gemini"\nmodel = "gemini-3.1-pro-preview"\n${effort === undefined ? "" : `reasoning_effort = "${effort}"\n`}`, { mode: 0o600 });
      const loaded = await load(options);
      expect(loaded.config.reasoning_effort).toBe(effort);
      expect(loaded.provenance.reasoning_effort?.scope).toBe(effort === undefined ? undefined : "user");
      const configuration = sessionConfigurationFromAgenCConfig({ config: loaded.config, workspaceRoot: directory, model: "gemini-3.1-pro-preview" });
      expect(configuration.collaborationMode.reasoningEffort).toBe(effort);
    }
    writeFileSync(join(directory, "config.toml"), 'config_version = 2\nmodel_provider = "grok"\n', { mode: 0o600 });
    expect((await load(options)).config.reasoning_effort).toBe("medium");
  });
});
