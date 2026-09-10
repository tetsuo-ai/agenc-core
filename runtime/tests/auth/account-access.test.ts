import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthBackend, AuthLlmUsage } from "../../src/auth/backend.js";
import { readAccountModelAccess, parseAgencModelCatalog, accountDefaultModel } from "../../src/auth/account-access.js";
import { saveAccountDefaultModel } from "../../src/auth/account-default.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";
import { collectProviderAvailability } from "../../src/llm/discovery/provider-discovery.js";
import { defaultConfig } from "../../src/config/schema.js";
import { parseToml } from "../../src/config/loader.js";
import { runAgenCAuthCli } from "../../src/bin/auth-cli.js";
import { AGENC_DEEPSEEK_MODEL } from "../../src/llm/registry/agenc-deepseek.js";

const model = "deepseek/synthetic-agent-model";
const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
const usage: AuthLlmUsage = { managedModelsEnabled: true, subscriptionTier: "free",
  modelAllowance: { status: "active", allowedModelCount: 1, duration: "promotion", remainingUsd: 2.66, usedUsd: 0, includedUsd: 2.66 },
  pilotAccess: { provider: "agenc", models: [model], expiresAt } };
const catalog = [{ id: model, name: "DeepSeek Synthetic Agent", contextWindow: 100_000 }];
function backend(value: AuthLlmUsage = usage): AuthBackend {
  return { kind: "remote", login: vi.fn(() => ({ authenticated: true, provider: "remote" })),
    logout: vi.fn(() => ({ authenticated: false })), whoami: vi.fn(() => ({ authenticated: true, provider: "remote" })),
    getSubscriptionTier: vi.fn(() => "free"), getLlmUsage: vi.fn(() => value), listAgencModels: vi.fn(() => catalog),
    inferAgencModel: vi.fn(() => ({ provider: "openrouter", model })),
    vendKey: vi.fn((provider, sessionId) => ({ kind: "api-key", provider, sessionId, apiKey: "synthetic-only" })) };
}

describe("AgenC account model access", () => {
  it("loads only eligible models and real credits, without vending credentials", async () => {
    const auth = backend();
    vi.mocked(auth.listAgencModels!).mockReturnValue([...catalog, { id: "not-authorized", name: "Other" }]);
    const access = await readAccountModelAccess(auth);
    expect(access.models).toEqual(catalog);
    expect(access.allowance?.remainingUsd).toBe(2.66);
    expect(access.expiresAt).toBe(expiresAt);
    expect(accountDefaultModel(access, "retired-qwen")).toBe(model);
    expect(auth.vendKey).not.toHaveBeenCalled();
    expect(auth.inferAgencModel).not.toHaveBeenCalled();
  });

  it("does not query usage or enroll a signed-out account", async () => {
    const auth = backend(); vi.mocked(auth.whoami).mockReturnValue({ authenticated: false });
    expect(await readAccountModelAccess(auth)).toEqual({ authenticated: false, models: [] });
    expect(auth.getLlmUsage).not.toHaveBeenCalled();
    expect(auth.listAgencModels).not.toHaveBeenCalled();
  });

  it.each([
    { ...usage, managedModelsEnabled: false },
    { ...usage, pilotAccess: undefined },
    { ...usage, pilotAccess: { ...usage.pilotAccess!, expiresAt: "2000-01-01T00:00:00Z" } },
    { ...usage, modelAllowance: { ...usage.modelAllowance, status: "exhausted" as const } },
    { ...usage, modelAllowance: { ...usage.modelAllowance, remainingUsd: 0 } },
  ])("keeps inactive access empty %#", async value => {
    const auth = backend(value);
    expect((await readAccountModelAccess(auth)).models).toEqual([]);
    expect(auth.listAgencModels).not.toHaveBeenCalled();
  });

  it("retains observed balance and closes model access when discovery fails", async () => {
    const auth = backend(); vi.mocked(auth.listAgencModels!).mockRejectedValue(Error("private diagnostic"));
    expect(await readAccountModelAccess(auth)).toMatchObject({ models: [], unavailable: true, allowance: { remainingUsd: 2.66 } });
    expect(JSON.stringify(await readAccountModelAccess(auth))).not.toContain("private diagnostic");
  });

  it("projects metadata, rejecting duplicate IDs and a transport provider label", () => {
    const row = { id: model, name: "DeepSeek Synthetic Agent", provider: "agenc", context_length: 100_000, apiKey: "drop-this" };
    expect(parseAgencModelCatalog({ data: [row] })).toEqual(catalog);
    expect(() => parseAgencModelCatalog({ data: [row, row] })).toThrow();
    expect(() => parseAgencModelCatalog({ data: [{ ...row, provider: "openrouter" }] })).toThrow();
    expect(() => parseAgencModelCatalog({ data: [{ ...row, context_length: -1 }] })).toThrow();
  });

  it("authenticates catalog fetch in Core and refuses redirects", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: model, name: "DeepSeek Synthetic Agent", provider: "agenc" }] }));
    const auth = new RemoteAuthBackend({ token: "synthetic-token", fetchImpl: fetchImpl as typeof fetch,
      usageEndpoint: "https://identity.example.test/v1/auth/llm-usage" });
    expect(await auth.listAgencModels()).toEqual([{ id: model, name: "DeepSeek Synthetic Agent" }]);
    expect(fetchImpl).toHaveBeenCalledWith("https://identity.example.test/v1/auth/openrouter/v1/models",
      expect.objectContaining({ method: "GET", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer synthetic-token" }) }));
  });

  it("discovers the current model with a blank or retired local configuration", async () => {
    for (const configured of ["agenc", "Qwen/Retired-Model"]) {
      const report = await collectProviderAvailability({ authBackend: backend(), checkLocal: false, env: {},
        config: { ...defaultConfig(), providers: { agenc: { default_model: configured } } } });
      expect(report.entries.find(entry => entry.provider === "agenc")).toMatchObject({ model, usable: true, models: catalog });
    }
  });

  it("rejects inference that changes the authorized model", async () => {
    const auth = backend(); vi.mocked(auth.inferAgencModel).mockReturnValue({ provider: "openrouter", model: "other-model" });
    const report = await collectProviderAvailability({ authBackend: auth, checkLocal: false, env: {}, config: defaultConfig() });
    expect(report.entries.find(entry => entry.provider === "agenc")).toMatchObject({ usable: false, models: [] });
    expect(auth.vendKey).not.toHaveBeenCalled();
  });

  it.each([undefined, "agenc", "openai"])("saves a complete pair after login while preserving %s", async provider => {
    const home = mkdtempSync(join(tmpdir(), "agenc-account-default-"));
    try {
      if (provider) writeFileSync(join(home, "config.toml"), `config_version = 2\nmodel_provider = "${provider}"\nmodel = "previous-model"\n`);
      const access = await readAccountModelAccess(backend());
      expect(saveAccountDefaultModel(home, access)).toBe(provider !== "openai");
      const config = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
      expect(config.model_provider).toBe(provider === "openai" ? "openai" : "agenc");
      expect(config.model).toBe(provider === "openai" ? "previous-model" : model);
      expect(config.providers).toMatchObject({ agenc: { default_model: model } });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each([undefined, "agenc", "openai"])("selects the reviewed effort without changing a BYOK preference (%s)", provider => {
    const home = mkdtempSync(join(tmpdir(), "agenc-account-effort-"));
    try {
      if (provider) writeFileSync(join(home, "config.toml"), `config_version = 2\nmodel_provider = "${provider}"\nmodel = "previous-model"\nreasoning_effort = "xhigh"\n`);
      saveAccountDefaultModel(home, { authenticated: true, managedModelsEnabled: true, models: [{ id: AGENC_DEEPSEEK_MODEL, name: "DeepSeek" }] });
      const config = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
      expect(config.reasoning_effort).toBe(provider === "openai" ? "xhigh" : "medium");
      expect(config.model_provider).toBe(provider === "openai" ? "openai" : "agenc");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("bootstraps a fresh CLI login and exposes only public JSON to Desktop", async () => {
    const home = mkdtempSync(join(tmpdir(), "agenc-account-login-"));
    try {
      let output = ""; const auth = backend();
      const io = { stdout: { write: (s: string | Uint8Array) => { output += s; return true; } }, stderr: { write: () => true } };
      expect(await runAgenCAuthCli({ kind: "login" }, { agencHome: home, backend: auth, env: {}, io })).toBe(0);
      expect(parseToml(readFileSync(join(home, "config.toml"), "utf8"))).toMatchObject({ model_provider: "agenc", model });
      output = "";
      expect(await runAgenCAuthCli({ kind: "account-access" }, { backend: auth, io })).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ authenticated: true, models: catalog, allowance: { remainingUsd: 2.66 } });
      expect(output).not.toContain("synthetic-only");
      expect(auth.vendKey).not.toHaveBeenCalled();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
