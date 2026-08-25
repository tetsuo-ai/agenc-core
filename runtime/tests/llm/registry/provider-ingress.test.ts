import { describe, expect, it } from "vitest";

import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "./provider-ingress.js";
import { BUILT_IN_PROVIDER_DEFINITIONS } from "./provider-info.js";

describe("provider environment ingress", () => {
  it("resolves every declared key and endpoint alias", () => {
    for (const [provider, definition] of Object.entries(
      BUILT_IN_PROVIDER_DEFINITIONS,
    )) {
      for (const envVar of definition.apiKeyEnvVars) {
        expect(
          resolveProviderApiKeyEnvironment(provider, {
            [envVar]: `  ${provider}-key  `,
          }),
        ).toEqual({ envVar, value: `${provider}-key` });
      }
      for (const envVar of definition.baseURLEnvVars) {
        expect(
          resolveProviderBaseURLEnvironment(provider, {
            [envVar]: `  https://${provider}.example/v1  `,
          }),
        ).toEqual({ envVar, value: `https://${provider}.example/v1` });
      }
    }
  });

  it("uses registry order and skips empty values", () => {
    expect(
      resolveProviderApiKeyEnvironment("grok", {
        XAI_API_KEY: "  ",
        GROK_API_KEY: " grok-key ",
      }),
    ).toEqual({ envVar: "GROK_API_KEY", value: "grok-key" });
    expect(
      resolveProviderApiKeyEnvironment("gemini", {
        GEMINI_API_KEY: "first",
        GOOGLE_API_KEY: "second",
      }),
    ).toEqual({ envVar: "GEMINI_API_KEY", value: "first" });
    expect(
      resolveProviderBaseURLEnvironment("openai-compatible", {
        OPENAI_COMPATIBLE_BASE_URL: "",
        OPENAI_BASE_URL: "  ",
        OPENAI_API_BASE: " https://compatible.example/v1 ",
      }),
    ).toEqual({
      envVar: "OPENAI_API_BASE",
      value: "https://compatible.example/v1",
    });
  });

  it("does not leak aliases across providers", () => {
    expect(
      resolveProviderApiKeyEnvironment("lmstudio", {
        OPENAI_API_KEY: "not-an-lm-studio-key",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderBaseURLEnvironment("lmstudio", {
        OPENAI_BASE_URL: "https://not-lm-studio.example/v1",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderApiKeyEnvironment("agenc", {
        AGENC_API_KEY: "managed-auth-not-byok",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderApiKeyEnvironment("unknown", {
        OPENAI_API_KEY: "ignored",
      }),
    ).toBeUndefined();
  });
});
