import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  listBuiltInProviderInfo,
  resolveBuiltInProviderInfo,
} from "./provider-info.js";

describe("built-in provider info", () => {
  it("defines every provider field and ordered ingress alias exactly once", () => {
    const expected = [
      ["grok", "xAI Grok", "grok-4.6", "https://api.x.ai/v1", ["XAI_API_KEY", "GROK_API_KEY"], ["XAI_BASE_URL", "GROK_BASE_URL"], 10, "api-key", false],
      ["openai", "OpenAI", "gpt-5", "https://api.openai.com/v1", ["OPENAI_API_KEY"], ["OPENAI_BASE_URL", "OPENAI_API_BASE"], 20, "api-key", false],
      ["anthropic", "Anthropic", "claude-opus-4-7", "https://api.anthropic.com/v1", ["ANTHROPIC_API_KEY"], ["ANTHROPIC_BASE_URL"], 30, "api-key", false],
      ["ollama", "Ollama", "llama3.3", "http://localhost:11434", [], ["OLLAMA_BASE_URL"], 40, "local", false],
      ["lmstudio", "LM Studio", "gpt-4o-mini", "http://localhost:1234/v1", ["LMSTUDIO_API_KEY"], ["LMSTUDIO_BASE_URL"], 50, "local", false],
      ["openai-compatible", "OpenAI-compatible", "local-model", "http://localhost:8000/v1", ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"], ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"], 60, "local", false],
      ["openrouter", "OpenRouter", "x-ai/grok-4.5", "https://openrouter.ai/api/v1", ["OPENROUTER_API_KEY"], ["OPENROUTER_BASE_URL"], 70, "api-key", true],
      ["groq", "Groq", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1", ["GROQ_API_KEY"], ["GROQ_BASE_URL"], 80, "api-key", false],
      ["deepseek", "DeepSeek", "deepseek-v4-flash", "https://api.deepseek.com/v1", ["DEEPSEEK_API_KEY"], ["DEEPSEEK_BASE_URL"], 90, "api-key", false],
      ["gemini", "Gemini", "gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], ["GEMINI_BASE_URL"], 100, "api-key", false],
      ["mistral", "Mistral", "mistral-medium-latest", "https://api.mistral.ai/v1", ["MISTRAL_API_KEY"], ["MISTRAL_BASE_URL"], 110, "api-key", false],
      ["nvidia-nim", "NVIDIA NIM", "nvidia/llama-3.1-nemotron-70b-instruct", "https://integrate.api.nvidia.com/v1", ["NVIDIA_API_KEY"], ["NVIDIA_BASE_URL"], 120, "api-key", false],
      ["minimax", "MiniMax", "MiniMax-M2.5", "https://api.minimax.io/v1", ["MINIMAX_API_KEY"], ["MINIMAX_BASE_URL"], 130, "api-key", false],
      ["github", "GitHub Copilot", "gpt-4o", "https://api.githubcopilot.com", ["GITHUB_TOKEN", "GH_TOKEN"], ["GITHUB_BASE_URL"], 140, "api-key", false],
      ["amazon-bedrock", "Amazon Bedrock", "amazon.nova-pro-v1:0", "https://bedrock-runtime.us-east-1.amazonaws.com", ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"], ["AWS_BEDROCK_BASE_URL"], 150, "api-key", false],
      ["agenc", "AgenC", "agenc", "https://id.agenc.ag/v1", [], ["AGENC_BASE_URL"], 160, "managed", false],
    ] as const;

    expect(
      listBuiltInProviderInfo().map((provider) => [
        provider.id,
        provider.name,
        provider.defaultModel,
        provider.baseURL,
        provider.apiKeyEnvVars,
        provider.baseURLEnvVars,
        provider.onboarding.order,
        provider.onboarding.access,
        provider.onboarding.supportsManagedKeyAccess,
      ]),
    ).toEqual(expected);
    for (const provider of listBuiltInProviderInfo()) {
      expect(Object.isFrozen(BUILT_IN_PROVIDER_DEFINITIONS[provider.id])).toBe(true);
      expect(Object.isFrozen(provider.apiKeyEnvVars)).toBe(true);
      expect(Object.isFrozen(provider.baseURLEnvVars)).toBe(true);
      expect(new Set(provider.apiKeyEnvVars).size).toBe(provider.apiKeyEnvVars.length);
      expect(new Set(provider.baseURLEnvVars).size).toBe(provider.baseURLEnvVars.length);
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
      apiKeyEnvVar: "AWS_BEDROCK_ACCESS_KEY_ID",
    });
  });
});
