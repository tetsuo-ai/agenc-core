import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runtimeSettingsWithRestoreOverrides } from "../../src/app-server/background-agent-runner/runtime-settings.js";
import { saveProviderKey } from "../../src/auth/provider-keys.js";
import { applyModelSwitch } from "../../src/commands/model.js";
import { openRouterMenuCatalog } from "../../src/commands/openrouter-menu-models.js";
import { applyProviderSwitch } from "../../src/commands/provider.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import type { RunRuntimeSettingsSnapshot } from "../../src/contracts/run-contracts.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import { OpenRouterCatalog, openRouterCatalogFor } from "../../src/llm/registry/openrouter-live-catalog.js";
import {
  clearPublishedModelCatalogs,
  publishedModelCatalogEntries,
} from "../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../src/llm/registry/published-model-costs.js";
import {
  openRouterCatalogForHome,
  readSessionCachedLiveModelList,
} from "../../src/session/cached-live-model-list.js";
import { resolveSessionProviderModelSelection } from "../../src/session/provider-model-selection.js";
import type { Session } from "../../src/session/session.js";

const homes: string[] = [];
afterEach(() => {
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
  vi.useRealTimers();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Bundled OpenRouter rows of the 2026-10-20 snapshot (issue #3447).
const MODEL = "bytedance-seed/seed-1.6";
const REFUSAL = "OpenRouter retired 'bytedance-seed/seed-1.6' on 2026-11-11. Pick another model.";
const NOW = new Date("2026-11-12T12:00:00Z");
const KEY = "fixture-only-key";

/** A new, empty AgenC home, by the path a session's home context has for it. */
function newHome(): string {
  const path = mkdtempSync(join(tmpdir(), "cached-live-list-"));
  homes.push(path);
  return resolveHomeContext({ AGENC_HOME: path }, { platformHome: path }).path;
}

/** The models OpenRouter's published list has in this process, if one is recorded. */
const published = () => publishedModelCatalogEntries("openrouter")?.map((entry) => entry.model);

/**
 * Another process (the TUI) reads OpenRouter's live list and caches it in the
 * home. Its catalog object and what it recorded are its own: nothing of them
 * is in this process.
 */
async function anotherProcessCachesLiveList(
  home: string,
  apiKey: string | undefined,
  models: readonly string[],
): Promise<void> {
  const body = { data: models.map((id) => ({
    id, name: id, context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" },
  })) };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
  const catalog = new OpenRouterCatalog({ home, fetchImpl, ...(apiKey === undefined ? {} : { apiKey }) });
  expect((await catalog.refresh()).source).toBe("live");
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("openrouter", new Map());
}

interface Scene {
  /** The OpenRouter key in the environment the session was created with. */
  readonly key?: string;
  /** A key added to the session after it was created. */
  readonly keyAddedSince?: string;
  readonly config?: AgenCConfig;
}

/**
 * A session on DeepSeek as the daemon holds it: its own models manager, built
 * as bin/bootstrap.ts builds it, and no network.
 */
function daemonSession(home: string, scene: Scene = {}) {
  const environment = {
    AGENC_HOME: home,
    ...(scene.key === undefined ? {} : { OPENROUTER_API_KEY: scene.key }),
  };
  const config: AgenCConfig = scene.config ?? { model_provider: "deepseek", model: "deepseek-flash" };
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  const modelsManager = new StaticModelsManager({
    config, fallbackProvider: "deepseek",
    metadata: { catalogHome: home, fetchImpl: offline, env: environment },
  });
  const session = {
    state: { unsafePeek: () => ({ sessionConfiguration: {
      provider: { slug: "deepseek" }, collaborationMode: { model: "deepseek-flash" },
    }, history: [] }) },
    activeTurn: { unsafePeek: () => null },
    pendingProviderSwitch: null as unknown,
    setPendingProviderSwitch(next: unknown) { this.pendingProviderSwitch = next; },
    services: {
      providerEnvironment: environment,
      modelsManager,
      configStore: { homeContext: resolveHomeContext(environment, { platformHome: home }), current: () => config },
      ...(scene.keyAddedSince === undefined ? {} : {
        providerService: {
          current: () => ({ provider: "deepseek", model: "deepseek-flash" }),
          environment: () => ({ ...environment, OPENROUTER_API_KEY: scene.keyAddedSince }),
        },
      }),
    },
  };
  // The daemon lists its models at session setup. That reads its own
  // OpenRouter catalog object, built now, while the home has no cache.
  expect(modelsManager.tryListModels()?.some((model) => model.provider === "openrouter")).toBe(true);
  expect(published()).toBeUndefined();
  expect(offline).not.toHaveBeenCalled();
  return { session: session as unknown as Session, pending: () => session.pendingProviderSwitch, offline };
}

type RestoreParams = Parameters<typeof runtimeSettingsWithRestoreOverrides>[1];
/** What a restore request carries of its own: here only the provider and model given with --resume. */
const restoreParams = (given: Pick<RestoreParams, "provider" | "model">): RestoreParams =>
  ({ agentId: "agent", objective: "resume", ...given }) as RestoreParams;

describe("a model picked in the TUI and checked by the daemon", () => {
  test("is accepted when the list the TUI cached has it, although the daemon's catalog was built before that cache existed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session, pending, offline } = daemonSession(home, { key: KEY });
    // The catalog object of this home and key in the daemon, built with no cache to read.
    expect(openRouterCatalogFor({ home, apiKey: KEY }).read().source).toBe("bundled");
    // With the bundled catalog alone the model is refused: its date has passed.
    expect(await applyModelSwitch(session, MODEL, "openrouter")).toMatchObject({
      applied: false, summary: `Model switch to "${MODEL}" blocked: ${REFUSAL}`,
    });

    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    expect(published()).toBeUndefined();

    // session.setModel with a model, as the providers hub sends it.
    expect(await applyModelSwitch(session, MODEL, "openrouter")).toEqual({
      applied: true, provider: "openrouter", model: MODEL,
      summary: `Model switched to "${MODEL}" on "openrouter" (was "deepseek/deepseek-flash").`,
    });
    expect(pending()).toEqual({ provider: "openrouter", model: MODEL });
    // The daemon now has the list the TUI read, and asked the provider nothing.
    expect(published()).toEqual(["x-ai/grok-4.5", MODEL]);
    expect(offline).not.toHaveBeenCalled();
  });

  test("is accepted on a provider-only switch to a saved model the cached list has", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const config: AgenCConfig = {
      model_provider: "deepseek", model: "deepseek-flash",
      providers: { openrouter: { default_model: MODEL } },
    };
    const { session, pending } = daemonSession(home, { key: KEY, config });
    expect(openRouterCatalogFor({ home, apiKey: KEY }).read().source).toBe("bundled");
    expect((await applyProviderSwitch(session, "openrouter")).summary)
      .toBe(`Provider switch to "openrouter" blocked: ${REFUSAL}`);

    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    // session.setModel with a provider alone.
    expect(await applyProviderSwitch(session, "openrouter")).toMatchObject({
      applied: true, provider: "openrouter", model: MODEL,
    });
    expect(pending()).toEqual({ provider: "openrouter", model: MODEL });
  });

  test("is refused with its date when the cached list does not have it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session, pending } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", "poolside/laguna-s-2.1"]);
    expect((await applyModelSwitch(session, MODEL, "openrouter")).summary)
      .toBe(`Model switch to "${MODEL}" blocked: ${REFUSAL}`);
    expect(pending()).toBeNull();
    // The model that list does have is accepted from the same read.
    expect(await applyModelSwitch(session, "poolside/laguna-s-2.1", "openrouter"))
      .toMatchObject({ applied: true, model: "poolside/laguna-s-2.1" });
  });

  test("is refused with its date when the cached list is from before that date", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session, pending } = daemonSession(home, { key: KEY });
    // The TUI last read OpenRouter's list a week before the model's date.
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    vi.setSystemTime(NOW);
    expect((await applyModelSwitch(session, MODEL, "openrouter")).summary)
      .toBe(`Model switch to "${MODEL}" blocked: ${REFUSAL}`);
    expect(pending()).toBeNull();
    // The daemon did read that list. It speaks for what has no date to pass.
    expect(published()).toEqual(["x-ai/grok-4.5", MODEL]);
    expect(await applyModelSwitch(session, "x-ai/grok-4.5", "openrouter")).toMatchObject({ applied: true });

    // Once the TUI has read the list again, on the date or after it, it vouches.
    vi.setSystemTime(new Date("2026-11-11T00:00:00.000Z"));
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    vi.setSystemTime(NOW);
    expect(await applyModelSwitch(session, MODEL, "openrouter")).toMatchObject({ applied: true, model: MODEL });
  });

  test("a model OpenRouter added since the daemon last looked is accepted once the TUI has cached it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5"]);
    // A refusal makes the daemon read that list. From here on it holds one.
    expect((await applyModelSwitch(session, MODEL, "openrouter")).summary)
      .toBe(`Model switch to "${MODEL}" blocked: ${REFUSAL}`);
    expect(published()).toEqual(["x-ai/grok-4.5"]);

    // Two hours later OpenRouter lists a new model, and the TUI reads it.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60 * 60_000));
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", "acme/added-since"]);
    // The helper cleared what this process recorded; the daemon's own catalog
    // still holds the older list, and records it again when it is read.
    expect(openRouterCatalogFor({ home, apiKey: KEY }).read().models.map((row) => row.model)).toEqual(["x-ai/grok-4.5"]);
    expect(published()).toEqual(["x-ai/grok-4.5"]);

    // Its own list does not have the model. Before that refusal stands, it
    // reads what the home's cache holds now.
    expect(await applyModelSwitch(session, "acme/added-since", "openrouter"))
      .toMatchObject({ applied: true, model: "acme/added-since" });
    expect(published()).toEqual(["x-ai/grok-4.5", "acme/added-since"]);
    // A model no list has is still refused.
    expect((await applyModelSwitch(session, "acme/in-no-list", "openrouter")).summary)
      .toContain("does not list model 'acme/in-no-list'");
  });

  test("reads the list cached for the session's key, not another key's", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const keyed = daemonSession(home, { key: KEY });
    const keyless = daemonSession(home);
    await anotherProcessCachesLiveList(home, "another-fixture-key", ["x-ai/grok-4.5", MODEL]);
    await anotherProcessCachesLiveList(home, undefined, ["x-ai/grok-4.5", MODEL]);
    expect((await applyModelSwitch(keyed.session, MODEL, "openrouter")).summary)
      .toBe(`Model switch to "${MODEL}" blocked: ${REFUSAL}`);
    expect(published()).toBeUndefined();
    // A session with no key reads the public list's cache.
    expect((await applyModelSwitch(keyless.session, MODEL, "openrouter")).applied).toBe(true);
  });

  test("uses the key the session has now: one added after it was created", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session } = daemonSession(home, { keyAddedSince: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    expect((await applyModelSwitch(session, MODEL, "openrouter")).applied).toBe(true);
  });

  test("uses the key saved in the home when the environment has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session } = daemonSession(home);
    saveProviderKey(resolveHomeContext({ AGENC_HOME: home }, { platformHome: home }), "openrouter", KEY);
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    expect((await applyModelSwitch(session, MODEL, "openrouter")).applied).toBe(true);
  });

  test("reads the home only when the check is about to refuse the model", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    // A model with no date, one whose date is ahead, and an id no list has yet:
    // each is checked against what this process already knew, as before.
    for (const model of ["x-ai/grok-4.5", "z-ai/glm-4.5", "acme/private-route"]) {
      expect(await applyModelSwitch(session, model, "openrouter"), model).toMatchObject({ applied: true, model });
      expect(published(), model).toBeUndefined();
    }
  });

  test("is checked the same way when the model comes with --resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    const canonical: RunRuntimeSettingsSnapshot = {
      permissionMode: "default", prePlanMode: null, autoModeActive: false, autoModeAvailable: false,
      bypassPermissionsModeAvailable: false, bypassPermissionsWorkspace: null,
      bypassPermissionsConsentWorkspace: null, model: "deepseek-flash", provider: "deepseek", profile: null,
      reasoningEffort: null, modelVerbosity: null, serviceTier: null, hooksDisabled: false,
    };
    const resumed = restoreParams({ provider: "openrouter", model: MODEL });
    const config: AgenCConfig = { model_provider: "deepseek", model: "deepseek-flash" };
    const readCachedLiveList = (provider: string): void => readSessionCachedLiveModelList(session, provider);
    const restore = () => runtimeSettingsWithRestoreOverrides(canonical, resumed, home, config, {}, readCachedLiveList);

    expect(restore).toThrow(new Error(REFUSAL));
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    expect(restore()).toMatchObject({ provider: "openrouter", model: MODEL });
    // Without the home's list the bundled date decides.
    clearPublishedModelCatalogs();
    expect(() => runtimeSettingsWithRestoreOverrides(canonical, resumed, home, config, {})).toThrow(new Error(REFUSAL));
    // A restore that repeats the saved pair is never checked.
    expect(runtimeSettingsWithRestoreOverrides(
      { ...canonical, provider: "openrouter", model: MODEL }, restoreParams({}), home, config, {},
    )).toMatchObject({ provider: "openrouter", model: MODEL });
  });
});

describe("resolveSessionProviderModelSelection", () => {
  const layer = { model_provider: "openrouter", model: MODEL };

  test("reads the session's cached list by default, and a caller's reader in its place", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    const readCachedLiveList = vi.fn();
    expect(() => resolveSessionProviderModelSelection(session, layer, { now: NOW, readCachedLiveList }))
      .toThrow(new Error(REFUSAL));
    expect(readCachedLiveList.mock.calls).toEqual([["openrouter"]]);
    expect(resolveSessionProviderModelSelection(session, layer, { now: NOW }))
      .toEqual({ provider: "openrouter", model: MODEL, providerChanged: true });
  });

  test("asks once before a refusal stands, whether for a date or for a model its list lacks", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5"]);
    // Give this process a list, so that a model outside it is refused.
    readSessionCachedLiveModelList(session, "openrouter");
    expect(published()).toEqual(["x-ai/grok-4.5"]);

    for (const [model, refusal] of [
      [MODEL, REFUSAL],
      ["acme/in-no-list", "OpenRouter does not list model 'acme/in-no-list'"],
    ] as const) {
      const readCachedLiveList = vi.fn();
      expect(() => resolveSessionProviderModelSelection(
        session, { model_provider: "openrouter", model }, { now: NOW, readCachedLiveList },
      )).toThrow(refusal);
      expect(readCachedLiveList.mock.calls, model).toEqual([["openrouter"]]);
    }
  });

  test("asks for no list while the model is not retired, or the pair is replayed", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    const readCachedLiveList = vi.fn();
    const dayBefore = new Date("2026-11-10T23:59:59.999Z");
    expect(resolveSessionProviderModelSelection(session, layer, { now: dayBefore, readCachedLiveList }).model).toBe(MODEL);
    expect(resolveSessionProviderModelSelection(session, layer, { now: NOW, validateCatalog: false, readCachedLiveList }).model)
      .toBe(MODEL);
    expect(resolveSessionProviderModelSelection(session, { model_provider: "openrouter", model: "x-ai/grok-4.5" }, {
      now: NOW, readCachedLiveList,
    }).model).toBe("x-ai/grok-4.5");
    expect(readCachedLiveList).not.toHaveBeenCalled();
  });
});

describe("readSessionCachedLiveModelList", () => {
  test("records the cached list of the session's home and key", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    readSessionCachedLiveModelList(session, "openrouter");
    expect(published()).toEqual(["x-ai/grok-4.5", MODEL]);
  });

  test("leaves this process's list alone when the home has none to offer", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    // A list this process read itself, under another key.
    const body = JSON.stringify({ data: [{ id: "acme/own-read", name: "own" }] });
    const own = new OpenRouterCatalog({ fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => new Response(body)) });
    expect((await own.refresh()).source).toBe("live");
    readSessionCachedLiveModelList(session, "openrouter");
    expect(published()).toEqual(["acme/own-read"]);
  });

  test("does nothing for a provider whose list is not cached in the home, or a session with no home", async () => {
    const home = newHome();
    const { session } = daemonSession(home, { key: KEY });
    await anotherProcessCachesLiveList(home, KEY, ["x-ai/grok-4.5", MODEL]);
    for (const provider of ["venice", "deepseek", "ollama-cloud", ""]) readSessionCachedLiveModelList(session, provider);
    for (const homeless of [undefined, null, {}, { services: {} }, { services: { configStore: { current: () => ({}) } } },
      { services: { configStore: { homeContext: { path: 7 } } } }]) {
      readSessionCachedLiveModelList(homeless, "openrouter");
    }
    expect(published()).toBeUndefined();
  });
});

describe("openRouterCatalogForHome", () => {
  test("is the one catalog of a home and key, whoever asks", () => {
    const home = newHome();
    const context = resolveHomeContext({ AGENC_HOME: home }, { platformHome: home });
    expect(context.path).toBe(home);
    const keyed = openRouterCatalogForHome(context, { OPENROUTER_API_KEY: ` ${KEY} ` });
    expect(keyed).toBe(openRouterCatalogFor({ home, apiKey: KEY }));
    expect(keyed.cachePath).toBe(new OpenRouterCatalog({ home, apiKey: KEY }).cachePath);
    // No key in the environment and none saved: the public list.
    const keyless = openRouterCatalogForHome(context, undefined);
    expect(keyless).toBe(openRouterCatalogForHome(context, { OPENROUTER_API_KEY: "  " }));
    expect(keyless.cachePath).toBe(new OpenRouterCatalog({ home }).cachePath);
    expect(keyless.cachePath).not.toBe(keyed.cachePath);
  });

  test("uses the saved key when the environment has none, and the environment's over it", () => {
    const home = newHome();
    const context = resolveHomeContext({ AGENC_HOME: home }, { platformHome: home });
    saveProviderKey(context, "openrouter", "saved-fixture-key");
    expect(openRouterCatalogForHome(context, {}).cachePath)
      .toBe(new OpenRouterCatalog({ home, apiKey: "saved-fixture-key" }).cachePath);
    expect(openRouterCatalogForHome(context, { OPENROUTER_API_KEY: KEY }).cachePath)
      .toBe(new OpenRouterCatalog({ home, apiKey: KEY }).cachePath);
  });

  test("is the catalog the model menu reads, for a key in the environment, added since, or saved", () => {
    const home = newHome();
    const menu = (scene: Scene) => {
      const { session } = daemonSession(home, scene);
      return openRouterMenuCatalog({ argsRaw: "", cwd: home, home, session } as unknown as SlashCommandContext);
    };
    expect(menu({ key: KEY })).toBe(openRouterCatalogFor({ home, apiKey: KEY }));
    expect(menu({ keyAddedSince: "added-fixture-key" })).toBe(openRouterCatalogFor({ home, apiKey: "added-fixture-key" }));
    expect(menu({})).toBe(openRouterCatalogFor({ home }));
    saveProviderKey(resolveHomeContext({ AGENC_HOME: home }, { platformHome: home }), "openrouter", "saved-fixture-key");
    expect(menu({})).toBe(openRouterCatalogFor({ home, apiKey: "saved-fixture-key" }));
  });

  test("falls back to the public list when the saved key cannot be read", async () => {
    const home = newHome();
    // A home whose credential store cannot be reached.
    const unreadable = new Proxy(resolveHomeContext({ AGENC_HOME: home }, { platformHome: home }), {
      get(target, property, receiver) {
        if (property === "path") return Reflect.get(target, property, receiver);
        throw new Error("credential store unavailable");
      },
    }) as HomeContext;
    expect(openRouterCatalogForHome(unreadable, {}).cachePath).toBe(new OpenRouterCatalog({ home }).cachePath);

    // A session in that home, with no environment at all, still reads the public list's cache.
    await anotherProcessCachesLiveList(home, undefined, ["x-ai/grok-4.5", MODEL]);
    readSessionCachedLiveModelList({ services: { configStore: { homeContext: unreadable } } }, "openrouter");
    expect(published()).toEqual(["x-ai/grok-4.5", MODEL]);
  });
});
