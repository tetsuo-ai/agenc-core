// xAI bills a priority-processed request at 2x the standard rate of every
// token type (input, cached input, output, reasoning), with the cache
// discount applied before the multiplier, and only when the response reports
// service_tier "priority" (docs.x.ai/developers/pricing, Priority Processing
// Pricing, read 2026-09-24). Grok 4.7 and 4.6 are $2 / $0.50 / $6 per 1M
// below 200K prompt tokens, so priority is $4 / $1 / $12.
import { describe, expect, it } from "vitest";

import {
  computeUsdCostWithResolution,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";
import type { Event } from "../../src/session/event-log.js";

const PER_M = 1 / 1_000_000;

function call(
  model: string,
  input: number,
  output: number,
  extra: Partial<ModelUsage> = {},
): ModelUsage {
  return {
    model,
    provider: "grok",
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: input + output,
    turns: 1,
    singleCall: true,
    ...extra,
  };
}

function priced(usage: ModelUsage): { readonly costUsd: number; readonly known: boolean } {
  const { costUsd, known } = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
  return { costUsd, known };
}

describe("xAI priority processing is priced at the served tier", () => {
  it.each(["grok-4.7", "grok-4.6", "xai:grok-4.7"])("prices a priority-served %s call at 2x", (model) => {
    // 100K input and 10K output tokens.
    expect(priced(call(model, 100_000, 10_000))).toEqual({
      costUsd: expect.closeTo(100_000 * 2 * PER_M + 10_000 * 6 * PER_M, 12),
      known: true,
    });
    expect(priced(call(model, 100_000, 10_000, { speed: "fast" }))).toEqual({
      costUsd: expect.closeTo(100_000 * 4 * PER_M + 10_000 * 12 * PER_M, 12),
      known: true,
    });
  });

  it("doubles cached input and reasoning output too", () => {
    const usage = call("grok-4.7", 100_000, 10_000, {
      cachedInputTokens: 60_000,
      reasoningOutputTokens: 4_000,
    });
    // Whatever the standard formula charges, every token rate doubles.
    expect(priced({ ...usage, speed: "fast" }).costUsd).toBeCloseTo(
      2 * priced(usage).costUsd,
      12,
    );
  });

  it("keeps server-side tool calls at their own rate, since they are not tokens", () => {
    const tokens = call("grok-4.7", 10_000, 1_000);
    const searched = call("grok-4.7", 10_000, 1_000, { webSearchRequests: 3 });
    const searchCost = priced(searched).costUsd - priced(tokens).costUsd;
    expect(priced({ ...searched, speed: "fast" }).costUsd).toBeCloseTo(
      2 * priced(tokens).costUsd + searchCost,
      12,
    );
  });
});

describe("CostSidecar prices each Grok call at its served tier", () => {
  const tokenCount = (promptTokens: number, completionTokens: number, speed?: "fast"): Event => ({
    id: "usage",
    msg: {
      type: "token_count",
      payload: {
        model: "grok-4.7",
        provider: "grok",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        ...(speed !== undefined ? { speed } : {}),
      },
    },
  } as Event);

  it("charges a priority-served call at 2x and a default call at standard rates", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount(100_000, 10_000));
    sidecar.onEvent(tokenCount(100_000, 10_000, "fast"));
    const standard = 100_000 * 2 * PER_M + 10_000 * 6 * PER_M;
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(standard + 2 * standard, 12);
  });
});
