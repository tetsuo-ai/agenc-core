import { describe, expect, it, vi } from "vitest";
import { LLMFundsError, LLMRateLimitError } from "../../src/llm/errors.js";
import { isProviderFundsFailure } from "../../src/llm/funds.js";
import { QwenTokenPlanProvider } from "../../src/llm/providers/qwen/index.js";

// QwenCloud Token Plan refusals documented in the Token Plan FAQ
// (alibabacloud.com/help/en/model-studio/token-plan-faq, read 2026-10-31):
// an exhausted plan quota is HTTP 429 insufficient_quota and blocks every call
// until the monthly reset or a quota pack; ordinary throttling is HTTP 429
// "Requests rate limit exceeded" and clears after about a minute.
const QUOTA = {
  error: {
    message: "Your token-plan quota has been exhausted.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
};
const THROTTLED = {
  error: {
    message: "Requests rate limit exceeded, please try again later.",
    type: "limit_requests",
    code: "limit_requests",
  },
};
// A streamed request receives its refusal as one SSE data frame, as the live
// Token Plan endpoint returned for a rejected parameter (2026-10-31 probe).
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

function provider(fetchImpl: typeof fetch): QwenTokenPlanProvider {
  return new QwenTokenPlanProvider({
    apiKey: "placeholder",
    baseURL: "http://127.0.0.1:1/compatible-mode/v1",
    model: "qwen3.8-max",
    fetchImpl,
  });
}

describe("QwenCloud Token Plan quota exhaustion", () => {
  it("classifies the documented quota refusal as funds, not throttling", () => {
    expect(isProviderFundsFailure("qwen-token-plan", { status: 429, body: QUOTA })).toBe(true);
    expect(isProviderFundsFailure("qwen-token-plan", { status: 429, body: JSON.stringify(QUOTA) })).toBe(true);
    expect(isProviderFundsFailure("qwen-token-plan", { status: 429, body: sse(QUOTA) })).toBe(true);
    expect(isProviderFundsFailure("qwen-token-plan", { cause: { status: 429, body: QUOTA } })).toBe(true);
    // Ordinary throttling stays retryable; other providers are unchanged.
    expect(isProviderFundsFailure("qwen-token-plan", { status: 429, body: THROTTLED })).toBe(false);
    expect(isProviderFundsFailure("qwen-token-plan", { status: 429, body: sse(THROTTLED) })).toBe(false);
    expect(isProviderFundsFailure("qwen-token-plan", { status: 401, body: QUOTA })).toBe(false);
    expect(isProviderFundsFailure("qwen", { status: 429, body: QUOTA })).toBe(false);
    expect(isProviderFundsFailure("deepseek", { status: 429, body: QUOTA })).toBe(false);
  });

  it.each([
    ["buffered", false, JSON.stringify(QUOTA), "application/json"],
    ["streamed JSON", true, JSON.stringify(QUOTA), "application/json"],
    ["streamed SSE", true, sse(QUOTA), "text/event-stream"],
  ])("stops a %s request with one call and a Token Plan quota message", async (_label, streaming, body, type) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(body, { status: 429, headers: { "content-type": type } }));
    const llm = provider(fetchImpl);
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = streaming ? llm.chatStream(messages, () => {}) : llm.chat(messages);
    const error = await result.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(LLMFundsError);
    expect((error as Error).message).toMatch(/Token Plan/);
    expect((error as Error).message).toMatch(/quota/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary Token Plan throttling a retryable rate limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(THROTTLED), { status: 429, headers: { "content-type": "application/json" } }));
    const error = await provider(fetchImpl).chat([{ role: "user", content: "hello" }])
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(LLMRateLimitError);
  });
});
