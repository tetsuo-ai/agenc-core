import { describe, expect, it, vi } from "vitest";
import { LLMFundsError } from "../../src/llm/errors.js";
import { isProviderFundsFailure } from "../../src/llm/funds.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";

// Authenticated Qwen PAYG refusal observed in the real 0.19.11 CLI. This
// account can list models, but free-tier-only mode prevents paid inference.
const refusal = {
  error: {
    code: "AllocationQuota.FreeTierOnly",
    type: "AllocationQuota.FreeTierOnly",
    message: "The free quota has been exhausted. Please complete your payment information or disable use free tier only mode.",
  },
};

describe("Qwen free-tier-only billing refusal", () => {
  it("recognizes the exact PAYG code without broadening auth or rate limits", () => {
    expect(isProviderFundsFailure("qwen", { status: 403, body: refusal })).toBe(true);
    expect(isProviderFundsFailure("qwen", { status: 403, body: JSON.stringify(refusal) })).toBe(true);
    expect(isProviderFundsFailure("qwen", { cause: { status: 403, body: refusal } })).toBe(true);
    expect(isProviderFundsFailure("qwen", { status: 401, body: refusal })).toBe(false);
    expect(isProviderFundsFailure("qwen", { status: 403, body: { error: { code: "invalid_api_key" } } })).toBe(false);
    expect(isProviderFundsFailure("qwen", { status: 429, body: { error: { code: "Throttling.RateQuota" } } })).toBe(false);
    expect(isProviderFundsFailure("openai", { status: 403, body: refusal })).toBe(false);
    expect(isProviderFundsFailure("qwen-token-plan", { status: 403, body: refusal })).toBe(false);
  });

  it.each([false, true])("stops %s streaming with a funds error after one request", async (streaming) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(refusal), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));
    const provider = new OpenAIProvider({ providerName: "qwen", apiKey: "placeholder",
      baseURL: "http://127.0.0.1:1/v1", model: "qwen3.8-max", fetchImpl });
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = streaming ? provider.chatStream(messages, () => {}) : provider.chat(messages);
    await expect(result).rejects.toBeInstanceOf(LLMFundsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
