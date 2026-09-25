// OpenAI bills one request by three things the flat Standard row does not
// carry: the tier that served it (Fast mode, reported as service_tier
// "priority" or "fast"), the prompt length (over 272K input tokens the whole
// request moves to the long-context rates), and cache writes on GPT-5.6 and
// later (1.25x input, a subset of input_tokens). Rates are the Standard and
// Fast tables of developers.openai.com/api/docs/pricing, read 2026-09-23.
import { describe, expect, it } from "vitest";

import {
  computeUsdCostWithResolution,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../src/session/cost.js";
import type { Event } from "../../src/session/event-log.js";

function call(
  model: string,
  input: number,
  output: number,
  extra: Partial<ModelUsage> = {},
): ModelUsage {
  return {
    model,
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

describe("OpenAI Fast mode is priced at the served tier", () => {
  it.each([
    // model, standard, fast, for 100K input and 10K output
    ["gpt-6-sol", 0.3, 0.6],
    ["gpt-6-luna", 0.015, 0.03],
    ["gpt-6-astra", 1.5, 3.0],
    ["gpt-5.6-sol", 0.6, 1.2],
    ["gpt-5.5", 0.8, 2.0],
    ["gpt-5.4", 0.4, 0.8],
    ["gpt-5.3-codex", 0.315, 0.63],
    ["gpt-5", 0.225, 0.45],
    ["gpt-4.1", 0.28, 0.49],
  ])("prices %s at %d standard and %d fast", (model, standard, fast) => {
    expect(priced(call(model, 100_000, 10_000))).toEqual({
      costUsd: expect.closeTo(standard, 9),
      known: true,
    });
    expect(priced(call(model, 100_000, 10_000, { speed: "fast" }))).toEqual({
      costUsd: expect.closeTo(fast, 9),
      known: true,
    });
  });

  it("treats a fast-served call on a model with no Fast rate as unpriced", () => {
    expect(priced(call("gpt-5.4-pro", 100_000, 10_000, { speed: "fast" })).known).toBe(false);
    expect(priced(call("gpt-5.4-nano", 100_000, 10_000, { speed: "fast" })).known).toBe(false);
  });
});

describe("OpenAI long-context rates apply per request above 272K input", () => {
  it("bills a single Sol request over 272K at the long-context rates", () => {
    // $4 input and $15 output per 1M: 300K * 4 + 10K * 15.
    expect(priced(call("gpt-6-sol", 300_000, 10_000)).costUsd).toBeCloseTo(1.35, 9);
    // Fast long context: $8 / $30.
    expect(
      priced(call("gpt-6-sol", 300_000, 10_000, { speed: "fast" })).costUsd,
    ).toBeCloseTo(2.7, 9);
    // At the threshold the short-context rates still apply.
    expect(priced(call("gpt-6-sol", 272_000, 0)).costUsd).toBeCloseTo(0.544, 9);
  });

  it("does not move summed usage of several short requests to the long rates", () => {
    const summed = call("gpt-6-sol", 400_000, 20_000);
    delete (summed as { singleCall?: true }).singleCall;
    expect(priced(summed).costUsd).toBeCloseTo(0.8 + 0.2, 9);
  });

  it("prices GPT-5.5 long context and refuses to guess its Fast long-context rate", () => {
    // $10 / $45 above 272K.
    expect(priced(call("gpt-5.5", 300_000, 10_000)).costUsd).toBeCloseTo(3.45, 9);
    // The Fast table has no long-context rate for GPT-5.5.
    expect(priced(call("gpt-5.5", 300_000, 10_000, { speed: "fast" })).known).toBe(false);
  });
});

describe("OpenAI cache writes", () => {
  it("bills Sol cache writes at 1.25x input out of the reported input tokens", () => {
    // 100K input: 20K cache reads, 30K cache writes, 50K ordinary.
    const usage = call("gpt-6-sol", 100_000, 0, {
      cachedInputTokens: 20_000,
      cacheCreationInputTokens: 30_000,
    });
    // 50K * $2 + 20K * $0.20 + 30K * $2.50 per 1M.
    expect(priced(usage).costUsd).toBeCloseTo(0.1 + 0.004 + 0.075, 9);
  });
});

describe("OpenAI Pro models never inherit their base model's price", () => {
  it.each([
    // model, 100K input and 10K output at the Pro row
    ["gpt-5.5-pro", 4.8],
    ["gpt-5.4-pro", 4.8],
    ["gpt-5.2-pro", 3.78],
    ["gpt-5-pro", 2.7],
    ["o3-pro", 2.8],
    ["openai:gpt-5.4-pro", 4.8],
    ["openai/gpt-5.2-pro", 3.78],
    ["gpt-5.4-pro-2026-03-05", 4.8],
  ])("prices %s at its own Pro rate", (model, expected) => {
    expect(priced(call(model, 100_000, 10_000))).toEqual({
      costUsd: expect.closeTo(expected, 9),
      known: true,
    });
  });

  it("prices GPT-5.4 Pro long context at $60 / $270", () => {
    expect(priced(call("gpt-5.4-pro", 300_000, 10_000)).costUsd).toBeCloseTo(18 + 2.7, 9);
  });

  it.each([
    "gpt-5.4-ultra",
    "gpt-5.2-pro-preview",
    "gpt-5.2-codex-max",
    "gpt-5.1-pro",
    "gpt-5-mini-pro",
  ])("leaves the unknown sibling %s unpriced", (model) => {
    expect(priced(call(model, 1_000, 1_000)).known).toBe(false);
  });

  it.each([
    ["gpt-5.4-2026-03-05", "gpt-5.4"],
    ["gpt-5.4-mini-2026-03-17", "gpt-5.4-mini"],
    ["gpt-5.2-2025-12-11", "gpt-5.2"],
    ["gpt-5-mini-2025-08-07", "gpt-5-mini"],
  ])("still prices the dated snapshot %s as %s", (snapshot, model) => {
    expect(priced(call(snapshot, 100_000, 10_000))).toEqual(priced(call(model, 100_000, 10_000)));
    expect(priced(call(snapshot, 100_000, 10_000)).known).toBe(true);
  });
});

describe("CostSidecar prices each OpenAI call at its own tier", () => {
  const tokenCount = (promptTokens: number, completionTokens: number, speed?: "fast"): Event => ({
    id: "usage",
    msg: {
      type: "token_count",
      payload: {
        model: "gpt-6-sol",
        provider: "openai",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        ...(speed !== undefined ? { speed } : {}),
      },
    },
  } as Event);

  it("keeps two short calls at short-context rates", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount(200_000, 0));
    sidecar.onEvent(tokenCount(200_000, 0));
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.8, 9);
  });

  it("charges a long-context call and a fast call at their own rates", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount(100_000, 10_000));
    sidecar.onEvent(tokenCount(300_000, 10_000));
    sidecar.onEvent(tokenCount(100_000, 10_000, "fast"));
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.3 + 1.35 + 0.6, 9);
  });
});
