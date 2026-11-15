import { describe, expect, test, vi } from "vitest";

import { childModelProfile } from "../../../src/agents/provider-selector-profiles.js";
import { resolveProviderModelCapabilities } from "../../../src/llm/capabilities.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../src/llm/providers/gemini/endpoint-plan.js";
import {
  GEMINI_THINKING_MODELS,
  resolveGeminiThinkingModel,
} from "../../../src/llm/registry/gemini-thinking-models.js";
import {
  findBundledModelCatalogEntry,
  resolveRegisteredModelCatalogEntry,
} from "../../../src/llm/registry/model-catalog.js";
import { retiredBundledModel } from "../../../src/llm/registry/model-retirement.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../../../src/llm/registry/provider-info.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../../src/session/cost.js";
import * as modelConfigs from "../../../src/utils/model/configs.js";

// The Gemini API on 2026-11-15: GET /v1beta/models with the project key, the
// model, pricing, thinking and deprecations pages on ai.google.dev, and one
// tiny live request per id.

/** Ids that answered a live generateContent request under their own name. */
const SERVED = [
  "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen",
  "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
  "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
  "gemini-3-flash-preview", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-robotics-er-2-preview",
] as const;
/** Ids that answered HTTP 404 "no longer available". */
const SHUT_DOWN = ["gemini-3-pro-preview", "gemini-2.0-flash", "gemini-2.0-flash-lite"] as const;

function usage(model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0) {
  return {
    provider: "gemini", model, inputTokens, outputTokens, cachedInputTokens,
    cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0,
    totalTokens: inputTokens + outputTokens, turns: 1, singleCall: true,
  };
}

async function requestBody(model: string, options: Record<string, unknown>, stream = false) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => stream
    ? new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    : Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
  const provider = new GeminiProvider({
    model, endpointPlan: createGeminiEndpointPlan(), fetchImpl,
    credentialPlan: { kind: "api-key", credential: "fixture", source: "factory" },
  });
  const messages = [{ role: "user" as const, content: "hi" }];
  if (stream) await provider.chatStream(messages, () => undefined, options);
  else await provider.chat(messages, options);
  return {
    url: String(fetchImpl.mock.calls[0]?.[0]),
    body: JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { generationConfig: Record<string, unknown> },
  };
}

describe("Gemini catalog against the API of 2026-11-15", () => {
  test.each(SERVED)("lists %s in the picker with a price", (model) => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })).toMatchObject({ visibility: "list", supportsToolUse: true });
    expect(computeUsdCostWithResolution(usage(model, 1_000, 1_000), DEFAULT_MODEL_COSTS).known).toBe(true);
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).supportsExtendedThinking).toBe(true);
  });

  test.each(SHUT_DOWN)("has no row and no default that names %s", (model) => {
    expect(resolveGeminiThinkingModel(model)).toBeUndefined();
    expect(childModelProfile("gemini", model)).toBeUndefined();
    expect(JSON.stringify(modelConfigs)).not.toContain(`"${model}"`);
  });

  test("every Gemini default names a model the picker offers", () => {
    const defaults = new Set<string>([BUILT_IN_PROVIDER_DEFAULT_MODELS.gemini, ...Object.values(modelConfigs.GEMINI_MODEL_DEFAULTS)]);
    for (const value of Object.values(modelConfigs)) {
      const id = (value as { gemini?: unknown }).gemini;
      if (typeof id === "string") defaults.add(id);
    }
    expect([...defaults].sort()).toEqual(["gemini-3.1-pro-preview", "gemini-3.5-flash-lite", "gemini-3.8-flash"]);
    for (const model of defaults) {
      expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model })?.visibility).toBe("list");
    }
  });

  test("registers Gemini 4 Hydrogen with its levels, limits and price", async () => {
    expect(resolveGeminiThinkingModel("gemini-4-hydrogen")).toMatchObject({
      control: "thinkingLevel", levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high",
    });
    expect(resolveRegisteredModelCatalogEntry({ provider: "gemini", model: "gemini-4-hydrogen" })).toMatchObject({
      contextWindow: 1_048_576, maxOutputTokens: 65_536, maxOutputTokensUpperLimit: 65_536,
    });
    // $1.50 input, $7.50 output, $0.075 cached per 1M; no long-context tier.
    expect(computeUsdCostWithResolution(usage("gemini-4-hydrogen", 1_000_000, 1_000_000), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(9, 7);
    expect(computeUsdCostWithResolution(usage("gemini-4-hydrogen", 1_000_000, 0, 1_000_000), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(0.075, 7);

    const xhigh = await requestBody("gemini-4-hydrogen", { reasoningEffort: "xhigh", maxOutputTokens: 65_536 });
    expect(xhigh.url).toContain("/models/gemini-4-hydrogen:generateContent");
    expect(xhigh.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "xhigh" });
    // Unlike Argon and Carbon, one non-streaming call may return 65,536.
    expect(xhigh.body.generationConfig.maxOutputTokens).toBe(65_536);
    expect((await requestBody("gemini-4-argon", { maxOutputTokens: 65_536 })).body.generationConfig.maxOutputTokens).toBe(32_768);
    expect((await requestBody("gemini-4-hydrogen", { maxOutputTokens: 65_536 }, true)).body.generationConfig.maxOutputTokens).toBe(65_536);
  });

  test("xhigh is a level of Hydrogen only", () => {
    expect(GEMINI_THINKING_MODELS.filter((row) => row.levels.includes("xhigh")).map((row) => row.model)).toEqual(["gemini-4-hydrogen"]);
  });

  test("prices gemini-3.1-flash-lite-preview as the model that answers it", () => {
    const preview = computeUsdCostWithResolution(usage("gemini-3.1-flash-lite-preview", 1_000_000, 1_000_000), DEFAULT_MODEL_COSTS);
    const served = computeUsdCostWithResolution(usage("gemini-3.1-flash-lite", 1_000_000, 1_000_000), DEFAULT_MODEL_COSTS);
    expect(preview).toMatchObject({ known: true });
    expect(preview.costUsd).toBeCloseTo(1.75, 7);
    expect(preview.costUsd).toBe(served.costUsd);
  });

  test("does not refuse gemini-3.1-flash-lite on its announced shutdown date", () => {
    // 2027-05-07 per the deprecations page. A dated row would be refused
    // from that day even while Google still answers the id.
    expect(findBundledModelCatalogEntry({ provider: "gemini", model: "gemini-3.1-flash-lite" })?.retiresOn).toBeUndefined();
    expect(retiredBundledModel("gemini", "gemini-3.1-flash-lite", new Date("2027-06-01T00:00:00Z"))).toBeUndefined();
  });

  test("bills gemini-2.5-pro as gemini-3.8-flash from the day Google routes it", () => {
    const cost = (model: string, at: string, input = 100_000) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(at));
      try {
        return computeUsdCostWithResolution(usage(model, input, 100_000), DEFAULT_MODEL_COSTS).costUsd;
      } finally {
        vi.useRealTimers();
      }
    };
    // 2.5 Pro: $1.25 / $10, and $2.50 / $15 for a prompt over 200K tokens.
    expect(cost("gemini-2.5-pro", "2026-12-02T07:59:59Z")).toBeCloseTo(0.125 + 1, 7);
    expect(cost("gemini-2.5-pro", "2026-12-02T07:59:59Z", 300_000)).toBeCloseTo(0.75 + 1.5, 7);
    // From 2026-12-02 08:00 UTC: 3.8 Flash at $0.75 / $3.75, then $1.50 / $7.50 in 2027.
    expect(cost("gemini-2.5-pro", "2026-12-02T08:00:00Z")).toBeCloseTo(0.075 + 0.375, 7);
    expect(cost("gemini-2.5-pro", "2026-12-02T08:00:00Z", 300_000)).toBeCloseTo(0.225 + 0.375, 7);
    expect(cost("gemini-2.5-pro", "2027-01-01T00:00:00Z")).toBeCloseTo(0.15 + 0.75, 7);
    for (const at of ["2026-12-15T00:00:00Z", "2027-01-15T00:00:00Z"]) {
      expect(cost("gemini-2.5-pro", at)).toBe(cost("gemini-3.8-flash", at));
    }
    // 2.5 Flash goes to 3.5 Flash-Lite, which has the same rates.
    for (const at of ["2026-11-15T00:00:00Z", "2026-12-15T00:00:00Z"]) {
      expect(cost("gemini-2.5-flash", at)).toBe(cost("gemini-3.5-flash-lite", at));
    }
  });

  test.each([
    ["gemini-3.8-flash", true],
    ["gemini-4-hydrogen", true],
    ["gemini-3.1-pro-preview", true],
    ["gemma-4-31b-it", true],
    ["gemini-flash-latest", true],
    ["gemini-2.5-flash-lite", true],
    ["gemini-12-future", true],
    ["gemma-5-12b-it", true],
    ["gemini-robotics-er-2-preview", true],
    ["gemini-2.0-flash", false],
    ["gemini-1.5-pro", false],
    ["gemma-3-27b-it", false],
  ] as const)("knows whether %s thinks", (model, thinks) => {
    expect(resolveProviderModelCapabilities({ provider: "gemini", model }).supportsExtendedThinking).toBe(thinks);
  });

  test("a model switch still carries stored thinking only to Gemini 2.5", () => {
    // Unchanged on purpose: newer models validate thought signatures.
    expect(resolveProviderModelCapabilities({ provider: "gemini", model: "gemini-2.5-pro" }).acceptsThinkingHistory).toBe(true);
    for (const model of ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-flash-latest"]) {
      expect(resolveProviderModelCapabilities({ provider: "gemini", model }).acceptsThinkingHistory).toBe(false);
    }
  });
});
