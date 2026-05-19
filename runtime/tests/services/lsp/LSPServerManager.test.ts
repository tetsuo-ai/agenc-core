import { describe, expect, test } from "vitest";

import { normalizeLspServerConfig } from "./config.js";
import { createLSPServerManager } from "./LSPServerManager.js";
import type { LSPServerInstance } from "./LSPServerInstance.js";
import type { ScopedLspServerConfig } from "./types.js";

function fakeServer(
  name: string,
  config: ScopedLspServerConfig,
  initialState: LSPServerInstance["state"] = "stopped",
) {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: Array<{ method: string; handler: unknown }> = [];
  let state: LSPServerInstance["state"] = initialState;
  let stopCount = 0;
  const server: LSPServerInstance & {
    readonly notifications: typeof notifications;
    readonly requests: typeof requests;
    readonly stopCount: number;
    setState(next: LSPServerInstance["state"]): void;
  } = {
    name,
    config,
    notifications,
    requests,
    get stopCount() {
      return stopCount;
    },
    setState(next) {
      state = next;
    },
    get state() {
      return state;
    },
    get startTime() {
      return undefined;
    },
    get lastError() {
      return undefined;
    },
    get restartCount() {
      return 0;
    },
    start: async () => {
      state = "running";
    },
    stop: async () => {
      stopCount += 1;
      state = "stopped";
    },
    restart: async () => {},
    isHealthy: () => state === "running",
    sendRequest: async () => ({}),
    sendNotification: async (method, params) => {
      notifications.push({ method, params });
    },
    onNotification: () => {},
    onRequest: (method, handler) => {
      requests.push({ method, handler });
    },
  };
  return server;
}

describe("createLSPServerManager", () => {
  test("routes files by extension and sends lifecycle notifications", async () => {
    const created: ReturnType<typeof fakeServer>[] = [];
    const manager = createLSPServerManager({
      configSource: () => ({
        ts: normalizeLspServerConfig("ts", {
          command: "typescript-language-server",
          extensionToLanguage: { ".ts": "typescript" },
        }),
      }),
      instanceFactory: (name, config) => {
        const server = fakeServer(name, config);
        created.push(server);
        return server;
      },
    });

    await manager.initialize();
    expect(manager.getServerForFile("src/a.ts")?.name).toBe("ts");
    expect(manager.getServerForFile("src/a.py")).toBeUndefined();
    expect(created[0]!.requests[0]!.method).toBe("workspace/configuration");

    await manager.changeFile("src/a.ts", "let x = 1;");
    await manager.changeFile("src/a.ts", "let x = 2;");
    await manager.changeFile("src/a.ts", "let x = 3;");
    await manager.saveFile("src/a.ts");
    await manager.closeFile("src/a.ts");

    expect(created[0]!.notifications.map((n) => n.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didChange",
      "textDocument/didSave",
      "textDocument/didClose",
    ]);
    expect(
      created[0]!.notifications
        .filter((n) => n.method !== "textDocument/didSave" && n.method !== "textDocument/didClose")
        .map((n) => (n.params as { textDocument: { version: number } }).textDocument.version),
    ).toEqual([1, 2, 3]);
    expect(manager.isFileOpen("src/a.ts")).toBe(false);

    await manager.shutdown();
    expect(manager.getAllServers().size).toBe(0);
  });

  test("does not leave failed servers in extension routing", async () => {
    const validConfig = normalizeLspServerConfig("valid", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const validServer = fakeServer("valid", validConfig);
    const manager = createLSPServerManager({
      configSource: () => ({
        broken: normalizeLspServerConfig("broken", {
          command: "broken-server",
          extensionToLanguage: { ".ts": "typescript" },
        }),
        valid: validConfig,
      }),
      instanceFactory: (name, config) => {
        if (name === "broken") throw new Error("boom");
        expect(config).toBe(validConfig);
        return validServer;
      },
    });

    await manager.initialize();

    expect(manager.getServerForFile("src/a.ts")?.name).toBe("valid");
  });

  test("shutdown stops servers that are still starting", async () => {
    const created: ReturnType<typeof fakeServer>[] = [];
    const manager = createLSPServerManager({
      configSource: () => ({
        ts: normalizeLspServerConfig("ts", {
          command: "typescript-language-server",
          extensionToLanguage: { ".ts": "typescript" },
        }),
      }),
      instanceFactory: (name, config) => {
        const server = fakeServer(name, config, "starting");
        created.push(server);
        return server;
      },
    });

    await manager.initialize();
    await manager.shutdown();

    expect(created[0]!.stopCount).toBe(1);
  });

  test("resolves relative file notifications against workspaceRoot", async () => {
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const server = fakeServer("ts", config);
    const manager = createLSPServerManager({
      workspaceRoot: "/workspace/project",
      configSource: () => ({ ts: config }),
      instanceFactory: () => server,
    });

    await manager.initialize();
    await manager.changeFile("src/a.ts", "let x = 1;");

    expect(
      (
        server.notifications[0]!.params as {
          textDocument: { uri: string };
        }
      ).textDocument.uri,
    ).toBe("file:///workspace/project/src/a.ts");
    expect(manager.isFileOpen("src/a.ts")).toBe(true);

    await manager.closeFile("src/a.ts");
    expect(manager.isFileOpen("src/a.ts")).toBe(false);
  });
});
