import { describe, expect, test, vi } from "vitest";

import { buildProviderModelCatalog } from "../../src/config/provider-model-authority.js";
import {
  createProvider,
  readProviderFactoryOptions,
} from "../../src/llm/provider.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { GitHubProvider } from "../../src/llm/providers/github/index.js";
import { normalizeGithubModelForEndpoint } from "../../src/llm/providers/github/model-routing.js";
import type { OpenAIProviderConfig } from "../../src/llm/providers/openai/types.js";
import {
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  providerCatalogModelId,
  providerLocalModelIdFromCatalog,
  providerModelCatalogIdentifiers,
} from "../../src/llm/registry/provider-info.js";
import { isModelAllowed } from "../../src/utils/model/modelAllowlist.js";

const GITHUB_CATALOG = [
  "github:copilot:gpt-5-mini",
  "github:copilot:gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
  "github:copilot:gpt-5.4",
  "github:copilot:gpt-5.4-mini",
  "github:copilot:gpt-5.4-nano",
  "github:copilot:gpt-5.5",
  "github:copilot:gpt-5.6-luna",
  "github:copilot:gpt-5.6-sol",
  "github:copilot:gpt-5.6-terra",
  "github:copilot:claude-fable-5",
  "github:copilot:claude-haiku-4.5",
  "github:copilot:claude-opus-4.5",
  "github:copilot:claude-opus-4.6",
  "github:copilot:claude-opus-4.7",
  "github:copilot:claude-opus-4.8",
  "github:copilot:claude-opus-5",
  "github:copilot:claude-sonnet-4.5",
  "github:copilot:claude-sonnet-4.6",
  "github:copilot:claude-sonnet-5",
  "github:copilot:gemini-3.1-pro-preview",
  "github:copilot:gemini-3.5-flash",
  "github:copilot:gemini-3.6-flash",
  "github:copilot:gemini-3.7-flash",
  "github:copilot:mai-code-1-flash-picker",
  "github:copilot:mai-code-1.1-flash",
  "github:copilot:raptor-mini",
  "github:copilot:kimi-k2.7-code",
  "github:copilot:kimi-k3",
  "github:copilot:grok-4.5",
  "github:copilot:grok-4.6",
] as const;

function providerConfig(provider: GitHubProvider): OpenAIProviderConfig {
  return (provider as unknown as { config: OpenAIProviderConfig }).config;
}

function unavailableResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: "test transport stop" } }),
    {
      status: 503,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("GitHub model authority", () => {
  test("locks the supported Copilot wire-model catalog as of 2026-08-26", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).toHaveLength(30);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.github).toEqual(GITHUB_CATALOG);
  });

  test("projects known and unknown Copilot IDs in both directions", () => {
    expect(
      providerLocalModelIdFromCatalog(
        "github",
        "GitHub:Copilot:enterprise-private-model",
      ),
    ).toBe("enterprise-private-model");
    expect(providerCatalogModelId("github", "enterprise-private-model"))
      .toBe("github:copilot:enterprise-private-model");
    expect(
      providerModelCatalogIdentifiers("github", "enterprise-private-model"),
    ).toEqual([
      "enterprise-private-model",
      "github:copilot:enterprise-private-model",
    ]);

    expect(
      isModelAllowed("github", "enterprise-private-model", {
        availableModels: ["github:copilot:enterprise-private-model"],
      }),
    ).toBe(true);
    expect(
      isModelAllowed("github", "github:copilot:enterprise-private-model", {
        availableModels: ["enterprise-private-model"],
      }),
    ).toBe(true);
  });

  test("keeps configured GitHub defaults collision-safe in the shared catalog", () => {
    const catalog = buildProviderModelCatalog({
      providers: {
        github: { default_model: "enterprise-private-model" },
      },
    });

    expect(catalog.github).toContain(
      "github:copilot:enterprise-private-model",
    );
    expect(catalog.github).not.toContain("enterprise-private-model");
  });

  test("keeps configured GitHub models collision-safe in the live model manager", async () => {
    const manager = new StaticModelsManager({
      config: {
        model_provider: "github",
        model: "selected-private-model",
        providers: {
          github: { default_model: "default-private-model" },
        },
      },
      fallbackProvider: "github",
    });

    const slugs = (await manager.listModels()).map((model) => model.slug);
    expect(slugs).toEqual(expect.arrayContaining([
      "github:copilot:default-private-model",
      "github:copilot:selected-private-model",
    ]));
    expect(slugs).not.toContain("default-private-model");
    expect(slugs).not.toContain("selected-private-model");
  });

  test("preserves GitHub Models vendor qualification after catalog projection", () => {
    expect(
      normalizeGithubModelForEndpoint(
        "github:copilot:openai/gpt-5.4?reasoning=high",
        "models",
      ),
    ).toBe("openai/gpt-5.4");
  });

  test.each([
    {
      name: "direct Copilot GPT-5 provider",
      create: (fetchImpl: typeof fetch) =>
        new GitHubProvider({
          apiKey: "github-test",
          model: "github:copilot:gpt-5.4",
          useResponsesApi: false,
          fetchImpl,
          maxRetries: 0,
        }),
      expectedUrl: "https://api.githubcopilot.com/responses",
      expectedModel: "gpt-5.4",
      expectedResponses: true,
    },
    {
      name: "factory Copilot GPT-5 provider",
      create: (fetchImpl: typeof fetch) =>
        createProvider("github", {
          apiKey: "github-test",
          model: "github:copilot:gpt-5.4",
          extra: { fetchImpl, maxRetries: 0, useResponsesApi: false },
        }) as GitHubProvider,
      expectedUrl: "https://api.githubcopilot.com/responses",
      expectedModel: "gpt-5.4",
      expectedResponses: true,
    },
    {
      name: "factory Copilot default provider",
      create: (fetchImpl: typeof fetch) =>
        createProvider("github", {
          apiKey: "github-test",
          model: "github:copilot",
          extra: { fetchImpl, maxRetries: 0, useResponsesApi: true },
        }) as GitHubProvider,
      expectedUrl: "https://api.githubcopilot.com/responses",
      expectedModel: "gpt-5.3-codex",
      expectedResponses: true,
    },
    {
      name: "factory GitHub Models provider",
      create: (fetchImpl: typeof fetch) =>
        createProvider("github", {
          apiKey: "github-test",
          baseURL: "https://models.github.ai/inference",
          model: "github:copilot:openai/gpt-5.4",
          extra: { fetchImpl, maxRetries: 0 },
        }) as GitHubProvider,
      expectedUrl: "https://models.github.ai/inference/chat/completions",
      expectedModel: "openai/gpt-5.4",
      expectedResponses: false,
    },
    {
      name: "direct custom endpoint provider",
      create: (fetchImpl: typeof fetch) =>
        new GitHubProvider({
          apiKey: "github-test",
          baseURL: "https://github-proxy.example/v1",
          model: "github:copilot:openai/gpt-5.4",
          fetchImpl,
          maxRetries: 0,
        }),
      expectedUrl: "https://github-proxy.example/v1/chat/completions",
      expectedModel: "openai/gpt-5.4",
      expectedResponses: false,
    },
  ] as const)("uses the canonical route on the live $name path", async ({
    create,
    expectedUrl,
    expectedModel,
    expectedResponses,
  }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      unavailableResponse(),
    );
    const provider = create(fetchImpl);

    expect(providerConfig(provider)).toMatchObject({
      model: expectedModel,
      useResponsesApi: expectedResponses,
    });
    expect(readProviderFactoryOptions(provider).model).toBe(expectedModel);
    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        { singleWireAttempt: true },
      ),
    ).rejects.toBeDefined();

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(expectedUrl);
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { model?: string };
    expect(body.model).toBe(expectedModel);
  });
});
