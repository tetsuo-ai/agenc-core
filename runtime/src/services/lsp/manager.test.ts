import { describe, expect, test, beforeEach } from "vitest";

import { normalizeLspServerConfig } from "./config.js";
import {
  _resetLspManagerForTesting,
  getInitializationStatus,
  getLspServerManager,
  initializeLspServerManager,
  isLspConnected,
  shutdownLspServerManager,
  waitForInitialization,
} from "./manager.js";
import type { LSPServerInstance } from "./LSPServerInstance.js";
import { notifyLspFileChanged } from "./fileNotifications.js";

describe("LSP singleton manager", () => {
  beforeEach(() => {
    _resetLspManagerForTesting();
  });

  test("tracks initialization state and exposes the live manager", async () => {
    const notifications: string[] = [];
    let state: LSPServerInstance["state"] = "stopped";
    const server = {
      name: "ts",
      config: normalizeLspServerConfig("ts", {
        command: "typescript-language-server",
        extensionToLanguage: { ".ts": "typescript" },
      }),
      get state() {
        return state;
      },
      start: async () => {
        state = "running";
      },
      stop: async () => {
        state = "stopped";
      },
      restart: async () => {},
      isHealthy: () => true,
      sendRequest: async () => ({}),
      sendNotification: async (method: string) => {
        notifications.push(method);
      },
      onNotification: () => {},
      onRequest: () => {},
    } as unknown as LSPServerInstance;

    initializeLspServerManager({
      configSource: () => ({ ts: server.config }),
      instanceFactory: () => server,
    });
    expect(getInitializationStatus().status).toBe("pending");
    await waitForInitialization();
    expect(getInitializationStatus().status).toBe("success");
    expect(getLspServerManager()?.getAllServers().has("ts")).toBe(true);
    expect(isLspConnected()).toBe(true);

    notifyLspFileChanged("src/a.ts", "let x = 1;");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toContain("textDocument/didSave");

    await shutdownLspServerManager();
    expect(getInitializationStatus().status).toBe("not-started");
  });
});
