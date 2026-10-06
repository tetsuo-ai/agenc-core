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
import { readLocalByokCredential } from "../auth/native-credentials.js";
import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import type { Session } from "../session/session.js";
import {
  chooseProviderModel,
  connectProviderWithKey,
  forgetProviderKey,
} from "./providers-hub-actions.js";
import {
  filterProvidersHubRows,
  readProvidersHubSnapshot,
  withLocalProbe,
  type ProvidersHubRow,
  type ProvidersHubSnapshot,
} from "./providers-hub-snapshot.js";
import type { SlashCommandContext } from "./types.js";

const homes: string[] = [];

function tempHome(): { readonly home: HomeContext; readonly environment: EnvSnapshot } {
  const path = mkdtempSync(join(tmpdir(), "agenc-providers-hub-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path });
  return { home: resolveHomeContext(environment, { platformHome: tmpdir() }), environment };
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ctxFor(params: {
  readonly home: HomeContext;
  readonly environment: EnvSnapshot;
  readonly provider?: string;
  readonly model?: string;
  readonly reload?: () => Promise<unknown>;
}): SlashCommandContext & { readonly session: Session & { pendingProviderSwitch: unknown } } {
  const configStore = {
    homeContext: params.home,
    current: () => ({}) as ReturnType<ConfigStore["current"]>,
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
    expect(byProvider.get("agenc")).toMatchObject({ access: "managed" });
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
    ).resolves.toEqual({ ok: true, message: "Key checked and saved." });
    expect(readLocalByokCredential(home, "deepseek")?.apiKey).toBe("sk-good");
  });

  it("switches and saves the pair as the default in the config store's home", async () => {
    const { home, environment } = tempHome();
    const reload = vi.fn(async () => ({}));
    const ctx = ctxFor({ home, environment, provider: "grok", model: "grok-4", reload });

    const result = await chooseProviderModel(ctx, "grok", "grok-4-fast");

    expect(result).toEqual({ ok: true, message: "Using xAI Grok · grok-4-fast, saved as the default." });
    expect(ctx.session.pendingProviderSwitch).toEqual({ provider: "grok", model: "grok-4-fast" });
    const saved = readFileSync(home.configTomlPath, "utf8");
    expect(saved).toMatch(/^"?model_provider"? = "grok"$/mu);
    expect(saved).toMatch(/^"?model"? = "grok-4-fast"$/mu);
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
