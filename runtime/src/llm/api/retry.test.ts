import { describe, expect, test, vi } from "vitest";
import { AgenCApiError } from "./errors.js";
import {
  CannotRetryError,
  RetryAfterTooLongError,
  getRateLimitResetDelayMs,
  getRetryDelay,
  is529Error,
  parseMaxTokensContextOverflowError,
  parseOpenAIDuration,
  type RetryContext,
  withRetry,
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

  test("parses OpenAI-compatible reset durations", () => {
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

  test("retries transient API failures then returns success", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new AgenCApiError("try again", {
            status: 503,
            headers: new Headers(),
          });
        }
        return "ok";
      },
      {
        maxRetries: 1,
        random: () => 0,
        sleep,
        onRetry,
      },
    );

    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(500, undefined);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 500 }),
    );
  });

  test("carries a max-token override after context-overflow retry", async () => {
    const contexts: RetryContext[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(
      async (context) => {
        contexts.push(context);
        if (context.attempt === 1) {
          throw {
            status: 400,
            message:
              "input length and `max_tokens` exceed context limit: 6000 + 5000 > 10000",
          };
        }
        return context.maxTokensOverride;
      },
      { maxRetries: 1, sleep, random: () => 0 },
    );

    expect(result).toBe(3000);
    expect(contexts[0]?.maxTokensOverride).toBeUndefined();
    expect(contexts[1]).toMatchObject({
      maxTokensOverride: 3000,
      maxTokensContextOverflow: {
        inputTokens: 6000,
        maxTokens: 5000,
        contextLimit: 10000,
      },
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  test("lets callers opt out of generic 5xx retries", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new AgenCApiError("server unavailable", { status: 503 });
        },
        {
          maxRetries: 1,
          retryStatuses: [],
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);

    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("aborts instead of sleeping beyond the Retry-After cap", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(
        async () => {
          throw new AgenCApiError("slow down", {
            status: 429,
            headers: new Headers({ "retry-after": "301" }),
          });
        },
        {
          maxRetries: 1,
          sleep,
          emitWarning: (warning) => warnings.push(warning),
        },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);

    expect(sleep).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      expect.objectContaining({ cause: "retry_after_exceeds_max_wait" }),
    ]);
  });

  test("does not retry abort errors", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const abortError = new DOMException("aborted", "AbortError");

    await expect(
      withRetry(
        async () => {
          throw abortError;
        },
        { maxRetries: 1, sleep },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);

    expect(sleep).not.toHaveBeenCalled();
  });
});
