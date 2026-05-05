import { describe, expect, test, vi } from "vitest";

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { defaultConfig } from "../config/schema.js";
import type { PostToolUseHook } from "../tools/hooks.js";
import {
  loadBootstrapHooks,
  loadBootstrapLspServersInBackground,
  loadBootstrapLspServers,
  shutdownBootstrapLspServers,
} from "./bootstrap-services.js";
import { normalizeLspServerConfig } from "../services/lsp/config.js";
import {
  _resetLspManagerForTesting,
  getInitializationStatus,
  getLspServerManager,
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "../services/lsp/manager.js";
import type { LSPServerInstance } from "../services/lsp/LSPServerInstance.js";

describe("loadBootstrapHooks", () => {
  test("installs the built-in auto-fix post hook once across reloads", () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-bootstrap-hooks-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target: HookInstallTarget = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    const autoFixHook: PostToolUseHook = () => ({ kind: "continue" });
    const config = {
      ...defaultConfig(),
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command" as const,
                command: "node -e 'process.exit(0)'",
              },
            ],
          },
        ],
      },
    };

    runtime.attachTarget(target);
    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config,
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(target.postToolUseHooks.at(-1)).toBe(autoFixHook);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config,
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toHaveLength(2);
    expect(target.postToolUseHooks.filter((hook) => hook === autoFixHook)).toHaveLength(1);

    loadBootstrapHooks({
      hooksRuntime: runtime,
      hooksService: target,
      config: { ...defaultConfig(), hooks: undefined },
      autoFixPostToolHook: autoFixHook,
    });
    expect(target.postToolUseHooks).toEqual([autoFixHook]);
  });
});

describe("loadBootstrapLspServers", () => {
  function rejectingStopServer(): LSPServerInstance {
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    return {
      name: "ts",
      config,
      get state() {
        return "running";
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
      start: async () => {},
      stop: async () => {
        throw new Error("stop failed");
      },
      restart: async () => {},
      isHealthy: () => true,
      sendRequest: async () => ({}),
      sendNotification: async () => {},
      onNotification: () => {},
      onRequest: () => {},
    } as unknown as LSPServerInstance;
  }

  test("starts and stops the LSP manager from typed config", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            ts: {
              command: "typescript-language-server",
              extensionToLanguage: { ".ts": "typescript" },
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("pending");
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().has("ts")).toBe(true);

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getInitializationStatus().status).toBe("not-started");

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getInitializationStatus().status).toBe("not-started");
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("empty LSP config clears stale non-empty source", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            ts: {
              command: "typescript-language-server",
              extensionToLanguage: { ".ts": "typescript" },
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      expect(getLspServerManager()?.getAllServers().has("ts")).toBe(true);

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: {} },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("not-started");
      initializeLspServerManager({ workspaceRoot: "/workspace/project" });
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().size).toBe(0);
      await shutdownLspServerManager();

      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            broken: {
              command: "",
              extensionToLanguage: {},
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("failed");

      await loadBootstrapLspServers(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      expect(getInitializationStatus().status).toBe("not-started");
      initializeLspServerManager({ workspaceRoot: "/workspace/project" });
      await waitForInitialization();
      expect(getInitializationStatus().status).toBe("success");
      expect(getLspServerManager()?.getAllServers().size).toBe(0);
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("surfaces invalid LSP config as initialization failure", async () => {
    _resetLspManagerForTesting();
    try {
      await loadBootstrapLspServers(
        {
          ...defaultConfig(),
          lsp_servers: {
            broken: {
              command: "",
              extensionToLanguage: {},
            },
          },
        },
        { workspaceRoot: "/workspace/project" },
      );
      await waitForInitialization();
      const status = getInitializationStatus();
      expect(status.status).toBe("failed");
      expect(status.status === "failed" ? status.error.message : "").toContain(
        "Invalid LSP server config",
      );
    } finally {
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
    }
  });

  test("background config reload logs LSP shutdown rejection", async () => {
    _resetLspManagerForTesting();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    try {
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => rejectingStopServer(),
      });
      await waitForInitialization();

      loadBootstrapLspServersInBackground(
        { ...defaultConfig(), lsp_servers: undefined },
        { workspaceRoot: "/workspace/project" },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(warn).toHaveBeenCalledWith(
        "[lsp] bootstrap config reload failed:",
        expect.stringContaining("stop failed"),
      );
    } finally {
      warn.mockRestore();
      _resetLspManagerForTesting();
    }
  });

  test("bootstrap LSP shutdown logs and does not throw on stop failure", async () => {
    _resetLspManagerForTesting();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = normalizeLspServerConfig("ts", {
      command: "typescript-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    try {
      initializeLspServerManager({
        configSource: () => ({ ts: config }),
        instanceFactory: () => rejectingStopServer(),
      });
      await waitForInitialization();

      await expect(shutdownBootstrapLspServers()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[lsp] bootstrap shutdown failed:",
        expect.stringContaining("stop failed"),
      );
    } finally {
      warn.mockRestore();
      _resetLspManagerForTesting();
    }
  });
});
