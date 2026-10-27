import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import {
  resolveImageInputSupport,
  resolveProviderModelCapabilities,
} from "../../../src/llm/capabilities.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { clearPublishedModelCatalogs } from "../../../src/llm/registry/published-model-catalog.js";
import { reasoningEffortAcceptedByModel } from "../../../src/session/reasoning-effort-for-model.js";
import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { OPENROUTER_MODEL_IDS } from "../../../src/llm/registry/openrouter-model-ids.js";
import { openRouterRowFromListing } from "../../../src/llm/registry/openrouter-models.js";
import {
  OLLAMA_CLOUD_MODELS,
  ollamaThinkingEfforts,
  parseOllamaCloudShow,
  parseOllamaCloudTags,
} from "../../../src/llm/registry/ollama-cloud-models.js";
import { analyzeSessionHistoryRequirements, validateHistoryCompatibility } from "../../../src/llm/shape-request.js";
import { resolveProviderCapabilityEntry } from "../../../src/llm/capabilities.js";

afterEach(() => {
  clearPublishedModelCatalogs();
  vi.restoreAllMocks();
});

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

// Shapes from Venice's live GET /models (2026-10-20): a vision, reasoning,
// effort-capable tool model that the bundled 3-model snapshot does not list.
const VENICE_LIST = {
  object: "list",
  data: [{
    id: "google-gemma-4-31b-it", type: "text", object: "model", owned_by: "venice.ai",
    model_spec: {
      name: "Google Gemma 4 31B Instruct", offline: false, privacy: "private", traits: [],
      availableContextTokens: 256000, maxCompletionTokens: 8192,
      pricing: { input: { usd: 0.12, diem: 0.12 }, output: { usd: 0.36, diem: 0.36 } },
      capabilities: {
        supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true,
        supportsReasoningEffort: true, reasoningEffortOptions: ["none", "low", "medium", "high"],
        defaultReasoningEffort: "low", supportsResponseSchema: true,
      },
    },
  }, {
    id: "qwen-3-8-flash", type: "text", object: "model", owned_by: "venice.ai",
    model_spec: {
      name: "Qwen 3.8 Flash", offline: false, privacy: "anonymized", traits: [],
      deprecation: { autoRemap: false, date: "2026-10-30T00:00:00.000Z", removesAt: "2026-10-30T00:00:00.000Z" },
      availableContextTokens: 1000000, maxCompletionTokens: 131072,
      pricing: { input: { usd: 0.14 }, output: { usd: 0.49 } },
      capabilities: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true, supportsReasoningEffort: false },
    },
  }],
};

describe("Venice: the live list owns capability flags and effort levels", () => {
  const model = "google-gemma-4-31b-it";
  test("before discovery the bundled snapshot does not know the model", () => {
    expect(resolveImageInputSupport({ provider: "venice", model })).toBe("unsupported");
    expect(resolveReasoningEffort({ provider: "venice", model }).levels).toEqual([]);
  });

  test("after discovery images, thinking and effort follow Venice's row", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(VENICE_LIST));
    const models = await new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: "fixture" } })
      .discoverVeniceModels({});
    expect(models?.map(entry => entry.model)).toEqual([model, "qwen-3-8-flash"]);
    expect(resolveImageInputSupport({ provider: "venice", model })).toBe("supported");
    const caps = resolveProviderModelCapabilities({ provider: "venice", model });
    expect(caps).toMatchObject({
      supportsImageInput: true, acceptsImageHistory: true, supportsExtendedThinking: true,
      acceptsThinkingHistory: true, acceptsReasoningEffort: true, supportsStructuredOutput: true,
    });
    expect(resolveReasoningEffort({ provider: "venice", model })).toMatchObject({
      registered: true, levels: ["none", "low", "medium", "high"], defaultLevel: "low",
    });
    expect(reasoningEffortAcceptedByModel({ provider: "venice", model, reasoningEffort: "low" })).toBe(true);
    expect(reasoningEffortAcceptedByModel({ provider: "venice", model, reasoningEffort: "xhigh" })).toBe(false);
    // Thinking without a choosable level: the model reasons, effort is not offered.
    expect(resolveProviderModelCapabilities({ provider: "venice", model: "qwen-3-8-flash" }))
      .toMatchObject({ supportsExtendedThinking: true, acceptsReasoningEffort: false, supportsImageInput: true });
    expect(modelCapabilityTags("venice", model)).toBe("vision · thinking");
    // Venice's announced removal date is shown as a deprecation tag.
    expect(modelCapabilityTags("venice", "qwen-3-8-flash")).toBe("vision · thinking · retires 2026-10-30");
  });
});

// Ollama Cloud GET /api/tags and POST /api/show shapes (2026-10-20).
const OLLAMA_TAGS = {
  models: [
    { name: "future-coder:9b", model: "future-coder:9b", capabilities: ["completion", "tools", "thinking", "vision"] },
    { name: "clef:27b", model: "clef:27b", capabilities: ["decision", "vision"] },
    { name: "minimax-m3.1-flash", model: "minimax-m3.1-flash", capabilities: ["completion", "tools", "thinking", "vision"] },
  ],
};
const OLLAMA_SHOW = {
  capabilities: ["completion", "tools", "thinking", "vision"],
  model_info: { "future.context_length": 524288 },
  thinking: { values: [false, "low", "high"], default: "high" },
};

describe("Ollama Cloud: live tags and details, no borrowed rows", () => {
  test("a model the snapshot lacks never borrows a neighbour's row by prefix", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model: "minimax-m3.2-preview" })).toBeUndefined();
    expect(resolveImageInputSupport({ provider: "ollama-cloud", model: "minimax-m3.2-preview" })).toBe("unsupported");
  });

  test("the bundled snapshot carries the 2026-10-20 list and levels", () => {
    const row = (model: string) => OLLAMA_CLOUD_MODELS.find(entry => entry.model === model);
    for (const model of ["beam", "deepseek-v4.1-flash:1017", "minimax-m3.1-flash", "mistral-large-4", "muse-spark-open"]) {
      expect(row(model)?.tools, model).toBe(true);
    }
    expect(row("clef:27b")).toBeUndefined();
    expect(row("deepseek-v4.1-flash")?.efforts).toEqual(["none", "low", "high", "max"]);
    expect(row("kimi-k3")?.efforts).toEqual(["none", "low", "high", "max"]);
    expect(row("glm-5.2")?.efforts).toEqual(["none", "high", "max"]);
    expect(row("minimax-m3.1-flash")).toMatchObject({ vision: true, thinking: true, efforts: [] });
    expect(resolveProviderModelCapabilities({ provider: "ollama-cloud", model: "minimax-m3.1-flash" }))
      .toMatchObject({ supportsImageInput: true, supportsExtendedThinking: true, acceptsReasoningEffort: false });
  });

  test("thinking values map to effort names", () => {
    expect(ollamaThinkingEfforts([false, "low", "high", "max"])).toEqual(["none", "low", "high", "max"]);
    expect(ollamaThinkingEfforts([false, true])).toEqual(["none", "high"]);
    expect(ollamaThinkingEfforts([true])).toEqual([]);
    expect(ollamaThinkingEfforts(undefined)).toBeUndefined();
    expect(parseOllamaCloudTags(OLLAMA_TAGS).map(row => row.model)).toEqual(["future-coder:9b", "minimax-m3.1-flash"]);
    // The default is the level the model thinks at when no effort is sent.
    expect(parseOllamaCloudShow("future-coder:9b", OLLAMA_SHOW)).toMatchObject({
      contextWindow: 524288, vision: true, thinking: true, efforts: ["none", "low", "high"], defaultEffort: "high",
    });
    const onOff = { ...OLLAMA_SHOW, thinking: { values: [false, true], default: true } };
    expect(parseOllamaCloudShow("future-coder:9b", onOff)).toMatchObject({ efforts: ["none", "high"], defaultEffort: "high" });
    const off = { ...OLLAMA_SHOW, thinking: { values: [false, true], default: false } };
    expect(parseOllamaCloudShow("future-coder:9b", off)?.defaultEffort).toBe("none");
    // No published default: none is invented.
    const silent = { ...OLLAMA_SHOW, thinking: { values: [false, "low", "high"] } };
    expect(parseOllamaCloudShow("future-coder:9b", silent)?.defaultEffort).toBeUndefined();
  });

  test("discovery records the live rows the session and /effort read", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith("/api/tags") ? json(OLLAMA_TAGS) : json(OLLAMA_SHOW));
    const rows = await new ModelMetadataResolver({ fetchImpl, env: { OLLAMA_API_KEY: "fixture" } })
      .discoverOllamaCloudModels({}, "future-coder:9b");
    expect(rows?.map(row => row.model)).toEqual(["future-coder:9b", "minimax-m3.1-flash"]);
    const urls = fetchImpl.mock.calls.map(call => String(call[0]));
    expect(urls).toEqual(expect.arrayContaining(["https://ollama.com/api/tags", "https://ollama.com/api/show"]));
    expect(resolveImageInputSupport({ provider: "ollama-cloud", model: "future-coder:9b" })).toBe("supported");
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model: "future-coder:9b" })?.contextWindow).toBe(524288);
    expect(resolveReasoningEffort({ provider: "ollama-cloud", model: "future-coder:9b" }).levels).toEqual(["none", "low", "high"]);
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model: "clef:27b" })).toBeUndefined();
  });
});

describe("OpenRouter: current catalog, thinking flags and live rows", () => {
  test("the regenerated catalog lists current models and drops retired ones", () => {
    for (const model of ["anthropic/claude-haiku-5.5", "google/gemini-4-argon", "openai/gpt-6.1-sol-pro", "meta/muse-wonder"]) {
      expect(OPENROUTER_MODEL_IDS, model).toContain(model);
    }
    for (const model of ["deepseek/deepseek-r1", "anthropic/claude-sonnet-4", "qwen/qwen3-max", "sao10k/l3.1-euryale-70b"]) {
      expect(OPENROUTER_MODEL_IDS, model).not.toContain(model);
    }
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" })?.supportedReasoningLevels)
      .toEqual(["max", "high", "low", "none"]);
  });

  test("models that think are flagged as thinking, others are not", () => {
    expect(resolveProviderModelCapabilities({ provider: "openrouter", model: "z-ai/glm-5.3-flash" }))
      .toMatchObject({ supportsExtendedThinking: true, acceptsThinkingHistory: true });
    expect(resolveProviderModelCapabilities({ provider: "openrouter", model: "mistralai/mistral-nemo" }))
      .toMatchObject({ supportsExtendedThinking: false, acceptsThinkingHistory: false });
  });

  test("a session with thinking history can switch to an OpenRouter thinking model", () => {
    const requirements = analyzeSessionHistoryRequirements({ history: [{ type: "reasoning", text: "x" }] });
    const target = resolveProviderCapabilityEntry({ provider: "openrouter", model: "z-ai/glm-5.3-flash" });
    expect(validateHistoryCompatibility(target, requirements).compatible).toBe(true);
  });

  test("the public list fills in a model the bundled catalog does not know", async () => {
    const listing = { data: [{
      id: "acme/next-vision", name: "Acme: Next Vision", context_length: 400000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      top_provider: { max_completion_tokens: 64000 },
      supported_parameters: ["tools", "reasoning", "include_reasoning", "max_tokens"],
      reasoning: { supported_efforts: ["high", "low", "none"], default_effort: "high" },
      pricing: { prompt: "0.000001", completion: "0.000002" },
      expiration_date: "2027-01-31",
    }, {
      id: "acme/image-only", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      supported_parameters: [], context_length: 1000, pricing: {},
    }] };
    expect(openRouterRowFromListing(listing.data[1], "2026-10-20")?.model).toBe("acme/image-only");
    expect(resolveRegisteredModelCatalogEntry({ provider: "openrouter", model: "acme/next-vision" })).toBeUndefined();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(listing));
    expect(await new ModelMetadataResolver({ fetchImpl }).discoverOpenRouterModels()).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/models");
    expect(resolveImageInputSupport({ provider: "openrouter", model: "acme/next-vision" })).toBe("supported");
    expect(resolveReasoningEffort({ provider: "openrouter", model: "acme/next-vision" }).levels).toEqual(["high", "low", "none"]);
    expect(modelCapabilityTags("openrouter", "acme/next-vision")).toBe("vision · thinking · tools · retires 2027-01-31");
  });

  test("picker tags name free routes", () => {
    const free = OPENROUTER_MODEL_IDS.find(model => model.endsWith(":free"));
    expect(free).toBeDefined();
    expect(modelCapabilityTags("openrouter", free!)).toContain("free");
  });
});
