import { afterEach, describe, expect, test, vi } from "vitest";

import { listOpenAICompatibleModels } from "../../src/utils/providerDiscovery.js";
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

describe("provider discovery transport authority", () => {
  test("uses the supplied provider environment for each request", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env.HTTPS_PROXY = "http://ambient.proxy.test:8080";

    await listOpenAICompatibleModels({
      baseUrl: "https://session-a.example.test/v1",
      environment: Object.freeze({
        HTTPS_PROXY: "http://session-a.proxy.test:8080",
      }),
    });
    await listOpenAICompatibleModels({
      baseUrl: "https://session-b.example.test/v1",
      environment: Object.freeze({}),
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
