import { describe, expect, test } from "vitest";

import { parseAnthropicMessagesResponse } from "./messages-anthropic.js";

const MODEL = "claude-sonnet-4.5";

function parseUsage(usage: Record<string, unknown>) {
  return parseAnthropicMessagesResponse(
    MODEL,
    {
      model: MODEL,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage,
    },
    { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [] },
  ).usage;
}

describe("parseAnthropicMessagesResponse cache totals (#2772)", () => {
  test("adds cache reads and writes on top of ordinary input and output", () => {
    // Ordinary input 120 plus cache 3,072 is the review example: a total of
    // 468 (120 + 348) drops the cache tokens, and admission then charges
    // 3,072 input tokens instead of 3,192.
    expect(parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      cache_read_input_tokens: 2048,
      cache_creation_input_tokens: 1024,
    })).toMatchObject({
      promptTokens: 120,
      completionTokens: 348,
      cachedInputTokens: 2048,
      cacheCreationInputTokens: 1024,
      totalTokens: 3540,
    });
  });

  test("keeps a cache-free total as ordinary input plus output", () => {
    expect(parseUsage({
      input_tokens: 120,
      output_tokens: 348,
    }).totalTokens).toBe(468);
  });

  test("keeps an explicit zero cache count without changing the total", () => {
    expect(parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })).toMatchObject({
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 468,
    });
  });

  test("ignores non-numeric cache fields", () => {
    const usage = parseUsage({
      input_tokens: 120,
      output_tokens: 348,
      cache_read_input_tokens: "2048",
      cache_creation_input_tokens: Number.NaN,
    });
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.cacheCreationInputTokens).toBeUndefined();
    expect(usage.totalTokens).toBe(468);
  });
});
