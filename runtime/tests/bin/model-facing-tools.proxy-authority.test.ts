import { afterEach, describe, expect, test, vi } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import { clearProxyCache } from "../../src/utils/proxy.js";

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
