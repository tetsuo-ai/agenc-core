import { describe, expect, test } from "vitest";
import {
  parseAnthropicMessagesResponse,
} from "./messages-anthropic.js";
import {
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "src/session/cost.js";

function parseUsage(usage: Record<string, unknown>) {
  return parseAnthropicMessagesResponse(
    "claude-sonnet-4.5",
    {
      id: "msg_usage",
      model: "claude-sonnet-4.5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage,
    },
    {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    },
  ).usage;
}

function modelUsageFromParsed(
  usage: ReturnType<typeof parseUsage>,
  model = "claude-sonnet-4.5",
): ModelUsage {
  return {
    model,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    webSearchRequests: usage.webSearchRequests ?? 0,
    totalTokens: usage.totalTokens,
    turns: 1,
  };
}

const BASE_USAGE = { input_tokens: 120, output_tokens: 348 } as const;

describe("parseAnthropicMessagesResponse thinking-token usage (#2112)", () => {
  test.each([
    {
      name: "maps nested thinking_tokens as a subset of inclusive output",
      usage: {
        ...BASE_USAGE,
        output_tokens_details: { thinking_tokens: 312 },
      },
      expected: {
        promptTokens: 120,
        completionTokens: 348,
        reasoningOutputTokens: 312,
        totalTokens: 468,
      },
    },
    {
      name: "falls back to legacy reasoning_output_tokens when details are absent",
      usage: { ...BASE_USAGE, reasoning_output_tokens: 312 },
      expected: { completionTokens: 348, reasoningOutputTokens: 312 },
    },
    {
      name: "prefers nested thinking_tokens over the legacy flat field",
      usage: {
        ...BASE_USAGE,
        reasoning_output_tokens: 99,
        output_tokens_details: { thinking_tokens: 312 },
      },
      expected: { reasoningOutputTokens: 312, completionTokens: 348 },
    },
    {
      name: "keeps a reported zero thinking count",
      usage: {
        ...BASE_USAGE,
        output_tokens_details: { thinking_tokens: 0 },
      },
      expected: { completionTokens: 348, reasoningOutputTokens: 0 },
    },
    {
      name: "clamps a thinking count above inclusive output",
      usage: {
        ...BASE_USAGE,
        output_tokens_details: { thinking_tokens: 400 },
      },
      expected: { completionTokens: 348, reasoningOutputTokens: 348 },
    },
    {
      name: "clamps a legacy reasoning count above inclusive output",
      usage: { ...BASE_USAGE, reasoning_output_tokens: 400 },
      expected: { completionTokens: 348, reasoningOutputTokens: 348 },
    },
  ] as const)("$name", ({ usage, expected }) => {
    expect(parseUsage(usage)).toMatchObject(expected);
  });

  test("omits reasoning when output details are missing", () => {
    const usage = parseUsage({ ...BASE_USAGE });
    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBeUndefined();
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
    },
  );

  test("does not double-count the thinking subset in cost accounting", () => {
    const usage = parseUsage({
      ...BASE_USAGE,
      output_tokens_details: { thinking_tokens: 312 },
    });
    expect(usage).toMatchObject({
      completionTokens: 348,
      reasoningOutputTokens: 312,
    });
    const cost = computeUsdCost(
      modelUsageFromParsed(usage),
      DEFAULT_MODEL_COSTS,
    );

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
