import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchStartupInternalEvents } from "../../src/bin/startup-internal-events.js";
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

describe("startup internal-event transport authority", () => {
  test("keeps concurrent session proxy snapshots isolated from ambient mutation", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const environmentA = Object.freeze({
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
    });
    const environmentB = Object.freeze({});
    process.env.HTTPS_PROXY = "http://ambient.proxy.test:8080";

    await fetchStartupInternalEvents({
      sessionBaseUrl: "https://api.example.test/v1/code/sessions/session-a",
      headers: { Authorization: "Bearer a" },
      environment: environmentA,
    });
    await fetchStartupInternalEvents({
      sessionBaseUrl: "https://api.example.test/v1/code/sessions/session-b",
      headers: { Authorization: "Bearer b" },
      environment: environmentB,
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
