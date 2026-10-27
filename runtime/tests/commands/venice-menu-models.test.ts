import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { saveProviderKey } from "../auth/provider-keys.js";
import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import { VENICE_MODELS, VENICE_TOOL_CALLS_NOT_DELIVERED } from "../llm/registry/venice-models.js";
import type { SlashCommandContext } from "./types.js";
import { loadVeniceMenuModels, readVeniceMenuModels } from "./venice-menu-models.js";

const fixture = JSON.parse(readFileSync(new URL("../llm/fixtures/venice-models.json", import.meta.url), "utf8")) as {
  readonly data: readonly { readonly id: string; readonly model_spec: { readonly capabilities: { readonly supportsFunctionCalling?: boolean } } }[];
};
const TOOL_MODELS = fixture.data
  .filter(model => model.model_spec.capabilities.supportsFunctionCalling === true && !VENICE_TOOL_CALLS_NOT_DELIVERED.has(model.id))
  .map(model => model.id);

const homes: string[] = [];
const servers: Server[] = [];
// Each test has its own home, and a list is remembered per home and key.
afterEach(async () => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fakeVenice() {
  const state = { status: 200, authorizations: [] as string[] };
  const server = createServer((req, res) => {
    state.authorizations.push(req.headers.authorization ?? "");
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(state.status === 200 ? JSON.stringify(fixture) : "{}");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return { baseURL: `http://127.0.0.1:${address.port}/api/v1`, state };
}

function context(baseURL: string, env: Record<string, string> = {}): { readonly ctx: SlashCommandContext; readonly home: HomeContext } {
  const path = mkdtempSync(join(tmpdir(), "agenc-venice-list-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path, ...env });
  const home = resolveHomeContext(environment, { platformHome: tmpdir() });
  const configStore = {
    homeContext: home,
    current: () => ({ providers: { venice: { base_url: baseURL } } }) as ReturnType<ConfigStore["current"]>,
  };
  const ctx = {
    session: { services: { configStore, providerEnvironment: environment } },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  } as unknown as SlashCommandContext;
  return { ctx, home };
}

describe("Venice's model list for the menus", () => {
  it("does not ask Venice without a key", async () => {
    const venice = await fakeVenice();
    const { ctx } = context(venice.baseURL);
    await expect(loadVeniceMenuModels(ctx)).resolves.toEqual({ source: "bundled", reason: "no-key", models: VENICE_MODELS });
    expect(readVeniceMenuModels(ctx)).toBeUndefined();
    expect(venice.state.authorizations).toEqual([]);
  });

  it("asks with the environment key before the saved one, as the session does", async () => {
    const venice = await fakeVenice();
    const { ctx, home } = context(venice.baseURL, { VENICE_API_KEY: "fake-env-key" });
    saveProviderKey(home, "venice", "fake-saved-key");
    const result = await loadVeniceMenuModels(ctx);
    expect(result.source).toBe("live");
    expect(result.models.map(model => model.model)).toEqual(expect.arrayContaining(TOOL_MODELS));
    expect(result.models).toHaveLength(TOOL_MODELS.length);
    expect(venice.state.authorizations).toEqual(["Bearer fake-env-key"]);
  });

  it("reuses a list for the same key and asks again with another key", async () => {
    const venice = await fakeVenice();
    const first = context(venice.baseURL, { VENICE_API_KEY: "fake-key-one" });
    await loadVeniceMenuModels(first.ctx);
    await loadVeniceMenuModels(first.ctx);
    expect(readVeniceMenuModels(first.ctx)).toHaveLength(TOOL_MODELS.length);
    expect(venice.state.authorizations).toEqual(["Bearer fake-key-one"]);

    const { ctx } = context(venice.baseURL, { VENICE_API_KEY: "fake-key-two" });
    expect(readVeniceMenuModels(ctx)).toBeUndefined();
    await loadVeniceMenuModels(ctx);
    expect(venice.state.authorizations).toEqual(["Bearer fake-key-one", "Bearer fake-key-two"]);
  });

  it("keeps no failed answer: the next open asks again", async () => {
    const venice = await fakeVenice();
    venice.state.status = 503;
    const { ctx } = context(venice.baseURL, { VENICE_API_KEY: "fake-env-key" });
    await expect(loadVeniceMenuModels(ctx)).resolves.toEqual({ source: "bundled", reason: "unavailable", models: VENICE_MODELS });
    expect(readVeniceMenuModels(ctx)).toBeUndefined();

    venice.state.status = 200;
    await expect(loadVeniceMenuModels(ctx)).resolves.toMatchObject({ source: "live" });
    expect(readVeniceMenuModels(ctx)).toHaveLength(TOOL_MODELS.length);
    expect(venice.state.authorizations).toHaveLength(2);
  });
});
