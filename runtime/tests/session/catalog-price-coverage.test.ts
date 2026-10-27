import { expect, test } from "vitest";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../src/llm/registry/provider-info.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS } from "../../src/session/cost.js";

// A model without a price shows the conservative registry ceiling (o1-pro
// rates) as its cost, hundreds of times the real bill. Every model the picker
// offers needs a published rate or a known zero (local, free or included in a
// plan). OpenRouter is exempt: each response reports what the call cost.
const UNPRICED: ReadonlyMap<string, string> = new Map([
  // https://platform.kimi.ai/docs/pricing/chat, checked 2026-10-23.
  ["kimi:kimi-k3.1-pro", "Moonshot has not published a verified K3.1 Pro rate"],
  ["kimi:kimi-k3.1-pro-highspeed", "Moonshot has not published a verified K3.1 Pro Highspeed rate"],
  // The bare managed identity resolves to a priced route before any call.
  ["agenc:agenc", "managed identity, priced per route"],
  ["groq:minimaxai/minimax-m2.7", "Enterprise preview on a contract price; Groq publishes none"],
]);

test("every model in the picker has a price AgenC can show", () => {
  const unpriced: string[] = [];
  for (const [provider, models] of Object.entries(BUILT_IN_PROVIDER_MODEL_CATALOG)) {
    if (provider === "openrouter") continue;
    for (const model of models) {
      const resolution = computeUsdCostWithResolution({
        model, provider, inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 0,
        cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0,
        totalTokens: 11_000, turns: 1, singleCall: true,
      }, DEFAULT_MODEL_COSTS);
      if (!resolution.known && !UNPRICED.has(`${provider}:${model}`)) unpriced.push(`${provider}:${model}`);
    }
  }
  expect(unpriced).toEqual([]);
});

test("OpenRouter calls are priced from the charge each response reports", () => {
  for (const model of BUILT_IN_PROVIDER_MODEL_CATALOG.openrouter) {
    expect(chatCompletionsCapabilityHintsForProvider("openrouter", model).reportsUsageCost, model).toBe(true);
  }
});
