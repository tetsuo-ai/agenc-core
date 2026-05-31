import { describe, expect, test } from "vitest";
import {
  RetryAfterTooLongError,
  getRateLimitResetDelayMs,
  getRetryDelay,
  is529Error,
  parseMaxTokensContextOverflowError,
  parseOpenAIDuration,
} from "./retry.js";

describe("llm api retry", () => {
  test("computes exponential delay with donor-compatible jitter", () => {
    expect(getRetryDelay(1, undefined, 32_000, () => 0)).toBe(500);
    expect(getRetryDelay(3, undefined, 32_000, () => 0.25)).toBe(2125);
  });

  test("honors Retry-After seconds and caps unbounded waits", () => {
    expect(getRetryDelay(2, "4", 32_000, () => 0)).toBe(4000);
    expect(() => getRetryDelay(2, "301", 32_000, () => 0)).toThrow(
      RetryAfterTooLongError,
    );
  });

  test("parses context-overflow token counts from provider messages", () => {
    expect(
      parseMaxTokensContextOverflowError({
        status: 400,
        message:
          "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000",
      }),
    ).toEqual({
      inputTokens: 188059,
      maxTokens: 20000,
      contextLimit: 200000,
    });
  });

  test("detects overloaded 529 errors by status or body marker", () => {
    expect(is529Error({ status: 529, message: "overloaded" })).toBe(true);
    expect(
      is529Error({
        status: 500,
        message: "{\"type\":\"overloaded_error\"}",
      }),
    ).toBe(true);
  });

  test("parses compatible-provider reset durations", () => {
    expect(parseOpenAIDuration("500ms")).toBe(500);
    expect(parseOpenAIDuration("6m0s")).toBe(360_000);
    expect(parseOpenAIDuration("1h30m0s")).toBe(5_400_000);
    expect(parseOpenAIDuration("")).toBeNull();
  });

  test("uses the larger request/token reset delay for compatible providers", () => {
    expect(
      getRateLimitResetDelayMs(
        {
          "x-ratelimit-reset-requests": "1s",
          "x-ratelimit-reset-tokens": "2m",
        },
        "openai_compatible",
      ),
    ).toBe(120_000);
  });
});
