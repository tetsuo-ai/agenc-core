import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { resolveStartupSelection } from "./startup-selection.js";

describe("resolveStartupSelection", () => {
  it("uses Bedrock model env when selected by provider", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "amazon-bedrock",
        AWS_BEDROCK_MODEL: "amazon.nova-lite-v1:0",
        AWS_ACCESS_KEY_ID: "bedrock-access-key",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("amazon-bedrock");
    expect(resolved.model).toBe("amazon.nova-lite-v1:0");
    expect(resolved.apiKey).toBe("bedrock-access-key");
  });

  it("resolves config.model over providers.grok.default_model (config set model is honored)", () => {
    // Regression for the daemon-session model bug: with config.model set via
    // `agenc config set model` and a `[providers.grok] default_model`, the
    // session/startup resolution (which seeds collaborationMode.model) must
    // resolve to the configured model, not the provider default.
    const resolved = resolveStartupSelection({
      config: {
        ...defaultConfig(),
        model: "grok-build-0.1",
        model_provider: "grok",
        providers: { grok: { default_model: "grok-4.3" } },
      },
      env: {},
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-build-0.1");
  });

  it("falls back to grok-4.3 when no config.model is set", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {},
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-4.3");
  });
});
