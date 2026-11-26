import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReactNode } from "react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveProviderKey } from "../../src/auth/provider-keys.js";
import { readLocalByokCredential } from "../../src/auth/native-credentials.js";
import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import {
  parseTrustedRouterModels,
  TRUSTEDROUTER_MODELS,
} from "../../src/llm/registry/trustedrouter-models.js";
import type { Session } from "../../src/session/session.js";
import { chooseProviderModel } from "../../src/commands/providers-hub-actions.js";
import { openProvidersHub } from "../../src/commands/providers-hub.js";
import { readProvidersHubModels } from "../../src/commands/providers-hub-snapshot.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import { renderPtyRows } from "../../scripts/check-tui-e2e/harness.mjs";
import { createRoot } from "../../src/tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";

const localProbe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/onboarding/Onboarding.js", () => ({
  detectRunningLocalProviders: async () => {
    localProbe.calls += 1;
    return [];
  },
}));

const fixture = JSON.parse(
  readFileSync(new URL("../llm/fixtures/trustedrouter-models.json", import.meta.url), "utf8"),
) as { readonly data: readonly { readonly id: string }[] };
const PUBLIC_MODELS = parseTrustedRouterModels(fixture).map((entry) => entry.model);
const KEY_A = "fake-trustedrouter-key-a";
const KEY_B = "fake-trustedrouter-key-b";
const KEY_B_CANONICAL_IDS = [
  "trustedrouter/auto",
  "trustedrouter/zdr",
  "trustedrouter/e2e",
  "anthropic/claude-opus-4.5",
  "deepseek/deepseek-v4.1-flash",
];
const KEY_B_EXPECTED_COUNT = parseTrustedRouterModels({
  data: fixture.data.filter((model) => KEY_B_CANONICAL_IDS.includes(model.id)),
}).length;

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function fakeTrustedRouter(options: { readonly modelsStatus?: number } = {}) {
  const authorizations: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/key") {
      const ok =
        req.headers.authorization === `Bearer ${KEY_A}` ||
        req.headers.authorization === `Bearer ${KEY_B}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { data: { label: "fixture" } } : { error: "unauthorized" }));
      return;
    }
    authorizations.push(req.headers.authorization ?? "");
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    const status = options.modelsStatus ?? 200;
    const body =
      req.headers.authorization === `Bearer ${KEY_B}`
        ? {
            ...fixture,
            data: fixture.data.filter((model) => KEY_B_CANONICAL_IDS.includes(model.id)),
          }
        : fixture;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify(body) : JSON.stringify({ error: "unavailable" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no server address");
  }
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, authorizations };
}

function context(params: {
  readonly baseURL?: string;
  readonly provider: string;
  readonly model: string;
  readonly env?: Record<string, string>;
}): {
  readonly ctx: SlashCommandContext & {
    readonly session: Session & { pendingProviderSwitch: unknown };
  };
  readonly home: HomeContext;
  readonly shown: () => ReactNode;
} {
  const path = mkdtempSync(join(tmpdir(), "agenc-trustedrouter-menu-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path, ...params.env });
  const home = resolveHomeContext(environment, { platformHome: tmpdir() });
  const config =
    params.baseURL === undefined
      ? {}
      : { providers: { trustedrouter: { base_url: params.baseURL } } };
  const configStore = {
    homeContext: home,
    current: () => config as ReturnType<ConfigStore["current"]>,
    reload: async () => ({}),
  };
  const services: Record<string, unknown> = {
    configStore,
    providerEnvironment: environment,
  };
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
    useSessionProviderKey: vi.fn(async (provider: string, apiKey: string) => {
      if (provider === "trustedrouter") {
        services.providerEnvironment = Object.freeze({
          ...(services.providerEnvironment as EnvSnapshot),
          TRUSTEDROUTER_API_KEY: apiKey,
        });
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
    appState: {
      setToolJSX: (next: { readonly jsx?: ReactNode }) => {
        jsx = next.jsx ?? null;
      },
    },
  } as unknown as SlashCommandContext & {
    readonly session: Session & { pendingProviderSwitch: unknown };
  };
  return { ctx, home, shown: () => jsx };
}

async function mount(element: ReactNode) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
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
  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>{element}</AppStateProvider>,
  );
  await sleep();
  return {
    screen(): string {
      return (renderPtyRows(written, { cols: 120, rows: 30 }) as string[])
        .join("\n")
        .toLowerCase();
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, what: string, read: () => string): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 25) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}:\n${read()}`);
}

function modelCount(screen: string): number | undefined {
  const match = /trustedrouter · (\d+) models?/u.exec(screen);
  return match === null ? undefined : Number(match[1]);
}

async function openHub(
  ctx: SlashCommandContext,
  shown: () => ReactNode,
  currentModels = false,
) {
  expect(openProvidersHub(ctx, { currentModels })).toBe(true);
  return await mount(shown());
}

describe("TrustedRouter models in the providers screen", () => {
  it("lists every public chat model, preset, and nyte/* alias with the env key", async () => {
    const tr = await fakeTrustedRouter();
    const { ctx, shown } = context({
      baseURL: tr.baseURL,
      provider: "trustedrouter",
      model: "trustedrouter/auto",
      env: { TRUSTEDROUTER_API_KEY: KEY_A },
    });
    expect(PUBLIC_MODELS.length).toBeGreaterThan(550);
    const hub = await openHub(ctx, shown, true);
    try {
      await until(
        () => modelCount(hub.screen()) === PUBLIC_MODELS.length,
        "the live list",
        () => hub.screen(),
      );
      expect(hub.screen()).not.toContain("bundled");
      const listed = readProvidersHubModels(ctx, "trustedrouter").map((row) => row.model);
      expect(listed).toEqual(PUBLIC_MODELS);
      expect(listed).toEqual(
        expect.arrayContaining([
          "trustedrouter/auto",
          "trustedrouter/zdr",
          "trustedrouter/e2e",
          "trustedrouter/fast",
          "trustedrouter/cheap",
          "trustedrouter/free",
          "nyte/auto",
          "nyte/zdr",
          "nyte/e2e",
          "anthropic/claude-opus-4.5",
          "deepseek/deepseek-v4.1-flash",
          "openai/gpt-5.4",
        ]),
      );
      expect(listed).not.toContain("trustedrouter/fixture-internal-only");
      expect(listed).not.toContain("trustedrouter/fixture-synthetic-monitor");
      expect(tr.authorizations).toEqual([`Bearer ${KEY_A}`]);
      expect(localProbe.calls).toBeGreaterThan(0);
    } finally {
      hub.unmount();
    }
  });

  it("reads TrustedRouter's list with the key saved on this computer", async () => {
    const tr = await fakeTrustedRouter();
    const { ctx, home, shown } = context({
      baseURL: tr.baseURL,
      provider: "trustedrouter",
      model: "trustedrouter/auto",
    });
    saveProviderKey(home, "trustedrouter", KEY_A);
    const hub = await openHub(ctx, shown, true);
    try {
      await until(
        () => modelCount(hub.screen()) === PUBLIC_MODELS.length,
        "the live list",
        () => hub.screen(),
      );
      expect(hub.screen()).toContain(
        "trustedrouter · " + PUBLIC_MODELS.length + " models · key saved",
      );
      expect(tr.authorizations).toEqual([`Bearer ${KEY_A}`]);
    } finally {
      hub.unmount();
    }
  });

  it("reads the list again when a key is saved or replaced in the menu, without a restart", async () => {
    const tr = await fakeTrustedRouter();
    const { ctx, home, shown } = context({
      baseURL: tr.baseURL,
      provider: "grok",
      model: "grok-4.6",
    });
    const hub = await openHub(ctx, shown);
    try {
      await hub.press(..."trustedrouter", "\r");
      await until(
        () => hub.screen().includes("trustedrouter api key"),
        "the key prompt",
        () => hub.screen(),
      );
      await hub.press(...KEY_A, "\r");
      await until(
        () => modelCount(hub.screen()) === PUBLIC_MODELS.length,
        "the list for the saved key",
        () => hub.screen(),
      );
      expect(readLocalByokCredential(home, "trustedrouter")?.apiKey).toBe(KEY_A);

      // "Replace API key" sits just before "Remove saved key", at the end.
      await hub.press("\u001b[A", "\u001b[A");
      expect(hub.screen()).toMatch(/▌\s+replace api key/u);
      await hub.press("\r", ...KEY_B, "\r");
      await until(
        () => modelCount(hub.screen()) === KEY_B_EXPECTED_COUNT,
        "the list for the replaced key",
        () => hub.screen(),
      );
      expect(readProvidersHubModels(ctx, "trustedrouter")).toHaveLength(KEY_B_EXPECTED_COUNT);
      expect(tr.authorizations).toContain(`Bearer ${KEY_B}`);
      expect(hub.screen()).not.toContain(KEY_A);
      expect(hub.screen()).not.toContain(KEY_B);
    } finally {
      hub.unmount();
    }
  });

  it("keeps the bundled list and says so when TrustedRouter's list cannot be read", async () => {
    const tr = await fakeTrustedRouter({ modelsStatus: 503 });
    const { ctx, shown } = context({
      baseURL: tr.baseURL,
      provider: "trustedrouter",
      model: "trustedrouter/auto",
      env: { TRUSTEDROUTER_API_KEY: KEY_A },
    });
    const hub = await openHub(ctx, shown, true);
    try {
      await until(
        () =>
          hub
            .screen()
            .includes("could not load trustedrouter's model list, showing the bundled ones."),
        "the note",
        () => hub.screen(),
      );
      expect(modelCount(hub.screen())).toBe(TRUSTEDROUTER_MODELS.length);
    } finally {
      hub.unmount();
    }
  });

  it("switches to a live-only model and a nyte/* alias and keeps it as the default", async () => {
    const { ctx, home } = context({
      provider: "grok",
      model: "grok-4.6",
      env: { TRUSTEDROUTER_API_KEY: KEY_A },
    });
    expect(TRUSTEDROUTER_MODELS.map((model) => model.model)).not.toContain(
      "deepseek/deepseek-v4.1-flash",
    );

    await expect(
      chooseProviderModel(ctx, "trustedrouter", "deepseek/deepseek-v4.1-flash"),
    ).resolves.toEqual({
      ok: true,
      message: "Using TrustedRouter · deepseek/deepseek-v4.1-flash, saved as the default.",
    });
    expect(ctx.session.pendingProviderSwitch).toEqual({
      provider: "trustedrouter",
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(readFileSync(home.configTomlPath, "utf8")).toMatch(
      /^"?model"? = "deepseek\/deepseek-v4\.1-flash"$/mu,
    );

    await expect(chooseProviderModel(ctx, "trustedrouter", "nyte/zdr")).resolves.toEqual({
      ok: true,
      message: "Using TrustedRouter · nyte/zdr, saved as the default.",
    });
  });
});
