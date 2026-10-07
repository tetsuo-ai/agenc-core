// The managed AgenC route (provider `agenc`, model deepseek/deepseek-v4.1-flash)
// reaches OpenRouter through the AgenC gateway, which pins one reviewed
// endpoint and charges AgenC credits. A live run on 2026-10-01 priced one call
// (22,116 input and 5 output tokens) at $3.3204, the registry's conservative
// ceiling, because the route had no price of its own.
import { describe, expect, test } from "vitest";

import {
  CostSidecar,
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";

const ROUTE = "deepseek/deepseek-v4.1-flash";
// OpenRouter's dated generation id for the same model. The gateway passes the
// upstream response model through, so a managed response can report it.
const GENERATION = "deepseek/deepseek-v4.1-flash-20260910";
const PER_M = 1 / 1_000_000;
const ROUTE_CALL_USD = 22_116 * 0.3 * PER_M + 5 * 1.2 * PER_M;

const call = (provider: string, model: string, cachedInputTokens = 0): ModelUsage => ({
  provider, model, inputTokens: 22_116, outputTokens: 5, cachedInputTokens,
  cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0,
  totalTokens: 22_121, turns: 1, singleCall: true,
});

describe("managed AgenC DeepSeek cost", () => {
  test.each([ROUTE, GENERATION])("prices %s at the route's own rates", (model) => {
    const resolution = computeUsdCostWithResolution(call("agenc", model), DEFAULT_MODEL_COSTS);
    expect(resolution).toMatchObject({ known: true, matchedKey: `agenc:${model}` });
    expect(resolution.costEstimated).toBeUndefined();
    expect(resolution.costUsd).toBeCloseTo(ROUTE_CALL_USD, 12);
  });

  test("bills cache reads at the route's cache-read rate", () => {
    const resolution = computeUsdCostWithResolution(call("agenc", ROUTE, 20_000), DEFAULT_MODEL_COSTS);
    expect(resolution.costUsd).toBeCloseTo(
      2_116 * 0.3 * PER_M + 20_000 * 0.03 * PER_M + 5 * 1.2 * PER_M, 12);
  });

  test("keeps the public OpenRouter row and unpriced managed routes conservative", () => {
    for (const [provider, model] of [
      // A user's own OpenRouter key is routed freely, so the catalog row stays unpriced.
      ["openrouter", ROUTE],
      // The retired V4 Flash 0731 route has no current reviewed price.
      ["agenc", "deepseek/deepseek-v4-flash-0731"],
      ["agenc", "agenc"],
      ["agenc", "future-vendor/unpriced-model"],
    ] as const) {
      expect(computeUsdCostWithResolution(call(provider, model), DEFAULT_MODEL_COSTS))
        .toMatchObject({ known: false, costEstimated: true });
    }
  });

  test("the session cost sidecar prices managed calls at the route's rates", () => {
    const sidecar = new CostSidecar({ defaultProvider: "agenc", defaultModel: ROUTE });
    // A usage event without identity takes the session's provider and model.
    sidecar.onEvent({
      id: "1", seq: 1,
      msg: { type: "token_count", payload: { promptTokens: 22_116, completionTokens: 5, totalTokens: 22_121 } },
    });
    // A streamed turn reports the session provider and the response model.
    sidecar.onEvent({
      id: "2", seq: 2,
      msg: { type: "token_count", payload: {
        provider: "agenc", model: GENERATION,
        promptTokens: 22_116, completionTokens: 5, totalTokens: 22_121,
      } },
    });
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(2 * ROUTE_CALL_USD, 12);
    expect(sidecar.hasUnknownModelCost()).toBe(false);
  });
});
