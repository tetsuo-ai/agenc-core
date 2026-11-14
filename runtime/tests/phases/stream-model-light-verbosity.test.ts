import { describe, expect, test } from "vitest";

import { buildProviderOptions } from "../../src/phases/stream-model.js";

function optionsFor(provider: string, model: string, lightMode: boolean, configured?: "low" | "medium" | "high") {
  const session = {
    conversationId: "light-verbosity",
    config: { model },
    services: {
      provider: { name: provider },
      runtimeOptions: { lightMode },
    },
  };
  const ctx = {
    modelInfo: { slug: model },
    ...(configured !== undefined ? { modelVerbosity: configured } : {}),
  };
  const request = { tools: [], parallelToolCalls: false, baseInstructions: "SYSTEM" };
  return buildProviderOptions(request as never, ctx as never, new AbortController().signal, session as never);
}

describe("buildProviderOptions response detail default", () => {
  test("Light sessions on the GPT-6 family default to low verbosity", () => {
    expect(optionsFor("openai", "gpt-6.1-sol", true).modelVerbosity).toBe("low");
    expect(optionsFor("openai", "gpt-6.1-terra", true).modelVerbosity).toBe("low");
  });

  test("a configured level wins and other routes keep no default", () => {
    expect(optionsFor("openai", "gpt-6.1-sol", true, "high").modelVerbosity).toBe("high");
    expect(optionsFor("openai", "gpt-6.1-sol", false).modelVerbosity).toBeUndefined();
    expect(optionsFor("deepseek", "deepseek-flash", true).modelVerbosity).toBeUndefined();
    expect(optionsFor("openai", "gpt-5", true).modelVerbosity).toBeUndefined();
  });
});
