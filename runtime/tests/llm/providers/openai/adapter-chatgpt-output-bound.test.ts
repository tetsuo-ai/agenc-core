import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";

describe("ChatGPT backend execution profile", () => {
  test("declares the documented model maximum in place of a wire output ceiling", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-6.1-sol",
      chatgptBackend: true,
      fetchImpl: vi.fn<typeof fetch>(),
    });

    await expect(provider.getExecutionProfile()).resolves.toMatchObject({
      usageReporting: "authoritative",
      supportsMaxOutputTokens: false,
      modelMaximumOutputTokens: 128_000,
    });
  });

  test("keeps the request ceiling and no model bound on the API route", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-6.1-sol",
      fetchImpl: vi.fn<typeof fetch>(),
    });

    const profile = await provider.getExecutionProfile();
    expect(profile.supportsMaxOutputTokens).toBe(true);
    expect(profile).not.toHaveProperty("modelMaximumOutputTokens");
  });

  test("declares no bound for a model without a documented maximum", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "unlisted-chatgpt-model",
      chatgptBackend: true,
      fetchImpl: vi.fn<typeof fetch>(),
    });

    const profile = await provider.getExecutionProfile();
    expect(profile.supportsMaxOutputTokens).toBe(false);
    expect(profile).not.toHaveProperty("modelMaximumOutputTokens");
  });
});
