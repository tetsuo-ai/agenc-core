import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  listBuiltInProviderInfo,
  providerApiKeyEnvironmentLabel,
  providerCredentialEnvironmentLabel,
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderRegionalEndpoint,
} from "./provider-info.js";

describe("built-in provider info", () => {
  it("defines every provider field and ordered ingress alias exactly once", () => {
    const expected = [
      ["grok", "xAI Grok", "grok-4.6", "https://api.x.ai/v1", "api-key", ["XAI_API_KEY", "GROK_API_KEY"], ["XAI_BASE_URL", "GROK_BASE_URL"], 10, "api-key", false],
      ["openai", "OpenAI", "gpt-5", "https://api.openai.com/v1", "api-key", ["OPENAI_API_KEY"], ["OPENAI_BASE_URL", "OPENAI_API_BASE"], 20, "api-key", false],
      ["anthropic", "Anthropic", "claude-opus-4-7", "https://api.anthropic.com/v1", "api-key", ["ANTHROPIC_API_KEY"], ["ANTHROPIC_BASE_URL"], 30, "api-key", false],
      ["ollama", "Ollama", "llama3.3", "http://localhost:11434", "none", [], ["OLLAMA_BASE_URL"], 40, "local", false],
      ["lmstudio", "LM Studio", "gpt-4o-mini", "http://localhost:1234/v1", "api-key", ["LMSTUDIO_API_KEY"], ["LMSTUDIO_BASE_URL"], 50, "local", false],
      ["openai-compatible", "OpenAI-compatible", "local-model", "http://localhost:8000/v1", "api-key", ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"], ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"], 60, "local", false],
      ["openrouter", "OpenRouter", "x-ai/grok-4.5", "https://openrouter.ai/api/v1", "api-key", ["OPENROUTER_API_KEY"], ["OPENROUTER_BASE_URL"], 70, "api-key", true],
      ["groq", "Groq", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1", "api-key", ["GROQ_API_KEY"], ["GROQ_BASE_URL"], 80, "api-key", false],
      ["deepseek", "DeepSeek", "deepseek-v4-flash", "https://api.deepseek.com/v1", "api-key", ["DEEPSEEK_API_KEY"], ["DEEPSEEK_BASE_URL"], 90, "api-key", false],
      ["gemini", "Gemini", "gemini-3.1-pro-preview", "https://generativelanguage.googleapis.com/v1beta", "api-key", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], ["GEMINI_BASE_URL"], 100, "api-key", false],
      ["mistral", "Mistral", "mistral-medium-latest", "https://api.mistral.ai/v1", "api-key", ["MISTRAL_API_KEY"], ["MISTRAL_BASE_URL"], 110, "api-key", false],
      ["nvidia-nim", "NVIDIA NIM", "nvidia/llama-3.1-nemotron-70b-instruct", "https://integrate.api.nvidia.com/v1", "api-key", ["NVIDIA_API_KEY"], ["NVIDIA_BASE_URL"], 120, "api-key", false],
      ["minimax", "MiniMax", "MiniMax-M2.5", "https://api.minimax.io/v1", "api-key", ["MINIMAX_API_KEY"], ["MINIMAX_BASE_URL"], 130, "api-key", false],
      ["github", "GitHub Copilot", "gpt-5.3-codex", "https://api.githubcopilot.com", "api-key", ["GITHUB_TOKEN", "GH_TOKEN"], ["GITHUB_BASE_URL"], 140, "api-key", false],
      ["amazon-bedrock", "Amazon Bedrock", "amazon.nova-pro-v1:0", "https://bedrock-runtime.us-east-1.amazonaws.com", "aws-sigv4", [], ["AWS_BEDROCK_BASE_URL"], 150, "environment", false],
      ["agenc", "AgenC", "agenc", "https://id.agenc.ag/v1", "none", [], ["AGENC_BASE_URL"], 160, "managed", false],
    ] as const;

    expect(
      listBuiltInProviderInfo().map((provider) => [
        provider.id,
        provider.name,
        provider.defaultModel,
        provider.baseURL,
        provider.credentials.kind,
        provider.credentials.kind === "api-key"
          ? provider.credentials.apiKey.envVars
          : [],
        provider.baseURLEnvVars,
        provider.onboarding.order,
        provider.onboarding.access,
        provider.onboarding.supportsManagedKeyAccess,
      ]),
    ).toEqual(expected);
    for (const provider of listBuiltInProviderInfo()) {
      expect(Object.isFrozen(BUILT_IN_PROVIDER_DEFINITIONS[provider.id])).toBe(true);
      expect(Object.isFrozen(provider.credentials)).toBe(true);
      expect(Object.isFrozen(provider.baseURLEnvVars)).toBe(true);
      expect(new Set(provider.baseURLEnvVars).size).toBe(provider.baseURLEnvVars.length);
      if (provider.credentials.kind === "api-key") {
        expect(Object.isFrozen(provider.credentials.apiKey)).toBe(true);
        expect(Object.isFrozen(provider.credentials.apiKey.envVars)).toBe(true);
        expect(new Set(provider.credentials.apiKey.envVars).size).toBe(
          provider.credentials.apiKey.envVars.length,
        );
      } else if (provider.credentials.kind === "aws-sigv4") {
        for (const field of [
          provider.credentials.accessKeyId,
          provider.credentials.secretAccessKey,
          provider.credentials.sessionToken,
        ]) {
          expect(Object.isFrozen(field)).toBe(true);
          expect(Object.isFrozen(field.envVars)).toBe(true);
          expect(new Set(field.envVars).size).toBe(field.envVars.length);
        }
        expect(Object.isFrozen(provider.credentials.regionEnvVars)).toBe(true);
        expect(new Set(provider.credentials.regionEnvVars).size).toBe(
          provider.credentials.regionEnvVars.length,
        );
      }
      expect(provider.supportsApiKeylessAuth).toBe(
        provider.id === "openai" || provider.id === "gemini",
      );
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
        /^\| `([^`]+)` \|.*\| `(api-key|environment|local|managed)` \|$/gmu,
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
      credentials: {
        kind: "aws-sigv4",
        accessKeyId: {
          envVars: ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
          required: true,
        },
        secretAccessKey: {
          envVars: [
            "AWS_BEDROCK_SECRET_ACCESS_KEY",
            "AWS_SECRET_ACCESS_KEY",
          ],
          required: true,
        },
        sessionToken: {
          envVars: ["AWS_BEDROCK_SESSION_TOKEN", "AWS_SESSION_TOKEN"],
          required: false,
        },
        regionEnvVars: [
          "AWS_BEDROCK_REGION",
          "AWS_REGION",
          "AWS_DEFAULT_REGION",
        ],
      },
      onboarding: { access: "environment" },
    });
    const defaultEndpoint = resolveBuiltInProviderRegionalEndpoint(
      "amazon-bedrock",
    );
    expect(defaultEndpoint).toEqual({
      region: "us-east-1",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
    });
    expect(Object.isFrozen(defaultEndpoint)).toBe(true);
    expect(
      resolveBuiltInProviderRegionalEndpoint(
        "amazon-bedrock",
        " ca-central-1 ",
      ),
    ).toEqual({
      region: "ca-central-1",
      baseURL: "https://bedrock-runtime.ca-central-1.amazonaws.com",
    });
    expect(
      resolveBuiltInProviderRegionalEndpoint("amazon-bedrock", "   "),
    ).toEqual(defaultEndpoint);
    expect(resolveBuiltInProviderRegionalEndpoint("openai")).toBeUndefined();
    expect(resolveBuiltInProviderRegionalEndpoint("unknown")).toBeUndefined();
    expect(
      Object.isFrozen(
        BUILT_IN_PROVIDER_DEFINITIONS["amazon-bedrock"].regionalEndpoint,
      ),
    ).toBe(true);
    expect(defaultEndpoint?.baseURL).toBe(
      BUILT_IN_PROVIDER_DEFINITIONS["amazon-bedrock"].baseURL,
    );
  });

  it("formats API-key guidance from the ordered registry aliases", () => {
    expect(providerApiKeyEnvironmentLabel("grok")).toBe(
      "XAI_API_KEY or GROK_API_KEY",
    );
    expect(providerApiKeyEnvironmentLabel("github")).toBe(
      "GITHUB_TOKEN or GH_TOKEN",
    );
    expect(
      providerApiKeyEnvironmentLabel("amazon-bedrock"),
    ).toBeUndefined();
    expect(providerApiKeyEnvironmentLabel("agenc")).toBeUndefined();
    expect(providerCredentialEnvironmentLabel("amazon-bedrock")).toBe(
      "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and " +
        "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    );
  });
});
