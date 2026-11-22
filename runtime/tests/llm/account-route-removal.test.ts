import { describe, expect, it } from "vitest";
import { createProvider, readProviderFactoryOptions } from "../../src/llm/provider.js";
import { resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
import { listBuiltInProviderInfo } from "../../src/llm/registry/provider-info.js";
import { OPENROUTER_FREE_MODEL_IDS } from "../../src/llm/registry/openrouter-free-models.js";

describe("account model routes are retired", () => {
  it.each(listBuiltInProviderInfo())("$id never receives account authority with legacy runtime flags", async info => {
    const authority = await resolveProviderRuntimeAuthority(info.id, { model: info.defaultModel }, {}, {
      sessionId: "offline-session",
      ...{ subscriptionTier: "enterprise", managedKeysEnabled: true, freeManagedCredential: true },
    });
    expect(authority.managedCredential).toBe(false);
    expect(authority.factoryOptions.extra ?? {}).not.toHaveProperty("authBackend");
  });
  it("has no AgenC account provider", () => {
    expect(listBuiltInProviderInfo().map(info => String(info.id))).not.toContain("agenc");
    expect(() => createProvider("agenc" as never, {})).toThrow("unknown provider: agenc");
  });
  it.each(OPENROUTER_FREE_MODEL_IDS)("constructs the direct user-key route for %s", model => {
    const provider = createProvider("openrouter", { model, apiKey: "synthetic-user-key", extra: { sessionId: "offline" } });
    const options = readProviderFactoryOptions(provider);
    expect(options.apiKey).toBe("synthetic-user-key");
    expect(options.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(options.model).toBe(model);
  });
  it.each([{ managedCredential: true }, { managedGateway: true }])("rejects stale managed factory options %j", extra => {
    expect(() => createProvider("openrouter", { apiKey: "synthetic", extra })).toThrow("no longer provide models");
  });
});
