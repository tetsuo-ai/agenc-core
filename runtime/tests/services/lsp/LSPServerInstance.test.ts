import { describe, expect, test, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";

import { normalizeLspServerConfig } from "./config.js";
import {
  createLSPServerInstance,
  DEFAULT_LSP_STARTUP_TIMEOUT_MS,
} from "./LSPServerInstance.js";
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
    let stopCompleted = false;
    const client = fakeClient({
      initialize: async () => new Promise(() => {}),
      stop: async () => {
        await sleep(10);
        stopCompleted = true;
        client.initialized = false;
      },
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
    expect(stopCompleted).toBe(true);
    expect(instance.state).toBe("error");
    expect(instance.lastError?.message).toContain("timed out");
  });

  test("applies the default startup timeout when config omits one", async () => {
    vi.useFakeTimers();
    let stopCompleted = false;
    const client = fakeClient({
      initialize: async () => new Promise(() => {}),
      stop: async () => {
        stopCompleted = true;
        client.initialized = false;
      },
    });
    const instance = createLSPServerInstance(
      "default-timeout",
      normalizeLspServerConfig("default-timeout", {
        command: "slow-server",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      { client },
    );

    try {
      const start = instance.start();
      const timeoutExpectation = expect(start).rejects.toThrow(
        `timed out after ${DEFAULT_LSP_STARTUP_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_LSP_STARTUP_TIMEOUT_MS);
      await timeoutExpectation;
      expect(stopCompleted).toBe(true);
      expect(instance.state).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses workspace fallback for process cwd and initialize root", async () => {
    let initializeParams: unknown;
    const client = fakeClient({
      initialize: async (params) => {
        initializeParams = params;
        client.initialized = true;
        return { capabilities: {} };
      },
    });
    const instance = createLSPServerInstance(
      "workspace",
      normalizeLspServerConfig("workspace", {
        command: "server",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      { client, cwd: "/workspace/project" },
    );

    await instance.start();

    expect((client.starts[0] as unknown[])[2]).toMatchObject({
      cwd: "/workspace/project",
    });
    expect(initializeParams).toMatchObject({
      rootPath: "/workspace/project",
      workspaceFolders: [{ name: "project" }],
    });
  });

  test("resolves a configured relative workspace against the session root", async () => {
    let initializeParams: unknown;
    const client = fakeClient({
      initialize: async (params) => {
        initializeParams = params;
        client.initialized = true;
        return { capabilities: {} };
      },
    });
    const sessionRoot = resolve("/workspace/project");
    const expectedWorkspace = resolve(sessionRoot, "packages/service");
    const instance = createLSPServerInstance(
      "workspace-relative",
      normalizeLspServerConfig("workspace-relative", {
        command: "server",
        workspaceFolder: "packages/service",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      { client, cwd: sessionRoot },
    );

    await instance.start();

    expect((client.starts[0] as unknown[])[2]).toMatchObject({
      cwd: expectedWorkspace,
    });
    expect(initializeParams).toMatchObject({
      rootPath: expectedWorkspace,
      rootUri: expect.stringContaining("/workspace/project/packages/service"),
      workspaceFolders: [
        {
          name: "service",
          uri: expect.stringContaining("/workspace/project/packages/service"),
        },
      ],
    });
  });

  test("concurrent start calls share the same startup", async () => {
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const client = fakeClient({
      initialize: async () => {
        await initializeGate;
        client.initialized = true;
        return { capabilities: {} };
      },
    });
    const instance = createLSPServerInstance(
      "concurrent",
      normalizeLspServerConfig("concurrent", {
        command: "server",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      { client },
    );

    const first = instance.start();
    const second = instance.start();
    expect(client.starts).toHaveLength(1);
    releaseInitialize();
    await Promise.all([first, second]);

    expect(instance.state).toBe("running");
    expect(client.starts).toHaveLength(1);
  });

  test("restarts after an owner-visible terminal event is reported", async () => {
    let crash: ((error: Error) => void) | undefined;
    const client = fakeClient();
    const instance = createLSPServerInstance(
      "crashy",
      normalizeLspServerConfig("crashy", {
        command: "server",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      {
        createClient: (_name, onCrash) => {
          crash = onCrash;
          return client;
        },
      },
    );

    await instance.start();
    expect(client.starts).toHaveLength(1);
    crash?.(new Error("server exited unexpectedly with code 0"));
    expect(instance.state).toBe("error");

    await instance.start();
    expect(client.starts).toHaveLength(2);
    expect(instance.state).toBe("running");
  });
});
