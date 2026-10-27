import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { EnvSnapshot } from "../config/env.js";
import { resolveHomeContext } from "../config/home.js";
import type { ConfigStore } from "../config/store.js";
import type { SlashCommandContext } from "./types.js";
import {
  loadOllamaMenuModels,
  parseOllamaTags,
  readOllamaMenuModels,
} from "./ollama-menu-models.js";
import { readProvidersHubModels } from "./providers-hub-snapshot.js";
import { modelCapabilityTags } from "./model-capability-tags.js";

/**
 * `GET /api/tags` rows with the `capabilities` field from Ollama's list response
 * type (trimmed; written from the type, not recorded from a live server).
 */
const TAGS = {
  models: [
    { name: "qwen3:8b", model: "qwen3:8b", details: { parameter_size: "8.2B" }, capabilities: ["completion", "tools", "thinking"] },
    { name: "gpt-oss:20b", model: "gpt-oss:20b", details: { parameter_size: "20.9B" }, capabilities: ["completion", "tools", "thinking"] },
    { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", capabilities: ["embedding"] },
    { name: "deepseek-r1:7b", model: "deepseek-r1:7b", capabilities: ["completion", "thinking"] },
    { name: "llava:7b", model: "llava:7b", capabilities: ["completion", "vision"] },
  ],
};

const homes: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fakeOllama(status = 200) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify(TAGS) : "{}");
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no server address");
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

function context(env: Record<string, string>, session: { provider: string; model: string } = { provider: "ollama", model: "gpt-oss:20b" }): SlashCommandContext {
  const path = mkdtempSync(join(tmpdir(), "agenc-ollama-list-"));
  homes.push(path);
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: path, ...env });
  const configStore = {
    homeContext: resolveHomeContext(environment, { platformHome: tmpdir() }),
    current: () => ({}) as ReturnType<ConfigStore["current"]>,
    reload: async () => ({}),
  };
  return {
    session: {
      state: {
        unsafePeek: () => ({
          sessionConfiguration: { provider: { slug: session.provider }, collaborationMode: { model: session.model } },
          history: [],
        }),
      },
      activeTurn: { unsafePeek: () => null },
      services: { configStore, providerEnvironment: environment },
    },
    argsRaw: "",
    cwd: "/ws",
    home: "/home/test",
  } as unknown as SlashCommandContext;
}

describe("local Ollama's installed models for the menus", () => {
  it("keeps models that complete text, sorted, and leaves embedding models out", () => {
    expect(parseOllamaTags(TAGS)?.map(model => model.model))
      .toEqual(["deepseek-r1:7b", "gpt-oss:20b", "llava:7b", "qwen3:8b"]);
    // An older server reports no capabilities: every model is kept.
    expect(parseOllamaTags({ models: [{ name: "llama3.1:8b" }] })).toEqual([{ model: "llama3.1:8b" }]);
    expect(parseOllamaTags({})).toBeUndefined();
  });

  it("asks the server the session uses, even when its address carries /v1", async () => {
    const ollama = await fakeOllama();
    const ctx = context({ OLLAMA_BASE_URL: `${ollama.url}/v1` });
    expect(readOllamaMenuModels(ctx)).toBeUndefined();
    const models = await loadOllamaMenuModels(ctx);
    expect(models?.map(model => model.model)).toEqual(["deepseek-r1:7b", "gpt-oss:20b", "llava:7b", "qwen3:8b"]);
    expect(ollama.paths).toEqual(["/api/tags"]);
    expect(readOllamaMenuModels(ctx)?.length).toBe(4);
  });

  it("the providers screen lists the installed models with what they can do", async () => {
    const ollama = await fakeOllama();
    const ctx = context({ OLLAMA_BASE_URL: ollama.url });
    await loadOllamaMenuModels(ctx);
    const rows = readProvidersHubModels(ctx, "ollama");
    expect(rows.map(row => row.model)).toEqual(expect.arrayContaining(["qwen3:8b", "gpt-oss:20b", "deepseek-r1:7b", "llava:7b"]));
    expect(rows.find(row => row.model === "gpt-oss:20b")?.current).toBe(true);
    expect(modelCapabilityTags("ollama", "qwen3:8b")).toBe("thinking");
    expect(modelCapabilityTags("ollama", "deepseek-r1:7b")).toBe("thinking · no tools");
    expect(modelCapabilityTags("ollama", "llava:7b")).toBe("vision · no tools");
  });

  it("a server that cannot be read leaves the menus on the bundled list", async () => {
    const ollama = await fakeOllama(500);
    const ctx = context({ OLLAMA_BASE_URL: ollama.url });
    await expect(loadOllamaMenuModels(ctx)).resolves.toBeUndefined();
    expect(readOllamaMenuModels(ctx)).toBeUndefined();
  });
});
