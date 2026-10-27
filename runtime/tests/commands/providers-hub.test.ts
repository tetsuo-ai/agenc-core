import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasSavedProviderKey,
  normalizeApiKeyInput,
  removeProviderKey,
  saveProviderKey,
} from "../auth/provider-keys.js";
import * as providerKeys from "../auth/provider-keys.js";
import { NativeSecureStorageUnavailableError } from "../utils/secureStorage/native.js";
import { readLocalByokCredential } from "../auth/native-credentials.js";
import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import type { Session } from "../session/session.js";
import {
  chooseProviderAuth,
  chooseProviderModel,
  connectProviderWithKey,
  forgetProviderKey,
} from "./providers-hub-actions.js";
import { providerEnvironmentFromCommandContext } from "./config-context.js";
import { saveXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";
import {
  filterProvidersHubRows,
  readProvidersHubModels,
  readProvidersHubSnapshot,
  withLocalProbe,
  type ProvidersHubRow,
  type ProvidersHubSnapshot,
} from "./providers-hub-snapshot.js";
import {
  recordOpenRouterZdrEndpoints,
  resetOpenRouterZdrEndpointsForTesting,
} from "../llm/registry/openrouter-zdr-endpoints.js";
import type { SlashCommandContext } from "./types.js";
import { readModelMenuSnapshot } from "./model-menu-snapshot.js";

const homes: string[] = [];

function tempHome(): { readonly home: HomeContext; readonly environment: EnvSnapshot } {
  const path = mkdtempSync(join(tmpdir(), "agenc-providers-hub-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path });
  return { home: resolveHomeContext(environment, { platformHome: tmpdir() }), environment };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetOpenRouterZdrEndpointsForTesting();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ctxFor(params: {
  readonly home: HomeContext;
  readonly environment: EnvSnapshot;
  readonly provider?: string;
  readonly model?: string;
  readonly reload?: () => Promise<unknown>;
  readonly config?: unknown;
}): SlashCommandContext & { readonly session: Session & { pendingProviderSwitch: unknown } } {
  const configStore = {
    homeContext: params.home,
    current: () => (params.config ?? {}) as ReturnType<ConfigStore["current"]>,
    reload: params.reload ?? (async () => ({})),
  };
  const session = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration: {
          provider: { slug: params.provider ?? "grok" },
          collaborationMode: { model: params.model ?? "grok-4" },
        },
        history: [],
      }),
    },
    activeTurn: { unsafePeek: () => null },
    pendingProviderSwitch: null as unknown,
    useSessionProviderKey: vi.fn(async () => {}),
    services: { configStore, providerEnvironment: params.environment },
    setPendingProviderSwitch(next: unknown) {
      this.pendingProviderSwitch = next;
    },
  };
  return {
    session: session as unknown as Session & { pendingProviderSwitch: unknown },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  };
}

function row(overrides: Partial<ProvidersHubRow> & Pick<ProvidersHubRow, "provider">): ProvidersHubRow {
  return {
    name: overrides.provider,
    access: "api-key",
    connection: "not-set",
    status: "not set",
    model: "m",
    keySaved: false,
    ...overrides,
  };
}

describe("saved provider keys", () => {
  it("saves, reports, and removes one provider's key without touching others", () => {
    const { home } = tempHome();
    saveProviderKey(home, "deepseek", "  sk-deepseek  ");
    saveProviderKey(home, "groq", "gsk-groq");

    expect(hasSavedProviderKey(home, "deepseek")).toBe(true);
    expect(readLocalByokCredential(home, "deepseek")?.apiKey).toBe("sk-deepseek");
    expect(removeProviderKey(home, "deepseek")).toBe(true);
    expect(hasSavedProviderKey(home, "deepseek")).toBe(false);
    expect(removeProviderKey(home, "deepseek")).toBe(false);
    expect(hasSavedProviderKey(home, "groq")).toBe(true);
  });

  it("refuses an empty key or one with spaces", () => {
    expect(() => normalizeApiKeyInput("   ")).toThrow("Paste a key first.");
    expect(() => normalizeApiKeyInput("sk one")).toThrow("A key has no spaces.");
    expect(normalizeApiKeyInput(" sk-1 ")).toBe("sk-1");
  });
});

describe("providers screen snapshot", () => {
  it("lists Large Flash in /model and /providers with its catalog label and capabilities", () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment, provider: "abliteration", model: "abliterated-model-large-v2" });
    expect(readModelMenuSnapshot(ctx).rows.find(row => row.provider === "abliteration" && row.displayModel === "abliterated-model-large-flash"))
      .toMatchObject({ model: "abliterated-model-large-flash", selectable: true });
    expect(readProvidersHubModels(ctx, "abliteration").find(row => row.displayModel === "abliterated-model-large-flash"))
      .toMatchObject({ label: "Abliterated Large Flash", tags: "vision · thinking", current: false, isDefault: false });
  });
  it("uses the discovered Venice trait default in the provider picker", () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    Object.assign(ctx.session.services, { modelsManager: {
      tryListModels: () => [{ provider: "venice", slug: "fresh-tool-model", isDefault: true }],
    } });
    expect(readProvidersHubSnapshot(ctx).rows.find(row => row.provider === "venice"))
      .toMatchObject({ model: "fresh-tool-model" });
  });
  it("lists Venice and saves its own BYOK credential", () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    expect(readProvidersHubSnapshot(ctx).rows.find(row => row.provider === "venice"))
      .toMatchObject({ name: "Venice AI", connection: "not-set", envLabel: "VENICE_API_KEY" });
    saveProviderKey(home, "venice", "fake-venice-stored-key");
    expect(readProvidersHubSnapshot(ctx).rows.find(row => row.provider === "venice"))
      .toMatchObject({ connection: "connected", keySaved: true });
    expect(readLocalByokCredential(home, "venice")?.apiKey).toBe("fake-venice-stored-key");
    expect(JSON.stringify(readProvidersHubSnapshot(ctx))).not.toContain("fake-venice-stored-key");
  });
  it("lists abliteration.ai with its key names and saves its own BYOK credential", () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    expect(readProvidersHubSnapshot(ctx).rows.find(row => row.provider === "abliteration"))
      .toMatchObject({ name: "abliteration.ai", connection: "not-set", envLabel: "ABLIT_KEY or ABLITERATION_API_KEY", model: "abliterated-model-large-v2" });
    saveProviderKey(home, "abliteration", "ak_fake_stored_key");
    expect(readProvidersHubSnapshot(ctx).rows.find(row => row.provider === "abliteration"))
      .toMatchObject({ connection: "connected", keySaved: true });
    expect(readLocalByokCredential(home, "abliteration")?.apiKey).toBe("ak_fake_stored_key");
    expect(JSON.stringify(readProvidersHubSnapshot(ctx))).not.toContain("ak_fake_stored_key");
  });
  it("puts the current provider first, then connected ones, with one plain status each", () => {
    const { home, environment } = tempHome();
    saveProviderKey(home, "deepseek", "sk-deepseek");
    const snapshot = readProvidersHubSnapshot(
      ctxFor({ home, environment, provider: "deepseek", model: "deepseek-flash" }),
    );

    expect(snapshot.rows[0]).toMatchObject({
      provider: "deepseek",
      connection: "current",
      status: "key saved",
      keySaved: true,
    });
    const byProvider = new Map(snapshot.rows.map((entry) => [entry.provider, entry]));
    expect(byProvider.get("anthropic")).toMatchObject({ connection: "not-set", status: "not set" });
    expect(byProvider.get("amazon-bedrock")).toMatchObject({
      access: "environment",
      status: "needs AWS credentials",
    });
    expect(byProvider.get("agenc")).toBeUndefined();
    const ranks = snapshot.rows.map((entry) =>
      ["current", "connected", "not-set", "error"].indexOf(entry.connection),
    );
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it("marks local providers by whether their server answers", () => {
    const snapshot: ProvidersHubSnapshot = {
      currentProvider: "grok",
      currentModel: "grok-4",
      rows: [
        row({ provider: "grok", connection: "current", status: "key saved" }),
        row({ provider: "ollama", access: "local", connection: "connected", status: "local" }),
        row({ provider: "lmstudio", access: "local", connection: "connected", status: "local" }),
      ],
    };
    const probed = withLocalProbe(snapshot, new Set(["lmstudio"]));

    expect(probed.rows.map((entry) => [entry.provider, entry.connection, entry.status])).toEqual([
      ["grok", "current", "key saved"],
      ["lmstudio", "connected", "running"],
      ["ollama", "not-set", "not running"],
    ]);
  });

  it("filters by display name or slug", () => {
    const rows = [
      row({ provider: "deepseek", name: "DeepSeek" }),
      row({ provider: "grok", name: "xAI" }),
    ];
    expect(filterProvidersHubRows(rows, "SEEK").map((entry) => entry.provider)).toEqual(["deepseek"]);
    expect(filterProvidersHubRows(rows, "gro").map((entry) => entry.provider)).toEqual(["grok"]);
    expect(filterProvidersHubRows(rows, "  ")).toHaveLength(2);
  });
});

describe("OpenRouter models under zero data retention", () => {
  const marked = (rows: ReturnType<typeof readProvidersHubModels>) =>
    rows.filter(row => row.zdrUnavailable === true).map(row => row.displayModel);

  it("marks models that have no zero-retention endpoint once OpenRouter's list is read", () => {
    const { home, environment: base } = tempHome();
    const environment = { ...base, OPENROUTER_API_KEY: "sk-or-test" };
    const ctx = ctxFor({ home, environment, provider: "openrouter", model: "x-ai/grok-4.5" });
    // Unchecked until the list arrives: nothing is marked from a guess.
    expect(marked(readProvidersHubModels(ctx, "openrouter"))).toEqual([]);

    recordOpenRouterZdrEndpoints({ data: [{ model_id: "x-ai/grok-4.5" }, { model_id: "openai/gpt-5" }] });
    const rows = readProvidersHubModels(ctx, "openrouter");
    const unavailable = marked(rows);
    expect(unavailable).toContain("google/gemini-2.5-flash");
    expect(unavailable).not.toContain("x-ai/grok-4.5");
    expect(unavailable).not.toContain("openai/gpt-5");
    // Still listed, so a person sees it and why it is unavailable.
    expect(rows.map(row => row.displayModel)).toContain("google/gemini-2.5-flash");
  });

  it("marks nothing once zero data retention is turned off, and nothing for other providers", () => {
    const { home, environment: base } = tempHome();
    const environment = { ...base, OPENROUTER_API_KEY: "sk-or-test", DEEPSEEK_API_KEY: "sk-test" };
    recordOpenRouterZdrEndpoints({ data: [{ model_id: "x-ai/grok-4.5" }] });
    const optedOut = ctxFor({
      home,
      environment,
      provider: "openrouter",
      model: "x-ai/grok-4.5",
      config: { providers: { openrouter: { zero_data_retention: false } } },
    });
    expect(marked(readProvidersHubModels(optedOut, "openrouter"))).toEqual([]);
    const deepseek = ctxFor({ home, environment, provider: "deepseek", model: "deepseek-flash" });
    expect(marked(readProvidersHubModels(deepseek, "deepseek"))).toEqual([]);
  });
});

describe("providers screen actions", () => {
  it("saves a key only after the provider accepts it", async () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
    const accepted = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const refused = await connectProviderWithKey(ctx, "deepseek", "sk-bad", { fetchImpl: rejected });
    expect(refused.ok).toBe(false);
    expect(hasSavedProviderKey(home, "deepseek")).toBe(false);

    await expect(
      connectProviderWithKey(ctx, "deepseek", "sk-good", { fetchImpl: accepted }),
    ).resolves.toEqual({ ok: true, message: "Key checked and saved. Ready for your next prompt." });
    expect(readLocalByokCredential(home, "deepseek")?.apiKey).toBe("sk-good");
  });

  it("keeps a verified key active and explains unavailable persistence without echoing secrets", async () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    const store = vi.spyOn(providerKeys, "saveProviderKey").mockImplementation(() => {
      throw new NativeSecureStorageUnavailableError("backend accidentally echoed sk-placeholder-key");
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const result = await connectProviderWithKey(ctx, "deepseek", "sk-placeholder-key", { fetchImpl });
    expect(result).toMatchObject({ ok: true, sessionOnly: true });
    expect(result.message).toContain("was not saved");
    expect(result.message).toContain("DEEPSEEK_API_KEY");
    expect(result.message).toContain("restarting the daemon");
    expect(result.message).not.toContain("sk-placeholder-key");
    expect(store).toHaveBeenCalledOnce();
    expect((ctx.session as unknown as { useSessionProviderKey: unknown }).useSessionProviderKey)
      .toHaveBeenCalledWith("deepseek", "sk-placeholder-key");
  });

  it("does not save a key when its session activation fails", async () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    const activate = (ctx.session as unknown as { useSessionProviderKey: ReturnType<typeof vi.fn> }).useSessionProviderKey;
    activate.mockRejectedValue(new Error("sk-placeholder-key"));
    const store = vi.spyOn(providerKeys, "saveProviderKey");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    const result = await connectProviderWithKey(ctx, "deepseek", "sk-placeholder-key", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not be activated");
    expect(result.message).not.toContain("sk-placeholder-key");
    expect(store).not.toHaveBeenCalled();
  });

  it("switches and saves the pair as the default in the config store's home", async () => {
    const { home, environment } = tempHome();
    const reload = vi.fn(async () => ({}));
    const ctx = ctxFor({ home, environment, provider: "grok", model: "grok-4", reload });

    const result = await chooseProviderModel(ctx, "grok", "grok-4.7");

    expect(result).toEqual({ ok: true, message: "Using xAI Grok · grok-4.7, saved as the default." });
    expect(ctx.session.pendingProviderSwitch).toEqual({ provider: "grok", model: "grok-4.7" });
    const saved = readFileSync(home.configTomlPath, "utf8");
    expect(saved).toMatch(/^"?model_provider"? = "grok"$/mu);
    expect(saved).toMatch(/^"?model"? = "grok-4.7"$/mu);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves the default alone when the switch is refused", async () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });

    const result = await chooseProviderModel(ctx, "grok", "gpt-5");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("belongs to provider 'openai'");
    expect(() => readFileSync(home.configTomlPath, "utf8")).toThrow();
  });

  it("removes a saved key and says when there is none", () => {
    const { home, environment } = tempHome();
    const ctx = ctxFor({ home, environment });
    saveProviderKey(home, "groq", "gsk-1");

    expect(forgetProviderKey(ctx, "groq").ok).toBe(true);
    expect(hasSavedProviderKey(home, "groq")).toBe(false);
    expect(forgetProviderKey(ctx, "groq")).toEqual({
      ok: false,
      message: "No saved key for this provider.",
    });
  });
});

describe("account sign-in and the account-or-key choice", () => {
  function signInToXai(home: HomeContext): void {
    expect(
      saveXaiOauthCredentials(home, {
        accessToken: "oauth-token",
        expiresAt: Date.now() + 60_000,
        accountLabel: "ana@example.com",
      }).success,
    ).toBe(true);
  }

  it("shows the signed-in account and uses it before a saved key by default", () => {
    const { home, environment } = tempHome();
    signInToXai(home);
    saveProviderKey(home, "grok", "xai-key");
    const grok = readProvidersHubSnapshot(ctxFor({ home, environment, provider: "openai", model: "gpt-5" }))
      .rows.find((entry) => entry.provider === "grok");

    expect(grok).toMatchObject({
      connection: "connected",
      status: "signed in as ana@example.com",
      signIn: { account: "ana@example.com", keyAvailable: true, using: "account", setting: "auto" },
    });
    expect(grok?.signIn?.lockedBy).toBeUndefined();
  });

  it("follows the config choice, and an exported variable overrides it", () => {
    const { home, environment } = tempHome();
    signInToXai(home);
    saveProviderKey(home, "grok", "xai-key");
    const config = { providers: { grok: { auth: "api-key" } } };
    const byConfig = readProvidersHubSnapshot(
      ctxFor({ home, environment, provider: "openai", model: "gpt-5", config }),
    ).rows.find((entry) => entry.provider === "grok");
    expect(byConfig).toMatchObject({ status: "key saved", signIn: { using: "key", setting: "api-key" } });

    const locked = readProvidersHubSnapshot(
      ctxFor({
        home,
        environment: Object.freeze({ ...environment, GROK_AUTH_MODE: "oauth" }),
        provider: "openai",
        model: "gpt-5",
        config,
      }),
    ).rows.find((entry) => entry.provider === "grok");
    expect(locked).toMatchObject({ signIn: { using: "account", lockedBy: "GROK_AUTH_MODE" } });
  });

  it("fills the config choice into the command environment", () => {
    const { home, environment } = tempHome();
    const env = providerEnvironmentFromCommandContext(
      ctxFor({ home, environment, config: { providers: { openai: { auth: "oauth" } } } }),
    );
    expect(env.OPENAI_AUTH_MODE).toBe("oauth");
    expect(env.AGENC_HOME).toBe(environment.AGENC_HOME);
  });

  it("saves the choice in the config store's home and reloads it", async () => {
    const { home, environment } = tempHome();
    const reload = vi.fn(async () => ({}));
    const ctx = ctxFor({ home, environment, reload });

    await expect(chooseProviderAuth(ctx, "grok", "api-key")).resolves.toEqual({
      ok: true,
      message: "Saved. New sessions use the API key.",
    });
    expect(readFileSync(home.configTomlPath, "utf8")).toMatch(/^"?auth"? = "api-key"$/mu);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
