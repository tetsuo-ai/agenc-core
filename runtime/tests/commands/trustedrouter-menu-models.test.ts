import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { saveProviderKey } from "../../src/auth/provider-keys.js";
import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import {
  parseTrustedRouterModels,
  TRUSTEDROUTER_MODELS,
} from "../../src/llm/registry/trustedrouter-models.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import {
  loadTrustedRouterMenuModels,
  readTrustedRouterMenuModels,
} from "../../src/commands/trustedrouter-menu-models.js";

const fixture = JSON.parse(
  readFileSync(new URL("../llm/fixtures/trustedrouter-models.json", import.meta.url), "utf8"),
);
const EXPECTED_MODELS = parseTrustedRouterModels(fixture).map((entry) => entry.model);

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
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

async function fakeTrustedRouter() {
  const state = { status: 200, authorizations: [] as string[] };
  const server = createServer((req, res) => {
    state.authorizations.push(req.headers.authorization ?? "");
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(state.status === 200 ? JSON.stringify(fixture) : "{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no server address");
  }
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, state };
}

function context(
  baseURL: string,
  env: Record<string, string> = {},
): { readonly ctx: SlashCommandContext; readonly home: HomeContext } {
  const path = mkdtempSync(join(tmpdir(), "agenc-trustedrouter-list-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path, ...env });
  const home = resolveHomeContext(environment, { platformHome: tmpdir() });
  const configStore = {
    homeContext: home,
    current: () =>
      ({
        providers: { trustedrouter: { base_url: baseURL } },
      }) as ReturnType<ConfigStore["current"]>,
  };
  const ctx = {
    session: { services: { configStore, providerEnvironment: environment } },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  } as unknown as SlashCommandContext;
  return { ctx, home };
}

describe("TrustedRouter's model list for the menus", () => {
  it("does not ask TrustedRouter without a key", async () => {
    const tr = await fakeTrustedRouter();
    const { ctx } = context(tr.baseURL);
    await expect(loadTrustedRouterMenuModels(ctx)).resolves.toEqual({
      source: "bundled",
      reason: "no-key",
      models: TRUSTEDROUTER_MODELS,
    });
    expect(readTrustedRouterMenuModels(ctx)).toBeUndefined();
    expect(tr.state.authorizations).toEqual([]);
  });

  it("asks with the environment key before the saved one, as the session does", async () => {
    const tr = await fakeTrustedRouter();
    const { ctx, home } = context(tr.baseURL, { TRUSTEDROUTER_API_KEY: "fake-env-key" });
    saveProviderKey(home, "trustedrouter", "fake-saved-key");
    const result = await loadTrustedRouterMenuModels(ctx);
    expect(result.source).toBe("live");
    expect(result.models.map((model) => model.model)).toEqual(EXPECTED_MODELS);
    expect(result.models.length).toBeGreaterThan(550);
    expect(tr.state.authorizations).toEqual(["Bearer fake-env-key"]);
  });

  it("reuses a list for the same key and asks again with another key", async () => {
    const tr = await fakeTrustedRouter();
    const first = context(tr.baseURL, { TRUSTEDROUTER_API_KEY: "fake-key-one" });
    await loadTrustedRouterMenuModels(first.ctx);
    await loadTrustedRouterMenuModels(first.ctx);
    expect(readTrustedRouterMenuModels(first.ctx)).toHaveLength(EXPECTED_MODELS.length);
    expect(tr.state.authorizations).toEqual(["Bearer fake-key-one"]);

    const { ctx } = context(tr.baseURL, { TRUSTEDROUTER_API_KEY: "fake-key-two" });
    expect(readTrustedRouterMenuModels(ctx)).toBeUndefined();
    await loadTrustedRouterMenuModels(ctx);
    expect(tr.state.authorizations).toEqual(["Bearer fake-key-one", "Bearer fake-key-two"]);
  });

  it("keeps no failed answer: the next open asks again", async () => {
    const tr = await fakeTrustedRouter();
    tr.state.status = 503;
    const { ctx } = context(tr.baseURL, { TRUSTEDROUTER_API_KEY: "fake-env-key" });
    await expect(loadTrustedRouterMenuModels(ctx)).resolves.toEqual({
      source: "bundled",
      reason: "unavailable",
      models: TRUSTEDROUTER_MODELS,
    });
    expect(readTrustedRouterMenuModels(ctx)).toBeUndefined();

    tr.state.status = 200;
    await expect(loadTrustedRouterMenuModels(ctx)).resolves.toMatchObject({ source: "live" });
    expect(readTrustedRouterMenuModels(ctx)).toHaveLength(EXPECTED_MODELS.length);
    expect(tr.state.authorizations).toHaveLength(2);
  });
});
