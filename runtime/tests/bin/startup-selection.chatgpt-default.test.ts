import { beforeEach, describe, expect, test, vi } from "vitest";

import { resolveHomeContext } from "../../src/config/home.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), refresh: vi.fn() }));
vi.mock("../../src/utils/openAiOauthCredentials.js", () => ({
  readOpenAiOauthCredentials: mocks.read,
  refreshOpenAiSubscriptionIfNeeded: mocks.refresh,
}));

const { resolveDiscoveredStartupDefault } = await import("../../src/bin/startup-selection.js");
const { clearChatGptAccountModelCache } = await import("../../src/llm/providers/openai/chatgpt-account-models.js");

const credentialHome = resolveHomeContext(
  { AGENC_HOME: "/tmp/agenc-startup-chatgpt-default-test" },
  { platformHome: "/tmp" },
);
const SIGNED_IN = { authMode: "chatgpt", accessToken: "access-1", accountId: "acct-1" };
/** The ChatGPT account signed in to Codex on the owner's PC listed these on 2026-11-20. */
const PC_ACCOUNT = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const listing = (...slugs: string[]) =>
  new Response(JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) }));
const onOpenAi = (extra: Record<string, unknown> = {}) => ({
  provider: "openai" as const,
  model: "gpt-6.2-astra",
  config: { model_provider: "openai", model: "gpt-6.2-astra", ...extra },
});

beforeEach(() => {
  mocks.read.mockReset();
  mocks.refresh.mockReset();
  clearChatGptAccountModelCache();
});

describe("a start on OpenAI's provider default with a ChatGPT sign-in", () => {
  test("takes the best model the account lists when it does not offer GPT-6.2 Astra", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing(...PC_ACCOUNT));
    const selected = await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default", { credentialHome, env: {}, fetchImpl });
    expect(selected).toMatchObject({ provider: "openai", model: "gpt-5.6-sol", config: { model: "gpt-5.6-sol" } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
  });

  test("stays on Astra when the account lists it", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing("gpt-5.6-sol", "gpt-6.2-astra"));
    expect((await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default", { credentialHome, env: {}, fetchImpl })).model)
      .toBe("gpt-6.2-astra");
  });

  test("keeps the provider default when the list cannot be read", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect((await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default", { credentialHome, env: {}, fetchImpl })).model)
      .toBe("gpt-6.2-astra");
  });

  test("never overrides a chosen model, an API-key start or a configured OpenAI default", async () => {
    mocks.read.mockReturnValue(SIGNED_IN);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(listing(...PC_ACCOUNT));
    const explicit = { provider: "openai" as const, model: "gpt-6-luna", config: { model_provider: "openai", model: "gpt-6-luna" } };
    expect((await resolveDiscoveredStartupDefault(explicit, "explicit", { credentialHome, env: {}, fetchImpl })).model).toBe("gpt-6-luna");
    expect((await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default",
      { credentialHome, env: { OPENAI_AUTH_MODE: "api-key" }, fetchImpl })).model).toBe("gpt-6.2-astra");
    expect((await resolveDiscoveredStartupDefault(onOpenAi({ providers: { openai: { default_model: "gpt-6.2-astra" } } }),
      "provider_default", { credentialHome, env: {}, fetchImpl })).model).toBe("gpt-6.2-astra");
    // Without the home the session signs in from, nothing is read.
    expect((await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default", { env: {}, fetchImpl })).model).toBe("gpt-6.2-astra");
    mocks.read.mockReturnValue({ authMode: "apiKey", apiKey: "sk-exchanged" });
    expect((await resolveDiscoveredStartupDefault(onOpenAi(), "provider_default", { credentialHome, env: {}, fetchImpl })).model)
      .toBe("gpt-6.2-astra");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
