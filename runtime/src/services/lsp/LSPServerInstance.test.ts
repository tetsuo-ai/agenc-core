import { describe, expect, test } from "vitest";

import { normalizeLspServerConfig } from "./config.js";
import { createLSPServerInstance } from "./LSPServerInstance.js";
import type { LSPClient } from "./LSPClient.js";

function fakeClient(overrides: Partial<LSPClient> = {}): LSPClient & {
  readonly starts: unknown[];
  readonly requests: string[];
  initialized: boolean;
} {
  const starts: unknown[] = [];
  const requests: string[] = [];
  const client: LSPClient & {
    readonly starts: unknown[];
    readonly requests: string[];
    initialized: boolean;
  } = {
    starts,
    requests,
    initialized: false,
    get capabilities() {
      return {};
    },
    get isInitialized() {
      return client.initialized;
    },
    start: async (...args) => {
      starts.push(args);
    },
    initialize: async () => {
      client.initialized = true;
      return { capabilities: {} };
    },
    sendRequest: async (method) => {
      requests.push(method);
      return { ok: true };
    },
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
    stop: async () => {
      client.initialized = false;
    },
    ...overrides,
  };
  return client;
}

describe("createLSPServerInstance", () => {
  test("starts, initializes, sends requests, and stops", async () => {
    const client = fakeClient();
    const instance = createLSPServerInstance(
      "ts",
      normalizeLspServerConfig("ts", {
        command: "typescript-language-server",
        args: ["--stdio"],
        extensionToLanguage: { ".ts": "typescript" },
      }),
      { client },
    );

    await instance.start();
    expect(instance.state).toBe("running");
    expect(instance.isHealthy()).toBe(true);
    expect(client.starts).toHaveLength(1);

    await expect(instance.sendRequest("textDocument/definition", {})).resolves.toEqual({
      ok: true,
    });
    expect(client.requests).toEqual(["textDocument/definition"]);

    await instance.stop();
    expect(instance.state).toBe("stopped");
    expect(instance.isHealthy()).toBe(false);
  });

  test("cleans up and enters error state when initialize times out", async () => {
    const client = fakeClient({
      initialize: async () => new Promise(() => {}),
    });
    const instance = createLSPServerInstance(
      "slow",
      normalizeLspServerConfig("slow", {
        command: "slow-server",
        extensionToLanguage: { ".ts": "typescript" },
        startupTimeout: 10,
      }),
      { client },
    );

    await expect(instance.start()).rejects.toThrow("timed out");
    expect(instance.state).toBe("error");
    expect(instance.lastError?.message).toContain("timed out");
  });
});
