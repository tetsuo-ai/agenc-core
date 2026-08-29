import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { clearMTLSCache, getMTLSConfig } from "../../src/utils/mtls.js";
import { RemoteAuthBackend } from "../../src/auth/backends/remote.js";
import {
  clearProxyCache,
  createAxiosInstance,
  getProxyAgent,
  getProxyFetchOptions,
  getWebSocketProxyUrl,
} from "../../src/utils/proxy.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  clearMTLSCache();
  clearProxyCache();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("session-owned proxy and TLS authority", () => {
  test("resolves proxy bypass from the supplied snapshot after ambient mutation", async () => {
    const environmentA = Object.freeze({
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
      NO_PROXY: "direct.example.test",
    });
    const environmentB = Object.freeze({
      HTTPS_PROXY: "http://session-b.proxy.test:8080",
      NO_PROXY: "proxied.example.test",
    });
    const previousProxy = process.env.HTTPS_PROXY;
    const previousNoProxy = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = "http://mutated-daemon.proxy.test:8080";
    process.env.NO_PROXY = "*";
    const originalGlobalDispatcher = getGlobalDispatcher();
    const contaminatedGlobalDispatcher = getProxyAgent(
      "http://daemon-global.proxy.test:8080",
      Object.freeze({
        HTTPS_PROXY: "http://daemon-global.proxy.test:8080",
      }),
    );
    setGlobalDispatcher(contaminatedGlobalDispatcher);
    try {
      expect(
        getWebSocketProxyUrl("wss://proxied.example.test/mcp", environmentA),
      ).toBe("http://session-a.proxy.test:8080");
      expect(
        getWebSocketProxyUrl("wss://proxied.example.test/mcp", environmentB),
      ).toBeUndefined();

      const dispatcherA = getProxyFetchOptions({
        environment: environmentA,
      }).dispatcher;
      const dispatcherB = getProxyFetchOptions({
        environment: environmentB,
      }).dispatcher;
      expect(dispatcherA).toBeDefined();
      expect(dispatcherB).toBeDefined();
      expect(dispatcherA).not.toBe(dispatcherB);

      const directEnvironmentA = Object.freeze({});
      const directEnvironmentB = Object.freeze({});
      const directDispatcherA = getProxyFetchOptions({
        environment: directEnvironmentA,
      }).dispatcher;
      const directDispatcherB = getProxyFetchOptions({
        environment: directEnvironmentB,
      }).dispatcher;
      expect(directDispatcherA).toBeDefined();
      expect(directDispatcherA).not.toBe(contaminatedGlobalDispatcher);
      expect(directDispatcherB).not.toBe(directDispatcherA);

      let axiosAgentA: unknown;
      let axiosAgentB: unknown;
      const response = {
        data: "ok",
        status: 200,
        statusText: "OK",
        headers: {},
        config: {},
      };
      await createAxiosInstance(environmentA).get(
        "https://proxied.example.test/path",
        {
          adapter: async (config) => {
            axiosAgentA = config.httpsAgent;
            return { ...response, config };
          },
        },
      );
      await createAxiosInstance(environmentB).get(
        "https://proxied.example.test/path",
        {
          adapter: async (config) => {
            axiosAgentB = config.httpsAgent;
            return { ...response, config };
          },
        },
      );
      expect(axiosAgentA).toBeDefined();
      expect(axiosAgentB).toBeUndefined();
    } finally {
      setGlobalDispatcher(originalGlobalDispatcher);
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousNoProxy;
    }
  });

  test("loads client certificates and passphrases from the supplied snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-session-mtls-"));
    temporaryDirectories.push(directory);
    const certA = join(directory, "session-a-cert.pem");
    const certB = join(directory, "session-b-cert.pem");
    writeFileSync(certA, "session-a-certificate");
    writeFileSync(certB, "session-b-certificate");

    const configA = getMTLSConfig({
      AGENC_CLIENT_CERT: certA,
      AGENC_CLIENT_KEY_PASSPHRASE: "session-a-passphrase",
    });
    const configB = getMTLSConfig({
      AGENC_CLIENT_CERT: certB,
      AGENC_CLIENT_KEY_PASSPHRASE: "session-b-passphrase",
    });

    expect(configA).toEqual({
      cert: "session-a-certificate",
      passphrase: "session-a-passphrase",
    });
    expect(configB).toEqual({
      cert: "session-b-certificate",
      passphrase: "session-b-passphrase",
    });
  });

  test("remote auth snapshots its transport environment at daemon ingress", async () => {
    const originalFetch = globalThis.fetch;
    const originalHttpsProxy = process.env.HTTPS_PROXY;
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input, init) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({
          authenticated: true,
          identity: { accountId: "account-1", displayName: "A", plan: "pro" },
          subscriptionTier: "pro",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const mutableEnvironmentA: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
    };
    const backendA = new RemoteAuthBackend({
      env: mutableEnvironmentA,
      token: "token-a",
      meEndpoint: "https://id.example.test/me",
    });
    const backendB = new RemoteAuthBackend({
      env: {},
      token: "token-b",
      meEndpoint: "https://id.example.test/me",
    });
    mutableEnvironmentA.HTTPS_PROXY = "http://mutated.proxy.test:8080";
    process.env.HTTPS_PROXY = "http://ambient.proxy.test:8080";

    try {
      await backendA.whoami();
      await backendB.whoami();
      const dispatcherA = (calls[0] as RequestInit & { dispatcher?: object })
        .dispatcher;
      const dispatcherB = (calls[1] as RequestInit & { dispatcher?: object })
        .dispatcher;
      expect(dispatcherA?.constructor.name).toBe("EnvHttpProxyAgent");
      expect(dispatcherB?.constructor.name).toBe("Agent");
      expect(dispatcherA).not.toBe(dispatcherB);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalHttpsProxy;
    }
  });
});
