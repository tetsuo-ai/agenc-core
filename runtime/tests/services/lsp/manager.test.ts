import { describe, expect, test, beforeEach, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import { normalizeLspServerConfig } from "./config.js";
import {
  _resetLspManagerForTesting,
  getInitializationStatus,
  getLspServerManager,
  initializeLspServerManager,
  isLspConnected,
  reinitializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "./manager.js";
import type { LSPServerInstance } from "./LSPServerInstance.js";
import { notifyLspFileChanged } from "./fileNotifications.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";

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
    expect(isLspConnected()).toBe(false);

    notifyLspFileChanged("src/a.ts", "let x = 1;");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toContain("textDocument/didSave");
    expect(isLspConnected()).toBe(true);

    await shutdownLspServerManager();
    expect(getInitializationStatus().status).toBe("not-started");
  });

  test("keeps simultaneous broker scopes isolated from manager substitution", async () => {
    const restrictedBroker = {
      mode: "workspace_write",
      cwd: "/workspace/restricted",
    } as SandboxExecutionBrokerLike;
    const dangerBroker = {
      mode: "danger_full_access",
      cwd: "/workspace/danger",
    } as SandboxExecutionBrokerLike;
    const restrictedConfig = normalizeLspServerConfig("restricted", {
      command: "restricted-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const dangerConfig = normalizeLspServerConfig("danger", {
      command: "danger-language-server",
      extensionToLanguage: { ".js": "javascript" },
    });
    const restrictedConfigSource = vi.fn(() => ({ restricted: restrictedConfig }));
    const dangerConfigSource = vi.fn(() => ({ danger: dangerConfig }));
    const makeServer = (
      name: string,
      config: typeof restrictedConfig,
    ): LSPServerInstance =>
      ({
        name,
        config,
        state: "stopped",
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      }) as unknown as LSPServerInstance;

    try {
      initializeLspServerManager({
        sandboxExecutionBroker: restrictedBroker,
        configSource: restrictedConfigSource,
        instanceFactory: (name, config) => makeServer(name, config),
      });
      initializeLspServerManager({
        sandboxExecutionBroker: dangerBroker,
        configSource: dangerConfigSource,
        instanceFactory: (name, config) => makeServer(name, config),
      });

      await Promise.all([
        waitForInitialization(restrictedBroker),
        waitForInitialization(dangerBroker),
      ]);

      const restrictedManager = getLspServerManager(restrictedBroker);
      const dangerManager = getLspServerManager(dangerBroker);
      expect(restrictedManager).toBeDefined();
      expect(dangerManager).toBeDefined();
      expect(restrictedManager).not.toBe(dangerManager);
      expect([...restrictedManager!.getAllServers().keys()]).toEqual(["restricted"]);
      expect([...dangerManager!.getAllServers().keys()]).toEqual(["danger"]);
      expect(restrictedConfigSource).toHaveBeenCalledTimes(1);
      expect(dangerConfigSource).toHaveBeenCalledTimes(1);
      expect(getLspServerManager()).toBeUndefined();
    } finally {
      await Promise.all([
        shutdownLspServerManager(restrictedBroker),
        shutdownLspServerManager(dangerBroker),
      ]);
    }
  });

  test("reinitialize waits for old servers to stop before succeeding", async () => {
    let oldStopped = false;
    let factoryCalls = 0;
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const makeServer = (name: string): LSPServerInstance =>
      ({
        name,
        config,
        get state() {
          return "running";
        },
        start: async () => {},
        stop: async () => {
          await sleep(10);
          oldStopped = true;
        },
        restart: async () => {},
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      }) as unknown as LSPServerInstance;

    const options = {
      configSource: () => ({ ts: config }),
      instanceFactory: () => makeServer(factoryCalls++ === 0 ? "old" : "new"),
    };

    initializeLspServerManager(options);
    await waitForInitialization();
    reinitializeLspServerManager(options);
    expect(getInitializationStatus().status).toBe("pending");
    await waitForInitialization();

    expect(oldStopped).toBe(true);
    expect(getInitializationStatus().status).toBe("success");
    expect(getLspServerManager()?.getAllServers().get("ts")?.name).toBe("new");
    await shutdownLspServerManager();
  });

  test("reinitialize continues when old shutdown fails", async () => {
    let factoryCalls = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const makeServer = (name: string): LSPServerInstance =>
      ({
        name,
        config,
        get state() {
          return "running";
        },
        start: async () => {},
        stop: async () => {
          if (name === "old") throw new Error("old stop failed");
        },
        restart: async () => {},
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      }) as unknown as LSPServerInstance;

    const options = {
      configSource: () => ({ ts: config }),
      instanceFactory: () => makeServer(factoryCalls++ === 0 ? "old" : "new"),
    };

    try {
      initializeLspServerManager(options);
      await waitForInitialization();
      reinitializeLspServerManager(options);
      await waitForInitialization();

      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().get("ts")?.name).toBe("new");
      expect(warn).toHaveBeenCalledWith(
        "[lsp] previous manager shutdown failed during reinitialize:",
        expect.stringContaining("old stop failed"),
      );
    } finally {
      warn.mockRestore();
      await shutdownLspServerManager();
    }
  });

  test("reports connected only for starting or running servers", async () => {
    let state: LSPServerInstance["state"] = "stopped";
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    const server = {
      name: "ts",
      config,
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
      isHealthy: () => state === "running",
      sendRequest: async () => ({}),
      sendNotification: async () => {},
      onNotification: () => {},
      onRequest: () => {},
    } as unknown as LSPServerInstance;

    initializeLspServerManager({
      configSource: () => ({ ts: config }),
      instanceFactory: () => server,
    });
    await waitForInitialization();

    expect(isLspConnected()).toBe(false);
    state = "starting";
    expect(isLspConnected()).toBe(true);
    state = "running";
    expect(isLspConnected()).toBe(true);
    state = "stopping";
    expect(isLspConnected()).toBe(false);

    await shutdownLspServerManager();
  });
});
