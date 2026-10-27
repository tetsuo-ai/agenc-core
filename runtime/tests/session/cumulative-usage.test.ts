import { describe, expect, test } from "vitest";

import type { LLMUsage } from "../../src/llm/types.js";
import { cumulativeUsage } from "../../src/session/cumulative-usage.js";

function usage(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    ...overrides,
  };
}

describe("cumulativeUsage", () => {
  test("returns the accumulator when the next sample is missing", () => {
    const acc = usage();
    expect(cumulativeUsage(acc, undefined)).toBe(acc);
  });

  test("adds required token fields and treats missing optional counts as zero", () => {
    expect(
      cumulativeUsage(usage(), usage({
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      })),
    ).toEqual({
      promptTokens: 13,
      completionTokens: 6,
      totalTokens: 19,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
    });
  });

  test("omits the 1h cache field until either side reports it", () => {
    const withoutField = cumulativeUsage(usage(), usage());
    expect(withoutField).not.toHaveProperty("cacheCreation1hInputTokens");

    expect(
      cumulativeUsage(usage({ cacheCreation1hInputTokens: 7 }), usage()),
    ).toMatchObject({ cacheCreation1hInputTokens: 7 });

    expect(
      cumulativeUsage(usage(), usage({ cacheCreation1hInputTokens: 5 })),
    ).toMatchObject({ cacheCreation1hInputTokens: 5 });

    expect(
      cumulativeUsage(
        usage({ cacheCreation1hInputTokens: 7 }),
        usage({ cacheCreation1hInputTokens: 5 }),
      ),
    ).toMatchObject({ cacheCreation1hInputTokens: 12 });
  });

  test("sums optional cache, reasoning, and search counters when present", () => {
    expect(
      cumulativeUsage(
        usage({
          cachedInputTokens: 2,
          cacheCreationInputTokens: 3,
          reasoningOutputTokens: 8,
          webSearchRequests: 1,
        }),
        usage({
          cachedInputTokens: 4,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 2,
          webSearchRequests: 3,
        }),
      ),
    ).toMatchObject({
      cachedInputTokens: 6,
      cacheCreationInputTokens: 4,
      reasoningOutputTokens: 10,
      webSearchRequests: 4,
    });
  });
});
