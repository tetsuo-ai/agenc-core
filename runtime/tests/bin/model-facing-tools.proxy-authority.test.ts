import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { createProvider } from "../../src/llm/provider.js";
import type { Session } from "../../src/session/session.js";
import { clearProxyCache } from "../../src/utils/proxy.js";
import { resolveSecureStorageHome } from "../../src/utils/secureStorage/home.js";
import { saveXaiOauthCredentials } from "../../src/utils/xaiOauthCredentials.js";

const originalFetch = globalThis.fetch;
const originalHttpsProxy = process.env.HTTPS_PROXY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = originalHttpsProxy;
  clearProxyCache();
  vi.restoreAllMocks();
});

describe("model-facing HTTP transport authority", () => {
  test("bootstrap defers both media tools when stored xAI OAuth is bound away from a custom URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-bootstrap-oauth-"));
    try {
      const env = { XAI_BASE_URL: "https://gateway.example.test/v1" };
      expect(saveXaiOauthCredentials(resolveSecureStorageHome(env, root), {
        accessToken: "stored-xai-oauth",
      }).success).toBe(true);

      const tools = createModelFacingTools({
        workspaceRoot: root,
        agencHome: root,
        getSession: () => null,
        env,
      });
      for (const name of ["ImagineImage", "ImagineVideo"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.metadata?.deferred).toBe(true);
        const result = await tool!.execute({ prompt: "no media backend" });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("xAI sign-in credentials are bound");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unrelated session finds OpenAI media behind unusable xAI OAuth", async () => {
    const root = await mkdtemp(join(tmpdir(), "media-openai-fallback-"));
    try {
      const env = {
        XAI_BASE_URL: "https://gateway.example.test/v1",
        OPENAI_API_KEY: "independent-openai-media-key",
      };
      expect(saveXaiOauthCredentials(resolveSecureStorageHome(env, root), {
        accessToken: "stored-xai-oauth",
      }).success).toBe(true);
      const provider = createProvider("zai-coding-plan", {
        apiKey: "reasoning-only-key",
        model: "glm-5.3",
      });

      const tools = createModelFacingTools({
        workspaceRoot: root,
        agencHome: root,
        getSession: () => ({ services: { provider } }) as unknown as Session,
        env,
      });
      for (const name of ["ImagineImage", "ImagineVideo"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        expect(tool?.metadata?.deferred).not.toBe(true);
        expect(tool?.description).toContain("OpenAI");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("registers XSearch with a Grok session API key on a custom URL", () => {
    const provider = createProvider("grok", {
      apiKey: "gateway-api-key",
      model: "grok-4.6",
      baseURL: "https://gateway.example.test/v1",
      extra: { authMode: "api_key" },
    });
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => ({ services: { provider } }) as unknown as Session,
      env: {},
    });

    expect(tools.some((tool) => tool.name === "XSearch")).toBe(true);
  });

  test("snapshots each tool registry environment before later mutation", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const mutableEnvironmentA: NodeJS.ProcessEnv = {
      AGENC_WEB_SEARCH_ENDPOINT: "https://session-a.example.test/search",
      AGENC_WEB_SEARCH_KIND: "json",
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
    };
    const toolsA = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      env: mutableEnvironmentA,
    });
    delete mutableEnvironmentA.HTTPS_PROXY;
    const toolsB = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => null,
      env: {
        AGENC_WEB_SEARCH_ENDPOINT: "https://session-b.example.test/search",
        AGENC_WEB_SEARCH_KIND: "json",
      },
    });
    process.env.HTTPS_PROXY = "http://ambient.proxy.test:8080";

    await toolsA.find((tool) => tool.name === "WebSearch")!.execute({
      query: "session a",
    });
    await toolsB.find((tool) => tool.name === "WebSearch")!.execute({
      query: "session b",
    });

    const dispatcherA = (calls[0] as RequestInit & { dispatcher?: object })
      .dispatcher;
    const dispatcherB = (calls[1] as RequestInit & { dispatcher?: object })
      .dispatcher;
    expect(dispatcherA?.constructor.name).toBe("EnvHttpProxyAgent");
    expect(dispatcherB?.constructor.name).toBe("Agent");
    expect(dispatcherA).not.toBe(dispatcherB);
  });
});
