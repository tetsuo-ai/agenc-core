import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getHardcodedTeammateModelFallback } from "../../../src/utils/swarm/teammateModel.js";
import { runWithStartupProviderSelection } from "../../../src/utils/model/providers.js";

const providerEnvKeys = [
  "AGENC_PROVIDER",
  "MINIMAX_API_KEY",
  "MISTRAL_MODEL",
  "NVIDIA_MODEL",
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
    process.env.AGENC_PROVIDER = "grok";
    process.env.XAI_API_KEY = "xai-test-key";

    expect(
      runWithStartupProviderSelection(
        { provider: "grok", model: "grok-4.6", environment: { ...process.env } },
        getHardcodedTeammateModelFallback,
      ),
    ).toBe("grok-4.3");
  });

  test("resolves a concrete Mistral fallback when Mistral is the active provider", () => {
    process.env.AGENC_PROVIDER = "mistral";

    expect(
      runWithStartupProviderSelection(
        { provider: "mistral", model: "mistral-medium-latest", environment: { ...process.env } },
        getHardcodedTeammateModelFallback,
      ),
    ).toBe("mistral-medium-latest");
  });
});
