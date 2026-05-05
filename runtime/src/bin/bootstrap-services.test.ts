import { describe, expect, test } from "vitest";

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { defaultConfig } from "../config/schema.js";
import type { PostToolUseHook } from "../tools/hooks.js";
import {
  loadBootstrapHooks,
  loadBootstrapLspServers,
} from "./bootstrap-services.js";
import {
  _resetLspManagerForTesting,
  getInitializationStatus,
  getLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "../services/lsp/manager.js";

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
});
