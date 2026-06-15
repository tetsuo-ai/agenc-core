import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getHardcodedTeammateModelFallback } from "../../../src/utils/swarm/teammateModel.js";

const providerEnvKeys = [
  "AGENC_USE_GEMINI",
  "AGENC_USE_GITHUB",
  "AGENC_USE_MINIMAX",
  "AGENC_USE_MISTRAL",
  "AGENC_USE_OPENAI",
  "MINIMAX_API_KEY",
  "MISTRAL_MODEL",
  "NVIDIA_MODEL",
  "NVIDIA_NIM",
  "OPENAI_MODEL",
  "XAI_API_KEY",
] as const;

const originalProviderEnv = Object.fromEntries(
  providerEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof providerEnvKeys)[number], string | undefined>;

function clearProviderEnv(): void {
  for (const key of providerEnvKeys) {
    delete process.env[key];
  }
}

function restoreProviderEnv(): void {
  clearProviderEnv();
  for (const [key, value] of Object.entries(originalProviderEnv)) {
    if (value !== undefined) {
      process.env[key as (typeof providerEnvKeys)[number]] = value;
    }
  }
}

describe("getHardcodedTeammateModelFallback", () => {
  beforeEach(() => {
    clearProviderEnv();
  });

  afterEach(() => {
    restoreProviderEnv();
  });

  test("resolves a concrete xAI fallback when xAI is the active provider", () => {
    process.env.XAI_API_KEY = "xai-test-key";

    expect(getHardcodedTeammateModelFallback()).toBe("grok-4.3");
  });

  test("resolves a concrete Mistral fallback when Mistral is the active provider", () => {
    process.env.AGENC_USE_MISTRAL = "1";

    expect(getHardcodedTeammateModelFallback()).toBe("devstral-latest");
  });
});
