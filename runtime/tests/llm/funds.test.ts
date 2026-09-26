import { describe, expect, it } from "vitest";
import { LLMFundsError, LLMManagedAdmissionError } from "../../src/llm/errors.js";
import { isProviderFundsFailure } from "../../src/llm/funds.js";

function wrap(depth: number, inner: unknown): unknown {
  let current: unknown = inner;
  for (let i = 0; i < depth; i += 1) current = { name: "Wrapper", cause: current };
  return current;
}

describe("isProviderFundsFailure", () => {
  it("treats an already-typed funds error as exhausted billing", () => {
    expect(isProviderFundsFailure("openai", new LLMFundsError("openai", 429))).toBe(true);
  });

  it("treats managed credit refusals as funds and capacity as not", () => {
    // The refusal carries HTTP 402, which the "agenc" provider rule already
    // accepts, so the typed-reason rule is only reached under another provider.
    for (const provider of ["agenc", "grok"]) {
      expect(isProviderFundsFailure(provider, new LLMManagedAdmissionError("insufficient_credits")), provider).toBe(true);
      expect(isProviderFundsFailure(provider, new LLMManagedAdmissionError("credits_unavailable")), provider).toBe(true);
      expect(isProviderFundsFailure(provider, new LLMManagedAdmissionError("capacity")), provider).toBe(false);
    }
  });

  it("reads a JSON string body and a cause chain, but not past five wrappers", () => {
    expect(isProviderFundsFailure("openai", {
      status: 402,
      body: '{"error":{"code":"insufficient_credits"}}',
    })).toBe(true);
    expect(isProviderFundsFailure("openai", wrap(4, { name: "LLMFundsError" }))).toBe(true);
    expect(isProviderFundsFailure("openai", wrap(5, { name: "LLMFundsError" }))).toBe(false);
    expect(isProviderFundsFailure("openai", { body: "not-json {broken" })).toBe(false);
  });

  it("classifies provider-specific billing refusals and leaves throttling alone", () => {
    expect(isProviderFundsFailure("DeepSeek", { status: 402 })).toBe(true);
    expect(isProviderFundsFailure("unknown", { status: 402 })).toBe(false);
    expect(isProviderFundsFailure("openai", { status: 429, error: { code: "insufficient_quota" } })).toBe(true);
    expect(isProviderFundsFailure("openai", { status: 429, error: { code: "rate_limit_exceeded" } })).toBe(false);
    expect(isProviderFundsFailure("openai", {
      status: 429,
      error: { message: "You have reached your ChatGPT usage limit" },
    })).toBe(true);
    expect(isProviderFundsFailure("anthropic", {
      error: { message: "Your credit balance is too low to access the Anthropic API" },
    })).toBe(true);
    expect(isProviderFundsFailure("xai", {
      status: 403,
      code: "personal-team-blocked:spending-limit",
    })).toBe(true);
    expect(isProviderFundsFailure("grok", {
      status: 403,
      code: "personal-team-blocked:organization-policy",
    })).toBe(false);
    expect(isProviderFundsFailure("openrouter", {
      status: 429,
      error: { message: "This request requires more credits" },
    })).toBe(true);
  });

  it("treats Gemini daily and free-tier exhaustion as funds, not per-minute quota", () => {
    const exhausted = (quotaId: string) => ({
      status: 429,
      error: {
        status: "RESOURCE_EXHAUSTED",
        details: [{ violations: [{ quotaId }] }],
      },
    });
    expect(isProviderFundsFailure("gemini", exhausted("GenerateContentInputTokensPerModelPerDay-FreeTier"))).toBe(true);
    expect(isProviderFundsFailure("gemini", exhausted("SomeQuota-FreeTier"))).toBe(true);
    expect(isProviderFundsFailure("gemini", exhausted("GenerateContentRequestsPerMinute-FreeTier"))).toBe(false);
    expect(isProviderFundsFailure("gemini", exhausted("GenerateContentRequestsPerMinute"))).toBe(false);
  });
});
