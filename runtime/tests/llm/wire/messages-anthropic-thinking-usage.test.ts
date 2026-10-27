import { taskUsageTokens, TaskBudget } from "../../../src/session/task-budget.js";
import { describe, expect, test } from "vitest";
import {
  parseAnthropicMessagesResponse,
} from "./messages-anthropic.js";
import {
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "src/session/cost.js";

const MODEL = "claude-sonnet-4.5";
const BASE_USAGE = { input_tokens: 120, output_tokens: 348 } as const;

function parseUsage(usage: Record<string, unknown>) {
  return parseAnthropicMessagesResponse(
    MODEL,
    { model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage },
    { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [] },
  ).usage;
}

function billedCost(usage: ReturnType<typeof parseUsage>): number {
  const modelUsage: ModelUsage = {
    model: MODEL,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    webSearchRequests: usage.webSearchRequests ?? 0,
    totalTokens: usage.totalTokens,
    turns: 1,
  };
  return computeUsdCost(modelUsage, DEFAULT_MODEL_COSTS);
}

describe("parseAnthropicMessagesResponse thinking-token usage (#2112)", () => {
  test.each([
    {
      name: "maps nested thinking_tokens as a subset of inclusive output",
      usage: { ...BASE_USAGE, output_tokens_details: { thinking_tokens: 312 } },
      expected: {
        promptTokens: 120,
        completionTokens: 348,
        reasoningOutputTokens: 312,
        reasoningIncludedInCompletion: true,
        totalTokens: 468,
      },
    },
    {
      name: "falls back to legacy reasoning_output_tokens when details are absent",
      usage: { ...BASE_USAGE, reasoning_output_tokens: 312 },
      expected: {
        completionTokens: 348,
        reasoningOutputTokens: 312,
        reasoningIncludedInCompletion: true,
      },
    },
    {
      name: "prefers nested thinking_tokens over the legacy flat field",
      usage: {
        ...BASE_USAGE,
        reasoning_output_tokens: 99,
        output_tokens_details: { thinking_tokens: 312 },
      },
      expected: {
        reasoningOutputTokens: 312,
        completionTokens: 348,
        reasoningIncludedInCompletion: true,
      },
    },
    {
      name: "keeps a reported zero thinking count",
      usage: { ...BASE_USAGE, output_tokens_details: { thinking_tokens: 0 } },
      expected: {
        completionTokens: 348,
        reasoningOutputTokens: 0,
        reasoningIncludedInCompletion: true,
      },
    },
    {
      name: "clamps a thinking count above inclusive output",
      usage: { ...BASE_USAGE, output_tokens_details: { thinking_tokens: 400 } },
      expected: {
        completionTokens: 348,
        reasoningOutputTokens: 348,
        reasoningIncludedInCompletion: true,
      },
    },
    {
      name: "clamps a legacy reasoning count above inclusive output",
      usage: { ...BASE_USAGE, reasoning_output_tokens: 400 },
      expected: {
        completionTokens: 348,
        reasoningOutputTokens: 348,
        reasoningIncludedInCompletion: true,
      },
    },
  ] as const)("$name", ({ usage, expected }) => {
    expect(parseUsage(usage)).toMatchObject(expected);
  });

  test("omits reasoning when output details are missing", () => {
    const usage = parseUsage({ ...BASE_USAGE });
    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBeUndefined();
    expect(usage.reasoningIncludedInCompletion).toBeUndefined();
  });

  test.each([
    ["string", "312"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["object", {}],
    ["array", []],
    ["null", null],
    ["negative", -1],
  ] as const)(
    "rejects malformed thinking_tokens (%s)",
    (_label, thinkingTokens) => {
      const usage = parseUsage({
        ...BASE_USAGE,
        output_tokens_details: { thinking_tokens: thinkingTokens },
        reasoning_output_tokens: 99,
      });
      expect(usage.completionTokens).toBe(348);
      expect(usage.reasoningOutputTokens).toBeUndefined();
      expect(usage.reasoningIncludedInCompletion).toBeUndefined();
    },
  );

  test("does not double-count the thinking subset in cost accounting", () => {
    const usage = parseUsage({
      ...BASE_USAGE,
      output_tokens_details: { thinking_tokens: 312 },
    });
    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(312);
    const cost = billedCost(usage);

    // Claude Sonnet 4.5: $3 / $15 per MTok. Reasoning is a subset of the
    // inclusive 348 output tokens and has no separate Anthropic rate, so
    // billing is 120 * 0.003 + 348 * 0.015 per 1K — not 348 + 312 output.
    expect(cost).toBeCloseTo(0.00558, 6);
    expect(cost).not.toBeCloseTo(
      (120 / 1000) * 0.003 + ((348 + 312) / 1000) * 0.015,
      6,
    );
  });
});


describe("Anthropic cache-inclusive task accounting", () => {
  test.each([
    { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 111, cache_creation_input_tokens: 20 },
    { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20,
      cache_creation: { ephemeral_1h_input_tokens: 15 }, output_tokens_details: { thinking_tokens: 4 } },
  ])("charges every billed token once and blocks the next call: %j", async raw => {
    const usage = parseUsage(raw);
    expect(usage.cacheInputExcludedFromPrompt).toBe(true);
    expect(taskUsageTokens(usage)).toBe(136);
    const budget = new TaskBudget(140);
    await budget.invoke(140, async () => ({content: "ok", toolCalls: [], model: MODEL, usage}));
    expect(budget.tokens).toBe(136);
    await expect(budget.invoke(5, async () => { throw new Error("must not dispatch"); })).rejects.toThrow("Task budget reached");
  });
  test("keeps OpenAI-compatible cache counters inclusive", () => {
    expect(taskUsageTokens({promptTokens: 131, completionTokens: 5, totalTokens: 136,
      cachedInputTokens: 100, cacheCreationInputTokens: 20, cacheCreation1hInputTokens: 15,
      reasoningOutputTokens: 4})).toBe(136);
  });
});
