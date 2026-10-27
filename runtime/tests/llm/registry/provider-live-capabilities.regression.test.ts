/**
 * Regressions found live on 2026-10-20 (jobs/pv): each fails on r4/base
 * c85e49ae4 and passes once the provider's own live rows drive capabilities.
 * Uses only APIs that exist on both sides.
 */
import { describe, expect, test, vi } from "vitest";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import {
  resolveImageInputSupport,
  resolveProviderModelCapabilities,
} from "../../../src/llm/capabilities.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { OLLAMA_CLOUD_MODELS } from "../../../src/llm/registry/ollama-cloud-models.js";
import { OPENROUTER_MODEL_IDS } from "../../../src/llm/registry/openrouter-model-ids.js";
import { reasoningEffortAcceptedByModel } from "../../../src/session/reasoning-effort-for-model.js";
import { parseVeniceModels } from "../../../src/llm/registry/venice-models.js";
import { resolveSessionReasoningEffort } from "../../../src/session/session-reasoning-effort.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../../src/session/cost.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("live provider capabilities (fail on base, pass after)", () => {
  test("Venice: a live vision + effort model receives images and takes its effort levels", async () => {
    const model = "regression-venice-vision";
    const list = { data: [{
      id: model, type: "text", model_spec: {
        name: "Regression Vision", offline: false, availableContextTokens: 256000, maxCompletionTokens: 8192,
        pricing: { input: { usd: 0.12 }, output: { usd: 0.36 } },
        capabilities: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true,
          supportsReasoningEffort: true, reasoningEffortOptions: ["none", "low", "medium", "high"], defaultReasoningEffort: "low" },
      },
    }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(list));
    await new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: "fixture" } }).discoverVeniceModels({});
    // Base: "unsupported" -> the TUI withheld the attached image ("cannot view images").
    expect(resolveImageInputSupport({ provider: "venice", model })).toBe("supported");
    // Base: [] -> /effort said "does not support effort levels".
    expect(resolveReasoningEffort({ provider: "venice", model }).levels).toEqual(["none", "low", "medium", "high"]);
    expect(reasoningEffortAcceptedByModel({ provider: "venice", model, reasoningEffort: "medium" })).toBe(true);
    expect(resolveProviderModelCapabilities({ provider: "venice", model }).supportsExtendedThinking).toBe(true);
  });

  test("Venice: a list that takes over a second to arrive still teaches the session its models", async () => {
    // Seen live (jobs/pv, 2026-10-20): Venice's 137-model list took about a
    // second through the recorder, the daemon gave up after one second, and
    // /effort refused the levels the TUI had just offered.
    const model = "regression-venice-slow-list";
    const list = { data: [{
      id: model, type: "text", model_spec: {
        name: "Regression Slow", offline: false, availableContextTokens: 256000, maxCompletionTokens: 8192,
        pricing: { input: { usd: 0.12 }, output: { usd: 0.36 } },
        capabilities: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true,
          supportsReasoningEffort: true, reasoningEffortOptions: ["low", "high"], defaultReasoningEffort: "low" },
      },
    }] };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json(list)), 1_500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }));
      const discovery = new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: "fixture" } }).discoverVeniceModels({});
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await discovery)?.map(entry => entry.model)).toEqual([model]);
    } finally {
      vi.useRealTimers();
    }
    expect(resolveImageInputSupport({ provider: "venice", model })).toBe("supported");
    expect(resolveReasoningEffort({ provider: "venice", model }).levels).toEqual(["low", "high"]);
  });

  test("Venice: a model whose tool calls never arrive is left out like one without function calling", () => {
    // Probed live (jobs/pv probes/venice-sweep, 2026-10-20): each is listed
    // with supportsFunctionCalling but no call arrived as a tool call.
    const row = (id: string) => ({
      id, type: "text",
      model_spec: { name: id, availableContextTokens: 32768, capabilities: { supportsFunctionCalling: true } },
    });
    const ids = ["venice-uncensored-role-play", "qwen3-6-35b-a3b", "aion-labs-aion-3-5-mini", "e2ee-qwen3-vl-30b-a3b-p", "qwen-3-8-flash"];
    expect(parseVeniceModels({ data: ids.map(row) }).map(model => model.model)).toEqual(["qwen-3-8-flash"]);
  });

  test("Ollama Cloud: the 2026-10-20 models are known and no model borrows another's row", () => {
    const ids = OLLAMA_CLOUD_MODELS.map(entry => entry.model);
    expect(ids).toEqual(expect.arrayContaining(["minimax-m3.1-flash", "deepseek-v4.1-flash:1017", "mistral-large-4", "muse-spark-open", "beam"]));
    // Base: minimax-m3's row (context 512000, efforts none/high) by name prefix.
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model: "minimax-m3.9-preview" })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider: "ollama-cloud", model: "deepseek-v4.1-flash" })?.supportedReasoningLevels)
      .toContain("none");
    // Base: no price of its own (https://ollama.com/pricing lists 0.68/0.07/2.09 USD per million).
    const price = resolveModelCostEntry({ provider: "ollama-cloud", model: "mistral-large-4" }, DEFAULT_MODEL_COSTS);
    expect(price?.key).toBe("ollama-cloud:mistral-large-4");
    expect(price?.entry.inputUsdPer1K).toBeCloseTo(0.00068, 10);
    expect(price?.entry.outputUsdPer1K).toBeCloseTo(0.00209, 10);
  });

  test("Ollama Cloud: a model's default effort is the level it thinks at when no effort is sent", () => {
    // Seen live (jobs/pv final matrix): /effort and the status line said "low"
    // for deepseek-v4.1-flash and kimi-k3 while the requests carried no
    // reasoning_effort, so the models thought at their /api/show defaults.
    const defaultLevel = (model: string) => resolveReasoningEffort({ provider: "ollama-cloud", model }).defaultLevel;
    expect(defaultLevel("deepseek-v4.1-flash")).toBe("high");
    expect(defaultLevel("kimi-k3")).toBe("max");
    expect(defaultLevel("glm-5.3")).toBe("max");
    expect(defaultLevel("gpt-oss:120b")).toBe("medium");
    expect(defaultLevel("kimi-k2.6")).toBe("high");
    expect(defaultLevel("gemma4:31b")).toBe("none");
    // Ollama publishes low for deepseek-v4-pro:0813; a DeepSeek model through a
    // gateway runs at DeepSeek's own default, high, which the session sends.
    expect(defaultLevel("deepseek-v4-pro:0813")).toBe("high");
  });

  test("Ollama Cloud: thinking off is sent as none, since leaving the effort out keeps the model thinking", () => {
    // Probed live (jobs/pv probes/ollama-effort-matrix.json): deepseek, glm-5.2,
    // kimi, gemma4, minimax-m3, muse and nemotron stop thinking only with
    // reasoning_effort none; omitted, they think at their /api/show default.
    for (const model of ["deepseek-v4.1-flash", "kimi-k2.6", "nemotron-3-super", "gemma4:31b"]) {
      const levels = resolveReasoningEffort({ provider: "ollama-cloud", model }).levels;
      expect(resolveSessionReasoningEffort("none", levels, { provider: "ollama-cloud", model }), model).toBe("none");
    }
    // A model that lists no off level still gets nothing.
    const gptOss = resolveReasoningEffort({ provider: "ollama-cloud", model: "gpt-oss:120b" }).levels;
    expect(resolveSessionReasoningEffort("none", gptOss, { provider: "ollama-cloud", model: "gpt-oss:120b" })).toBeUndefined();
  });

  test("OpenRouter: the catalog matches the 2026-10-20 list and flags thinking models", () => {
    expect(OPENROUTER_MODEL_IDS).toContain("anthropic/claude-haiku-5.5");
    expect(OPENROUTER_MODEL_IDS).not.toContain("deepseek/deepseek-r1");
    // Base: constant false for every OpenRouter model.
    expect(resolveProviderModelCapabilities({ provider: "openrouter", model: "z-ai/glm-5.3-flash" }).supportsExtendedThinking).toBe(true);
  });

  test("OpenRouter: the public list it already fetches fills in a model the catalog lacks", async () => {
    const model = "regression/next-vision";
    const listing = { data: [{
      id: model, name: "Regression: Next Vision", context_length: 400000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      top_provider: { max_completion_tokens: 64000 },
      supported_parameters: ["tools", "reasoning", "include_reasoning"],
      reasoning: { supported_efforts: ["high", "low"], default_effort: "high" },
      pricing: { prompt: "0.000001", completion: "0.000002" },
    }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(listing));
    await new ModelMetadataResolver({ fetchImpl }).resolve({ provider: "openrouter", model, config: {} });
    // Base: "unknown" and no levels; the list's image input and efforts were read for limits only.
    expect(resolveImageInputSupport({ provider: "openrouter", model })).toBe("supported");
    expect(resolveReasoningEffort({ provider: "openrouter", model }).levels).toEqual(["high", "low"]);
  });
});
