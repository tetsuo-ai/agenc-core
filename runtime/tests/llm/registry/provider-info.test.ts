import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDER_SCOPE_OMISSIONS,
  listBuiltInProviderInfo,
  resolveBuiltInProviderInfo,
  type BuiltInProviderOnboardingAccess,
  type BuiltInProviderSlug,
} from "./provider-info.js";

describe("built-in provider info", () => {
  it("defines first-run access and ordering for every built-in provider", () => {
    const expected = [
      ["grok", 10, "api-key", false],
      ["openai", 20, "api-key", false],
      ["anthropic", 30, "api-key", false],
      ["ollama", 40, "local", false],
      ["lmstudio", 50, "local", false],
      ["openai-compatible", 60, "local", false],
      ["openrouter", 70, "api-key", true],
      ["groq", 80, "api-key", false],
      ["deepseek", 90, "api-key", false],
      ["gemini", 100, "api-key", false],
      ["mistral", 110, "api-key", false],
      ["nvidia-nim", 120, "api-key", false],
      ["minimax", 130, "api-key", false],
      ["github", 140, "api-key", false],
      ["amazon-bedrock", 150, "api-key", false],
      ["agenc", 160, "managed", false],
    ] as const satisfies readonly (readonly [
      BuiltInProviderSlug,
      number,
      BuiltInProviderOnboardingAccess,
      boolean,
    ])[];

    expect(
      listBuiltInProviderInfo().map((provider) => [
        provider.id,
        provider.onboarding.order,
        provider.onboarding.access,
        provider.onboarding.supportsManagedKeyAccess,
      ]),
    ).toEqual(expected);
    for (const provider of listBuiltInProviderInfo()) {
      expect(provider.requiresManagedAuth).toBe(
        provider.onboarding.access === "managed",
      );
    }
  });

  it("keeps the provider reference exhaustive and access-aligned", () => {
    const reference = readFileSync(
      new URL("../../../../docs/reference/providers.md", import.meta.url),
      "utf8",
    );
    const section = reference.match(
      /^## Built-in providers \((\d+)\)\n(?<body>[\s\S]*?)(?=^## )/mu,
    );
    expect(section?.groups?.body).toBeDefined();

    const documented = [
      ...section!.groups!.body!.matchAll(
        /^\| `([^`]+)` \|.*\| `(api-key|local|managed)` \|$/gmu,
      ),
    ].map((match) => [match[1], match[2]]);
    const registered = listBuiltInProviderInfo().map((provider) => [
      provider.id,
      provider.onboarding.access,
    ]);

    expect(Number(section![1])).toBe(registered.length);
    expect(documented).toEqual(registered);
  });

  it("registers Amazon Bedrock as a SigV4-backed runtime provider", () => {
    expect(resolveBuiltInProviderInfo("amazon-bedrock")).toMatchObject({
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      defaultModel: "amazon.nova-pro-v1:0",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    });
    expect(BUILT_IN_PROVIDER_SCOPE_OMISSIONS).not.toHaveProperty(
      "amazon-bedrock",
    );
  });
});
