import { describe, expect, it, vi } from "vitest";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";
import type { AuthBackend } from "../../src/auth/backend.js";
import { createProvider, readProviderFactoryOptions } from "../../src/llm/provider.js";
import { resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
import { listBuiltInProviderInfo } from "../../src/llm/registry/provider-info.js";
import { OPENROUTER_FREE_MODEL_IDS } from "../../src/llm/registry/openrouter-free-models.js";

const backend = () => ({ kind: "remote", vendKey: vi.fn(), inferAgencModel: vi.fn(), getLlmUsage: vi.fn() }) as unknown as AuthBackend;

describe("account model routes are retired", () => {
  it.each(listBuiltInProviderInfo())("$id never receives account authority with legacy runtime flags", async info => {
    const authBackend = backend();
    const authority = await resolveProviderRuntimeAuthority(info.id, { model: info.defaultModel }, {}, {
      authBackend, sessionId: "offline-session", subscriptionTier: "enterprise",
      ...{ managedKeysEnabled: true, freeManagedCredential: true },
    });
    expect(authority.managedCredential).toBe(false);
    expect(authority.factoryOptions.extra ?? {}).not.toHaveProperty("authBackend");
    expect(authBackend.vendKey).not.toHaveBeenCalled();
    expect(authBackend.inferAgencModel).not.toHaveBeenCalled();
    expect(authBackend.getLlmUsage).not.toHaveBeenCalled();
  });
  it.each(["free", "pro", "team", "enterprise"] as const)("rejects the retired provider for %s accounts before consulting the account", async subscriptionTier => {
    const authBackend = backend();
    await expect(resolveProviderRuntimeAuthority("agenc", { model: "agenc" }, {}, { authBackend, subscriptionTier })).rejects.toThrow("AgenC accounts no longer provide models");
    expect(() => createProvider("agenc", { extra: { authBackend, sessionId: "offline" } })).toThrow("AgenC accounts no longer provide models");
    expect(authBackend.inferAgencModel).not.toHaveBeenCalled();
  });
  it("the remote backend cannot vend, infer, fetch usage, or discover models", async () => {
    const fetchImpl = vi.fn();
    const auth = new RemoteAuthBackend({ token: "synthetic-account-token", fetchImpl, ...{ managedKeysEnabled: true } });
    await expect(auth.vendKey("openrouter", "offline")).rejects.toThrow("no longer provide models");
    await expect(auth.inferAgencModel()).rejects.toThrow("no longer provide models");
    await expect(auth.getLlmUsage()).rejects.toThrow("no longer provide models");
    expect(await auth.listAgencModels()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(OPENROUTER_FREE_MODEL_IDS)("constructs the direct user-key route for %s", model => {
    const authBackend = backend();
    const provider = createProvider("openrouter", { model, apiKey: "synthetic-user-key", extra: { authBackend, sessionId: "offline" } });
    const options = readProviderFactoryOptions(provider);
    expect(options.apiKey).toBe("synthetic-user-key");
    expect(options.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(options.model).toBe(model);
    expect(authBackend.vendKey).not.toHaveBeenCalled();
  });
  it.each([{ managedCredential: true }, { managedGateway: true }])("rejects stale managed factory options %j", extra => {
    expect(() => createProvider("openrouter", { apiKey: "synthetic", extra })).toThrow("no longer provide models");
  });
  it.each(["https://id.agenc.ag/v1/auth/openrouter/v1", "https://llm.agenc.tech", "https://us.agenc.tech"])("rejects stale account proxy %s", baseURL => {
    expect(() => createProvider("openrouter", { apiKey: "synthetic", baseURL })).toThrow("no longer provide models");
  });
});
