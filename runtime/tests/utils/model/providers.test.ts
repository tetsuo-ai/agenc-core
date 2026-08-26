import { afterEach, expect, test } from "bun:test";
import {
  getAPIProvider,
  isGithubNativeAnthropicMode,
  type ProviderRuntimeSelection,
  runWithStartupProviderSelection,
  usesAnthropicAccountFlow,
} from "../../../src/utils/model/providers.ts";

function selection(
  provider: string,
  model = "test-model",
): ProviderRuntimeSelection {
  return { provider, model, environment: Object.freeze({ ...process.env }) };
}

const originalEnv = {
  AGENC_PROVIDER: process.env.AGENC_PROVIDER,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
};

afterEach(() => {
  for (const key of Object.keys(originalEnv) as Array<
    keyof typeof originalEnv
  >) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearProviderEnv(): void {
  delete process.env.AGENC_PROVIDER;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.XAI_API_KEY;
}

test("explicit provider lookup does not depend on ambient selectors", () => {
  clearProviderEnv();
  expect(getAPIProvider("grok")).toBe("xai");
  expect(usesAnthropicAccountFlow("grok")).toBe(false);
});

test.each([
  ["anthropic", "firstParty", true],
  ["amazon-bedrock", "firstParty", true],
  ["openai", "openai", false],
  ["openai-compatible", "openai", false],
  ["github", "github", false],
  ["gemini", "gemini", false],
  ["mistral", "mistral", false],
  ["minimax", "minimax", false],
  ["nvidia-nim", "nvidia-nim", false],
  ["agenc", "agenc", false],
  ["grok", "xai", false],
] as const)(
  "canonical startup provider %s selects exactly one provider authority",
  (provider, apiProvider, usesAccountFlow) => {
    clearProviderEnv();
    runWithStartupProviderSelection(selection(provider), () => {
      expect(getAPIProvider()).toBe(apiProvider);
      expect(usesAnthropicAccountFlow()).toBe(usesAccountFlow);
    });
  },
);

test("credentials never select a provider", () => {
  clearProviderEnv();
  process.env.MINIMAX_API_KEY = "minimax-test-key";
  process.env.XAI_API_KEY = "xai-test-key";

  runWithStartupProviderSelection(selection("grok"), () => {
    expect(getAPIProvider()).toBe("xai");
  });
  runWithStartupProviderSelection(selection("openai"), () => {
    expect(getAPIProvider()).toBe("openai");
  });
});

test("provider selection is not inferred from an unknown model identifier", () => {
  clearProviderEnv();

  runWithStartupProviderSelection(selection("openai", "custom-model"), () => {
    expect(getAPIProvider()).toBe("openai");
  });
});

test("isGithubNativeAnthropicMode is false outside a GitHub session", () => {
  clearProviderEnv();
  runWithStartupProviderSelection(
    selection("openai", "claude-sonnet-4-5"),
    () => {
      expect(isGithubNativeAnthropicMode("claude-sonnet-4-5")).toBe(false);
    },
  );
});

test.each([
  ["claude-sonnet-4-5", true],
  ["github:copilot:claude-sonnet-4", true],
  ["claude-haiku-4-5", true],
  ["github:copilot", false],
  ["gpt-4o", false],
  ["github:copilot:gpt-4o", false],
] as const)(
  "GitHub native-mode detection uses the required resolved model %s",
  (resolvedModel, expected) => {
    clearProviderEnv();
    runWithStartupProviderSelection(
      selection("github", "ambient-ignored"),
      () => {
        expect(isGithubNativeAnthropicMode(resolvedModel)).toBe(expected);
      },
    );
  },
);

test("post-capture process env mutation cannot change startup provider authority", async () => {
  clearProviderEnv();
  await runWithStartupProviderSelection(selection("github"), async () => {
    process.env.AGENC_PROVIDER = "anthropic";
    await Promise.resolve();
    expect(getAPIProvider()).toBe("github");

    process.env.AGENC_PROVIDER = "openai";
    await Promise.resolve();
    expect(getAPIProvider()).toBe("github");
  });
});
