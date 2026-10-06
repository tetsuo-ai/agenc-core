// The Responses usage carries what OpenAI bills a request by: cache writes in
// usage.input_tokens_details.cache_write_tokens (prompt-caching guide) and the
// tier that served it in service_tier ("priority" for GPT-5.6 and earlier,
// "fast" for GPT-6, "default" when a Fast request was downgraded; fast-mode
// guide, read 2026-09-23).
import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../types.js";
import { parseOpenAIResponsesResponse } from "./responses-openai.js";

const request = { model: "gpt-6-sol", messages: [] as LLMMessage[], tools: [] };

function parse(extra: Record<string, unknown>) {
  return parseOpenAIResponsesResponse(
    "gpt-6-sol",
    {
      status: "completed",
      model: "gpt-6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
      },
      ...extra,
    },
    request,
  );
}

describe("parseOpenAIResponsesResponse usage tiers", () => {
  test("reads cache writes as cache creation tokens", () => {
    expect(parse({}).usage).toMatchObject({
      promptTokens: 1000,
      cachedInputTokens: 200,
      cacheCreationInputTokens: 300,
    });
  });

  test.each(["fast", "priority"])("marks service_tier %s as served fast", (tier) => {
    expect(parse({ service_tier: tier }).usage.speed).toBe("fast");
  });

  test.each(["default", "flex", "auto", undefined])(
    "does not mark service_tier %s as fast",
    (tier) => {
      const usage = parse(tier === undefined ? {} : { service_tier: tier }).usage;
      expect(usage.speed).not.toBe("fast");
    },
  );
});
