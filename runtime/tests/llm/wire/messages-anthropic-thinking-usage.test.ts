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

describe("parseAnthropicMessagesResponse thinking-token usage (#2112)", () => {
  test("maps nested thinking_tokens as a subset of inclusive output", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      output_tokens_details: { thinking_tokens: 312 },
    });

    expect(usage.promptTokens).toBe(120);
    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(312);
    expect(usage.totalTokens).toBe(468);
  });

  test("falls back to legacy reasoning_output_tokens when details are absent", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      reasoning_output_tokens: 312,
    });

    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(312);
  });

  test("prefers nested thinking_tokens over the legacy flat field", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      reasoning_output_tokens: 99,
      output_tokens_details: { thinking_tokens: 312 },
    });

    expect(usage.reasoningOutputTokens).toBe(312);
    expect(usage.completionTokens).toBe(348);
  });

  test("keeps a reported zero thinking count", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      output_tokens_details: { thinking_tokens: 0 },
    });

    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(0);
  });

  test("omits reasoning when output details are missing", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
    });

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
        input_tokens: 120,
        output_tokens: 348,
        output_tokens_details: { thinking_tokens: thinkingTokens },
        reasoning_output_tokens: 99,
      });

      expect(usage.completionTokens).toBe(348);
      expect(usage.reasoningOutputTokens).toBeUndefined();
    },
  );

  test("clamps a thinking count above inclusive output", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      output_tokens_details: { thinking_tokens: 400 },
    });

    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(348);
  });

  test("clamps a legacy reasoning count above inclusive output", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      reasoning_output_tokens: 400,
    });

    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(348);
  });

  test("does not double-count the thinking subset in cost accounting", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      output_tokens_details: { thinking_tokens: 312 },
    });
    expect(usage.completionTokens).toBe(348);
    expect(usage.reasoningOutputTokens).toBe(312);
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
