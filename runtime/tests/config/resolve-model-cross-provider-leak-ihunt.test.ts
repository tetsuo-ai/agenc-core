/**
 * Revert-sensitive regression for the cross-provider model leak in
 * configuredModelForProvider (runtime/src/config/resolve-model.ts).
 *
 * Bug: when `model_provider` is unset, the fall-through only blocked grok-family
 * models from non-grok providers. A model registered exclusively to ANOTHER
 * provider (e.g. openai's "gpt-5") was returned for any queried provider, so it
 * leaked into a provider that cannot serve it (the API rejects the turn).
 *
 * Fix: generalize the guard — a model registered to some provider other than the
 * queried one is rejected, regardless of which provider owns it. Models with no
 * registered owner still fall through to the queried provider.
 *
 * Each assertion that pins the foreign-leak fix fails if the fix is reverted:
 * the old code returned the model instead of `undefined` for these cases.
 */

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/config/schema.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { configuredModelForProvider } from "../../src/config/resolve-model.js";

function configWithModelNoProvider(model: string): AgenCConfig {
  // Top-level model set, but `model_provider` absent — the exact condition the
  // cross-provider leak guard protects.
  return {
    ...defaultConfig(),
    model,
    model_provider: undefined,
  } as unknown as AgenCConfig;
}

describe("configuredModelForProvider: cross-provider leak guard", () => {
  it("does not leak an openai-owned model to a non-openai provider", () => {
    // "gpt-5" is registered exclusively to openai. With model_provider unset,
    // the reverted (grok-only) guard returned it for anthropic. The fix returns
    // undefined so anthropic falls back to its own default instead.
    const config = configWithModelNoProvider("gpt-5");
    expect(configuredModelForProvider(config, "anthropic")).toBeUndefined();
    expect(configuredModelForProvider(config, "grok")).toBeUndefined();
  });

  it("does not leak a prefixed openai-owned model to another provider", () => {
    // Namespaced/prefixed openai id still resolves to the openai family.
    const config = configWithModelNoProvider("gpt-5.4-mini-2025");
    expect(configuredModelForProvider(config, "anthropic")).toBeUndefined();
  });

  it("still offers an openai-owned model to openai itself", () => {
    const config = configWithModelNoProvider("gpt-5");
    expect(configuredModelForProvider(config, "openai")).toBe("gpt-5");
  });

  it("still blocks a grok-owned model from a non-grok provider", () => {
    // Preserves the original grok-family protection.
    const config = configWithModelNoProvider("grok-build-0.1");
    expect(configuredModelForProvider(config, "openai")).toBeUndefined();
    expect(configuredModelForProvider(config, "anthropic")).toBeUndefined();
  });

  it("still offers a grok-owned model to grok itself", () => {
    const config = configWithModelNoProvider("grok-build-0.1");
    expect(configuredModelForProvider(config, "grok")).toBe("grok-build-0.1");
  });

  it("does not treat an un-catalogued model as foreign (no registered owner)", () => {
    // A model registered to NO provider must still fall through to the queried
    // provider — this is the same-provider behaviour the existing drift test
    // (model-catalog-drift.test.ts:89) relies on. The fix must not over-block.
    const config = configWithModelNoProvider("some-unknown-model");
    expect(configuredModelForProvider(config, "openai")).toBe("some-unknown-model");
    expect(configuredModelForProvider(config, "anthropic")).toBe(
      "some-unknown-model",
    );
  });
});
