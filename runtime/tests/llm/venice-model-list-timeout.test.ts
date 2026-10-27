/**
 * Venice's model list is the only source of its models' limits and often takes
 * longer than the general 1 s metadata timeout. A session must still read it
 * rather than run on the conservative fallback.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { ModelMetadataResolver } from "../../src/llm/model-metadata.js";
import { clearPublishedModelCatalogs } from "../../src/llm/registry/published-model-catalog.js";
import type { AgenCConfig } from "../../src/utils/config.js";

const CONFIG = {} as unknown as AgenCConfig;
const MODEL = "deepseek-v4-1-flash-1017";
const LIST = {
  data: [{
    id: MODEL, type: "text",
    model_spec: {
      name: "DeepSeek V4.1 Flash 1017", availableContextTokens: 1_000_000, maxCompletionTokens: 131_072,
      offline: false, privacy: "private", traits: [],
      capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "high", "max"], defaultReasoningEffort: "high" },
      pricing: { input: { usd: 0.3 }, cache_input: { usd: 0.0075 }, output: { usd: 1.2 } },
    },
  }],
};

function slowList(delayMs: number) {
  return vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(LIST)), delayMs);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  }));
}

describe("Venice model list timeout", () => {
  // A list one resolver read is published process-wide; each case starts without it.
  afterEach(() => clearPublishedModelCatalogs());

  test("a list that takes longer than the general metadata timeout still sets the model's limits", async () => {
    const fetchImpl = slowList(1_300);
    const resolved = await new ModelMetadataResolver({ fetchImpl, env: { VENICE_API_KEY: "venice-test" } })
      .resolve({ provider: "venice", model: MODEL, config: CONFIG });
    expect(resolved.usedFallbackModelMetadata).toBe(false);
    expect(resolved.contextWindow).toBe(1_000_000);
    expect(resolved.maxOutputTokens).toBe(64_000);
    expect(resolved.maxOutputTokensUpperLimit).toBe(131_072);
  });

  test("an explicitly configured resolver timeout still applies to the list", async () => {
    const fetchImpl = slowList(200);
    const resolved = await new ModelMetadataResolver({ fetchImpl, timeoutMs: 20, env: { VENICE_API_KEY: "venice-test" } })
      .resolve({ provider: "venice", model: MODEL, config: CONFIG });
    expect(resolved.usedFallbackModelMetadata).toBe(true);
  });
});
