import { describe, expect, test } from "vitest";

import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import {
  resolveProviderModelSelection,
  type SessionSelection,
} from "../../src/session/provider-model-selection.js";
import { ModelNotAllowedError } from "../../src/utils/model/modelAllowlist.js";

const CURRENT: SessionSelection = Object.freeze({
  provider: "grok",
  model: "grok-4.6",
});

describe("session provider/model policy boundary", () => {
  test("allows selection when managed policy is absent", () => {
    expect(
      resolveProviderModelSelection(defaultConfig(), CURRENT, {
        model_provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      providerChanged: true,
    });
  });

  test("allows only models admitted by the final managed policy", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["gpt-5"],
    });
    expect(
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "openai",
        model: "gpt-5",
      }),
    ).toMatchObject({ provider: "openai", model: "gpt-5" });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "grok",
        model: "grok-4.6",
      })
    ).toThrow(ModelNotAllowedError);
  });

  test("treats an explicit empty allowlist as deny-all", () => {
    const config = mergeConfigs(defaultConfig(), { availableModels: [] });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model: "grok-4.6",
      })
    ).toThrow(/managed availableModels policy/u);
  });

  test("rejects a provider-only switch when its resolved default is forbidden", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["grok-4.6"],
    });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "openai",
      })
    ).toThrow(/model 'gpt-5' is not allowed/u);
  });

  test("uses collision-safe policy IDs without storing them in session state", () => {
    const config = mergeConfigs(defaultConfig(), {
      availableModels: ["github:copilot:gpt-5.3-codex"],
    });
    expect(
      resolveProviderModelSelection(config, CURRENT, {
        model_provider: "github",
        model: "gpt-5.3-codex",
      }),
    ).toMatchObject({
      provider: "github",
      model: "gpt-5.3-codex",
    });
    expect(() =>
      resolveProviderModelSelection(config, CURRENT, {
        model: "gpt-5.3-codex",
      })
    ).toThrow(ModelNotAllowedError);
  });
});
