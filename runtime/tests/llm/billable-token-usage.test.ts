import { describe, expect, it } from "vitest";

import { billableTokenUsage } from "../../src/llm/usage.js";
import type { LLMUsage } from "../../src/llm/types.js";

function usage(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, ...overrides };
}

describe("billableTokenUsage", () => {
  it("keeps OpenAI-compatible cache counters inside promptTokens", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 131, completionTokens: 5, totalTokens: 136,
      cachedInputTokens: 100, cacheCreationInputTokens: 20, reasoningOutputTokens: 4,
    }))).toEqual({ inputTokens: 131, outputTokens: 5 });
  });

  it("adds Anthropic cache reads and writes that sit outside promptTokens", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 11, completionTokens: 5, totalTokens: 16,
      cachedInputTokens: 100, cacheCreationInputTokens: 20,
      cacheInputExcludedFromPrompt: true,
    }))).toEqual({ inputTokens: 131, outputTokens: 5 });
  });

  it("charges a cache-only Anthropic prefix when promptTokens is zero", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 0, completionTokens: 5, totalTokens: 5,
      cachedInputTokens: 111, cacheCreationInputTokens: 20,
      cacheInputExcludedFromPrompt: true,
    }))).toEqual({ inputTokens: 131, outputTokens: 5 });
  });

  it("counts inclusive reasoning once and exclusive reasoning when it exceeds completion", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 120, completionTokens: 348, totalTokens: 468, reasoningOutputTokens: 312,
    }))).toEqual({ inputTokens: 120, outputTokens: 348 });
    expect(billableTokenUsage(usage({
      promptTokens: 10, completionTokens: 10, totalTokens: 40, reasoningOutputTokens: 20,
    }))).toEqual({ inputTokens: 20, outputTokens: 20 });
  });

  it("uses totalTokens as a backstop when prompt plus completion undercounts", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 10, completionTokens: 5, totalTokens: 100,
    }))).toEqual({ inputTokens: 95, outputTokens: 5 });
  });

  it("treats omitted cache and reasoning counters as zero", () => {
    expect(billableTokenUsage(usage({
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
    }))).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
