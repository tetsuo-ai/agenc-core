import { describe, expect, it } from "vitest";
import type { FetchResponse, Fetcher } from "./marketplace.js";
import type { RemoteAuth, RemotePluginServiceConfig } from "./remote.js";
import {
  enableRemotePlugin,
  fetchRemoteFeaturedPluginIds,
  fetchRemotePluginStatus,
} from "./remote_legacy.js";

const config: RemotePluginServiceConfig = { baseUrl: "https://agenc.tech" };
const auth: RemoteAuth = { headers: { Authorization: "Bearer test" } };

describe("legacy remote plugin marketplace API", () => {
  it("validates status and featured response shapes", async () => {
    await expect(fetchRemotePluginStatus(config, auth, async () => jsonResponse({ plugins: [] })))
      .rejects.toThrow("legacy remote plugin status response must be an array");

    await expect(fetchRemoteFeaturedPluginIds(
      config,
      undefined,
      undefined,
      async () => jsonResponse({ plugins: [] }),
    )).rejects.toThrow("legacy remote featured plugin response must be an array");
  });

  it("validates mutation response shape before asserting state", async () => {
    const fetcher: Fetcher = async () => jsonResponse({ id: "linear" });

    await expect(enableRemotePlugin(config, auth, "linear", fetcher))
      .rejects.toThrow("legacy remote plugin mutation response.enabled must be a boolean");
  });

  it("rejects legacy loopback HTTP with auth unless explicitly allowed", async () => {
    const loopbackConfig = { baseUrl: "http://127.0.0.1:4173" };
    const calls: Readonly<Record<string, string>>[] = [];
    const fetcher: Fetcher = async (_url, init) => {
      calls.push(init?.headers ?? {});
      return jsonResponse({ id: "linear", enabled: true });
    };

    await expect(enableRemotePlugin(loopbackConfig, auth, "linear", fetcher))
      .rejects.toThrow("legacy remote plugin API URL must use HTTPS");
    expect(calls).toEqual([]);

    await expect(enableRemotePlugin(
      loopbackConfig,
      auth,
      "linear",
      fetcher,
      { allowLoopbackHttp: true },
    )).resolves.toBeUndefined();
    expect(calls).toEqual([{ Authorization: "Bearer test" }]);
  });
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): FetchResponse {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}
