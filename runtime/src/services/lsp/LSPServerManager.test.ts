import { describe, expect, test } from "vitest";

import { normalizeLspServerConfig } from "./config.js";
import { createLSPServerManager } from "./LSPServerManager.js";
import type { LSPServerInstance } from "./LSPServerInstance.js";
import type { ScopedLspServerConfig } from "./types.js";

function fakeServer(name: string, config: ScopedLspServerConfig) {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const requests: Array<{ method: string; handler: unknown }> = [];
  let state: LSPServerInstance["state"] = "stopped";
  const server: LSPServerInstance & {
    readonly notifications: typeof notifications;
    readonly requests: typeof requests;
  } = {
    name,
    config,
    notifications,
    requests,
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
    await manager.saveFile("src/a.ts");
    await manager.closeFile("src/a.ts");

    expect(created[0]!.notifications.map((n) => n.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didSave",
      "textDocument/didClose",
    ]);
    expect(manager.isFileOpen("src/a.ts")).toBe(false);

    await manager.shutdown();
    expect(manager.getAllServers().size).toBe(0);
  });
});
