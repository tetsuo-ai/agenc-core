import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReactNode } from "react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveProviderKey } from "../auth/provider-keys.js";
import { readLocalByokCredential } from "../auth/native-credentials.js";
import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import { VENICE_MODELS, VENICE_TOOL_CALLS_NOT_DELIVERED } from "../llm/registry/venice-models.js";
import type { Session } from "../session/session.js";
import { chooseProviderModel } from "./providers-hub-actions.js";
import { openProvidersHub } from "./providers-hub.js";
import { readProvidersHubModels } from "./providers-hub-snapshot.js";
import type { SlashCommandContext } from "./types.js";
import { renderPtyRows } from "../../scripts/check-tui-e2e/harness.mjs";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";

// Opening the providers screen probes the local runtimes (Ollama, LM Studio,
// a local OpenAI-compatible server) on localhost. Report none running, so
// these tests make no network attempt; the Venice list comes from the local
// server below. The screen loads this module only for the probe. The stub is
// synchronous: with a factory that first loaded the real module, probes that
// started meanwhile reached the real one.
const localProbe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/onboarding/Onboarding.js", () => ({
  detectRunningLocalProviders: async () => {
    localProbe.calls += 1;
    return [];
  },
}));

// Venice's public GET /api/v1/models?type=text answer on 2026-10-15, saved
// as served (no credential involved): 133 text models, 128 with function calling.
const fixture = JSON.parse(readFileSync(new URL("../llm/fixtures/venice-models.json", import.meta.url), "utf8")) as {
  readonly data: readonly {
    readonly id: string;
    readonly type: string;
    readonly model_spec: { readonly offline?: boolean; readonly capabilities: { readonly supportsFunctionCalling?: boolean } };
  }[];
};
const TOOL_MODELS = fixture.data
  .filter(model => model.type === "text" && model.model_spec.capabilities.supportsFunctionCalling === true && model.model_spec.offline !== true &&
    !VENICE_TOOL_CALLS_NOT_DELIVERED.has(model.id))
  .map(model => model.id);
const KEY_A = "fake-venice-key-a";
const KEY_B = "fake-venice-key-b";
// The list a second account sees: proves a replaced key reads its own list.
const KEY_B_MODELS = ["zai-org-glm-5-2", "deepseek-v4-flash", "claude-opus-5-5", "kimi-k3", "qwen3-5-397b-a17b"];

const homes: string[] = [];
const servers: Server[] = [];
// Each test has its own home, so the menu's remembered lists never cross tests.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fakeVenice(options: { readonly modelsStatus?: number } = {}) {
  const authorizations: string[] = [];
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? "");
    // The key check before a key is saved (useApiKeyVerification): Venice
    // answers 200 for a key it knows.
    if (req.url === "/api/v1/api_keys/rate_limits") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: {} }));
      return;
    }
    if (req.url !== "/api/v1/models") {
      res.writeHead(404).end();
      return;
    }
    const status = options.modelsStatus ?? 200;
    const body = req.headers.authorization === `Bearer ${KEY_B}`
      ? { ...fixture, data: fixture.data.filter(model => KEY_B_MODELS.includes(model.id)) }
      : fixture;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify(body) : JSON.stringify({ error: "unavailable" }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return { baseURL: `http://127.0.0.1:${address.port}/api/v1`, authorizations };
}

function context(params: {
  /** Omit for Venice's own endpoint (a custom one counts as an open catalog). */
  readonly baseURL?: string;
  readonly provider: string;
  readonly model: string;
  readonly env?: Record<string, string>;
}): { readonly ctx: SlashCommandContext & { readonly session: Session & { pendingProviderSwitch: unknown } }; readonly home: HomeContext; readonly shown: () => ReactNode } {
  const path = mkdtempSync(join(tmpdir(), "agenc-venice-menu-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path, ...params.env });
  const home = resolveHomeContext(environment, { platformHome: tmpdir() });
  const config = params.baseURL === undefined ? {} : { providers: { venice: { base_url: params.baseURL } } };
  const configStore = {
    homeContext: home,
    current: () => config as ReturnType<ConfigStore["current"]>,
    reload: async () => ({}),
  };
  const services: Record<string, unknown> = { configStore, providerEnvironment: environment };
  const session = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration: {
          provider: { slug: params.provider },
          collaborationMode: { model: params.model },
        },
        history: [],
      }),
    },
    activeTurn: { unsafePeek: () => null },
    pendingProviderSwitch: null as unknown,
    // As the daemon-backed TUI session does: the key joins this session's
    // provider environment before it is saved.
    useSessionProviderKey: vi.fn(async (provider: string, apiKey: string) => {
      if (provider === "venice") {
        services.providerEnvironment = Object.freeze({ ...(services.providerEnvironment as EnvSnapshot), VENICE_API_KEY: apiKey });
      }
    }),
    services,
    setPendingProviderSwitch(next: unknown) {
      this.pendingProviderSwitch = next;
    },
  };
  let jsx: ReactNode = null;
  const ctx = {
    session: session as unknown as Session & { pendingProviderSwitch: unknown },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
    appState: { setToolJSX: (next: { readonly jsx?: ReactNode }) => { jsx = next.jsx ?? null; } },
  } as unknown as SlashCommandContext & { readonly session: Session & { pendingProviderSwitch: unknown } };
  return { ctx, home, shown: () => jsx };
}

async function mount(element: ReactNode) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = true;
  let written = "";
  stdout.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(<AppStateProvider initialState={getDefaultAppState()}>{element}</AppStateProvider>);
  await sleep();
  return {
    /** The screen as a terminal shows it now, lowercased (popup titles render in capitals). */
    screen(): string {
      return (renderPtyRows(written, { cols: 120, rows: 30 }) as string[]).join("\n").toLowerCase();
    },
    async press(...keys: string[]) {
      for (const key of keys) {
        stdin.write(key);
        await sleep();
      }
    },
    unmount: () => root.unmount(),
  };
}

function sleep(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function until(check: () => boolean, what: string, read: () => string): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 25) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}:\n${read()}`);
}

/** "venice ai · 128 models · key saved" */
function modelCount(screen: string): number | undefined {
  const match = /venice ai · (\d+) models?/u.exec(screen);
  return match === null ? undefined : Number(match[1]);
}

async function openHub(ctx: SlashCommandContext, shown: () => ReactNode, currentModels = false) {
  expect(openProvidersHub(ctx, { currentModels })).toBe(true);
  return await mount(shown());
}

describe("Venice models in the providers screen", () => {
  it("lists every tool-capable model Venice serves, with the key from the environment", async () => {
    const venice = await fakeVenice();
    const { ctx, shown } = context({ baseURL: venice.baseURL, provider: "venice", model: "zai-org-glm-5-2", env: { VENICE_API_KEY: KEY_A } });
    expect(TOOL_MODELS.length).toBeGreaterThan(100);
    const hub = await openHub(ctx, shown, true);
    try {
      await until(() => modelCount(hub.screen()) === TOOL_MODELS.length, "the live list", () => hub.screen());
      expect(hub.screen()).not.toContain("bundled");
      const listed = readProvidersHubModels(ctx, "venice").map(row => row.model);
      expect([...listed].sort()).toEqual([...TOOL_MODELS].sort());
      expect(listed).toEqual(expect.arrayContaining(["deepseek-v4-flash", "claude-opus-5-5", "qwen3-5-397b-a17b", "e2ee-deepseek-v4-flash"]));
      // Listed by Venice, but without function calling.
      expect(listed).not.toContain("hermes-3-llama-3.1-405b");
      expect(listed).not.toContain("grok-4-20-multi-agent");
      expect(venice.authorizations).toEqual([`Bearer ${KEY_A}`]);
      // The screen asked about local runtimes, and got the stub's answer.
      expect(localProbe.calls).toBeGreaterThan(0);
    } finally {
      hub.unmount();
    }
  });

  it("reads Venice's list with the key saved on this computer", async () => {
    const venice = await fakeVenice();
    const { ctx, home, shown } = context({ baseURL: venice.baseURL, provider: "venice", model: "zai-org-glm-5-2" });
    saveProviderKey(home, "venice", KEY_A);
    const hub = await openHub(ctx, shown, true);
    try {
      await until(() => modelCount(hub.screen()) === TOOL_MODELS.length, "the live list", () => hub.screen());
      expect(hub.screen()).toContain("venice ai · " + TOOL_MODELS.length + " models · key saved");
      expect(venice.authorizations).toEqual([`Bearer ${KEY_A}`]);
    } finally {
      hub.unmount();
    }
  });

  it("reads the list again when a key is saved or replaced in the menu, without a restart", async () => {
    const venice = await fakeVenice();
    const { ctx, home, shown } = context({ baseURL: venice.baseURL, provider: "grok", model: "grok-4.6" });
    const hub = await openHub(ctx, shown);
    try {
      await hub.press(..."venice", "\r");
      await until(() => hub.screen().includes("venice ai api key"), "the key prompt", () => hub.screen());
      await hub.press(...KEY_A, "\r");
      await until(() => modelCount(hub.screen()) === TOOL_MODELS.length, "the list for the saved key", () => hub.screen());
      expect(readLocalByokCredential(home, "venice")?.apiKey).toBe(KEY_A);

      // "Replace API key" sits just before "Remove saved key", at the end.
      await hub.press("\u001b[A", "\u001b[A");
      expect(hub.screen()).toMatch(/▌\s+replace api key/u);
      await hub.press("\r", ...KEY_B, "\r");
      await until(() => modelCount(hub.screen()) === KEY_B_MODELS.length, "the list for the replaced key", () => hub.screen());
      expect(readProvidersHubModels(ctx, "venice").map(row => row.model).sort()).toEqual([...KEY_B_MODELS].sort());
      expect(venice.authorizations).toContain(`Bearer ${KEY_B}`);
      expect(hub.screen()).not.toContain(KEY_A);
      expect(hub.screen()).not.toContain(KEY_B);
    } finally {
      hub.unmount();
    }
  });

  it("keeps the bundled list and says so when Venice's list cannot be read", async () => {
    const venice = await fakeVenice({ modelsStatus: 503 });
    const { ctx, shown } = context({ baseURL: venice.baseURL, provider: "venice", model: "zai-org-glm-5-2", env: { VENICE_API_KEY: KEY_A } });
    const hub = await openHub(ctx, shown, true);
    try {
      await until(() => hub.screen().includes("could not load venice's model list, showing the bundled ones."), "the note", () => hub.screen());
      expect(modelCount(hub.screen())).toBe(VENICE_MODELS.length);
    } finally {
      hub.unmount();
    }
  });

  it("switches to a model only Venice's live list has and keeps it as the default", async () => {
    // Venice's own endpoint: the selection check must not treat it as a fixed catalog.
    const { ctx, home } = context({ provider: "grok", model: "grok-4.6", env: { VENICE_API_KEY: KEY_A } });
    expect(VENICE_MODELS.map(model => model.model)).not.toContain("deepseek-v4-flash");

    await expect(chooseProviderModel(ctx, "venice", "deepseek-v4-flash")).resolves.toEqual({
      ok: true,
      message: "Using Venice AI · deepseek-v4-flash, saved as the default.",
    });
    expect(ctx.session.pendingProviderSwitch).toEqual({ provider: "venice", model: "deepseek-v4-flash" });
    expect(readFileSync(home.configTomlPath, "utf8")).toMatch(/^"?model"? = "deepseek-v4-flash"$/mu);
  });
});
