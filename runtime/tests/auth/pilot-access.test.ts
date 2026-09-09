import { describe, expect, it, vi } from "vitest";
import type { AuthBackend, AuthLlmUsage } from "../../src/auth/backend.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";
import { hasActivePilotModelAccess, normalizePilotAccess } from "../../src/auth/pilot-access.js";
import { assertHostedAgencModelAuthority, resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
import { collectProviderAvailability } from "../../src/llm/discovery/provider-discovery.js";
import { defaultConfig } from "../../src/config/schema.js";

const model = "Qwen/Qwen3.8-Flash-Next";
const future = new Date(Date.now() + 60_000).toISOString();
const usage: AuthLlmUsage = {
  managedModelsEnabled: true,
  subscriptionTier: "free",
  modelAllowance: { status: "active", allowedModelCount: 1, duration: "pilot" },
  pilotAccess: { provider: "agenc", models: [model], expiresAt: future },
};

function backend(value: AuthLlmUsage = usage): AuthBackend {
  return new RemoteAuthBackend({ managedKeysEnabled: true, llmUsageResolver: () => value });
}

describe("explicit private pilot access", () => {
  it("retains model-scoped entitlement without promoting the account tier", async () => {
    const authBackend = backend();
    expect(await authBackend.getLlmUsage()).toEqual(usage);
    await expect(assertHostedAgencModelAuthority({
      provider: "agenc", model, subscriptionTier: "free", authBackend,
    })).resolves.toBeUndefined();
    const authority = await resolveProviderRuntimeAuthority("agenc", { model }, {}, {
      authBackend, sessionId: "pilot-session", subscriptionTier: "free", managedKeysEnabled: true,
    });
    expect(authority.factoryOptions.extra?.subscriptionTier).toBe("free");
    expect(authority.factoryOptions.model).toBe(model);
  });

  it.each([
    { ...usage, pilotAccess: undefined },
    { ...usage, managedModelsEnabled: false },
    { ...usage, modelAllowance: { ...usage.modelAllowance, status: "unavailable" as const } },
    { ...usage, modelAllowance: { ...usage.modelAllowance, status: "exhausted" as const } },
    { ...usage, pilotAccess: { ...usage.pilotAccess!, expiresAt: "2000-01-01T00:00:00Z" } },
    { ...usage, pilotAccess: { ...usage.pilotAccess!, models: ["some-other-model"] } },
  ])("denies missing, offline, expired or unrelated access", async (value) => {
    await expect(assertHostedAgencModelAuthority({
      provider: "agenc", model, subscriptionTier: "free", authBackend: backend(value),
    })).rejects.toThrow(/model is unavailable/);
  });

  it("does not grant a default route, another model or a malformed entitlement", () => {
    expect(hasActivePilotModelAccess(usage, "agenc")).toBe(false);
    expect(hasActivePilotModelAccess(usage, model.toLowerCase())).toBe(false);
    expect(normalizePilotAccess({ ...usage.pilotAccess, expiresAt: "never" })).toBeUndefined();
    expect(normalizePilotAccess({ ...usage.pilotAccess, provider: "qwen" })).toBeUndefined();
  });

  it("leaves existing paid authority independent from pilot usage", async () => {
    const authBackend = backend();
    const read = vi.spyOn(authBackend, "getLlmUsage");
    await expect(assertHostedAgencModelAuthority({
      provider: "agenc", model: "agenc", subscriptionTier: "pro", authBackend,
    })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([true, false])("reports exact model and readiness for a free pilot: %s", async (ready) => {
    const authBackend = new RemoteAuthBackend({
      managedKeysEnabled: true,
      subscriptionTierResolver: () => "free",
      llmUsageResolver: () => ({ ...usage, managedModelsEnabled: ready }),
      modelInferer: () => ({ provider: "qwen", model }),
      keyVendor: ({ provider, sessionId }) => ({ kind: "api-key", provider, sessionId, apiKey: "synthetic-relay-capability", baseUrl: "http://127.0.0.1:43187/v1" }),
    });
    const report = await collectProviderAvailability({
      authBackend, checkLocal: false, env: {},
      config: { ...defaultConfig(), model_provider: "agenc", model, providers: { agenc: { default_model: model } } },
    });
    expect(report.entries.find((entry) => entry.provider === "agenc")).toMatchObject({
      model, usable: ready, subscriptionTier: "free",
    });
  });
});
