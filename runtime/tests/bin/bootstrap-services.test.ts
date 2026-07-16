import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const policyLimitsMocks = vi.hoisted(() => ({
  configurePolicyLimitsService: vi.fn(),
}));

vi.mock("../services/policyLimits/index.js", () => ({
  configurePolicyLimitsService: policyLimitsMocks.configurePolicyLimitsService,
}));

import {
  ConfiguredHooksRuntime,
  type HookInstallTarget,
} from "../hooks/configured-hooks.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { defaultConfig } from "../config/schema.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import type { PostToolUseHook } from "../tools/hooks.js";
import {
  buildBootstrapSessionServices,
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
import { bootstrapSession } from "../session/bootstrap.js";

afterEach(() => {
  policyLimitsMocks.configurePolicyLimitsService.mockReset();
});

function mockPolicyLimits(): void {
  policyLimitsMocks.configurePolicyLimitsService.mockReturnValue({
    initializePolicyLimitsLoadingPromise: vi.fn(),
    loadPolicyLimits: vi.fn(async () => {}),
    stopBackgroundPolling: vi.fn(),
  } as never);
}

function sessionStartEchoCommand(): string {
  return [
    "node -e \"let s='';",
    "process.stdin.on('data', c => s += c);",
    "process.stdin.on('end', () => {",
    "const x = JSON.parse(s);",
    "process.stdout.write('source=' + x.source + ';model=' + x.model + ';mode=' + x.permission_mode);",
    "});\"",
  ].join(" ");
}

function sessionStartStopCommand(): string {
  return [
    "node -e \"process.stdout.write(JSON.stringify({",
    "continue: false,",
    "stopReason: 'pause startup',",
    "hookSpecificOutput: {",
    "hookEventName: 'SessionStart',",
    "additionalContext: 'startup context'",
    "}",
    "}));\"",
  ].join(" ");
}

function drainSessionEvents(session: {
  readonly txEvent: { tryRecv(): unknown };
}): unknown[] {
  const events: unknown[] = [];
  while (true) {
    const next = session.txEvent.tryRecv();
    if (next === null || next === undefined) return events;
    events.push(next);
  }
}

describe("loadBootstrapHooks", () => {
  test("installs the built-in auto-fix post hook once across reloads", () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-bootstrap-hooks-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
      sandboxExecutionBroker: explicitDangerBroker,
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

describe("SessionStart bootstrap hooks", () => {
  async function bootstrapWithHooks(opts: {
    readonly hooks: NonNullable<ReturnType<typeof defaultConfig>["hooks"]>;
    readonly resume?: boolean;
  }) {
    mockPolicyLimits();
    const home = mkdtempSync(join(tmpdir(), "agenc-sessionstart-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-sessionstart-ws-"));
    // SessionStart command hooks now require a trusted workspace (production
    // establishes trust before bootstrap dispatches them); mark it trusted.
    trustProjectSync({ cwd: workspace, agencHome: home });
    const config = {
      ...defaultConfig(),
      agentRoles: [],
      hooks: opts.hooks,
    };
    const sessionConfiguration = {
      cwd: workspace,
      approvalPolicy: { value: "never" },
      sandboxPolicy: { value: "read_only" },
      fileSystemSandboxPolicy: {
        allowWrite: [],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      },
      networkSandboxPolicy: {
        allowlist: [],
        denylist: [],
        allowManagedDomainsOnly: false,
      },
      windowsSandboxLevel: "none",
      collaborationMode: { model: "test-model" },
      dynamicTools: [],
      sessionSource: "cli_main",
      permissionContext: { mode: "default" },
    };
    const handle = buildBootstrapSessionServices({
      provider: {
        name: "anthropic",
        chat: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        chatStream: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        healthCheck: async () => true,
      },
      providerName: "anthropic",
      registry: { tools: [] } as never,
      mcpManager: {} as never,
      unifiedExecManager: {} as never,
      sandboxExecutionBroker: explicitDangerBroker,
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      ),
      configStore: {
        current: () => config,
        subscribe: () => () => {},
      } as never,
      toolApprovals: {
        get: () => undefined,
        set: () => {},
        clear: () => {},
        withCachedApproval: async (request: {
          fetchDecision: () => Promise<unknown>;
        }) => request.fetchDecision(),
      } as never,
      networkApproval: {
        clearSessionHosts: () => {},
        requestNetworkApproval: async () => ({ kind: "approved" }),
        requestDeferredApproval: async () => ({ kind: "approved" }),
      } as never,
      modelsManager: {} as never,
      agencHome: home,
      workspaceRoot: workspace,
      env: { HOME: home, SHELL: "/bin/sh" },
      conversationId: "session-sessionstart",
      model: "test-model",
      sessionConfiguration: sessionConfiguration as never,
    });
    const session = await bootstrapSession({
      conversationId: "session-sessionstart",
      initialState: {
        sessionConfiguration: sessionConfiguration as never,
        history: [],
        ...(opts.resume ? { pendingSessionStartSource: "resume" as const } : {}),
      },
      features: config.features,
      services: handle.services,
      jsRepl: { id: "repl-sessionstart" },
      config,
      modelInfo: {
        slug: "test-model",
        effectiveContextWindowPercent: 100,
        contextWindow: 1024,
        supportedReasoningLevels: [],
        defaultReasoningSummary: "auto",
        truncationPolicy: "off",
        usedFallbackModelMetadata: false,
      },
      enablePrewarm: false,
      sessionConfigured: {
        sessionId: "session-sessionstart",
        model: "test-model",
        modelProviderId: "anthropic",
        cwd: workspace,
        historyLogId: 0,
        historyEntryCount: 0,
        initialMessages: [],
      },
    });
    return { handle, home, workspace, session };
  }

  test("dispatches SessionStart once with live startup context", async () => {
    const env = await bootstrapWithHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: sessionStartEchoCommand() }],
          },
        ],
      },
    });
    try {
      const events = drainSessionEvents(env.session as never);
      const sessionStartContexts = events.filter((event) =>
        (event as { msg?: { type?: string } }).msg?.type === "hook_additional_context"
      );
      expect(sessionStartContexts).toHaveLength(1);
      expect(sessionStartContexts[0]).toMatchObject({
        msg: {
          type: "hook_additional_context",
          hookEvent: "SessionStart",
          content: ["source=startup;model=test-model;mode=default"],
        },
      });
    } finally {
      await env.handle.shutdown();
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.workspace, { recursive: true, force: true });
    }
  });

  test("uses resume source and surfaces stopped-continuation output without aborting bootstrap", async () => {
    const env = await bootstrapWithHooks({
      resume: true,
      hooks: {
        SessionStart: [
          {
            matcher: "resume",
            hooks: [{ type: "command", command: sessionStartStopCommand() }],
          },
        ],
      },
    });
    try {
      const events = drainSessionEvents(env.session as never);
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: "hook_stopped_continuation",
            hookEvent: "SessionStart",
            message: "pause startup",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          msg: expect.objectContaining({
            type: "hook_additional_context",
            hookEvent: "SessionStart",
            content: ["startup context"],
          }),
        }),
      );
    } finally {
      await env.handle.shutdown();
      rmSync(env.home, { recursive: true, force: true });
      rmSync(env.workspace, { recursive: true, force: true });
    }
  });
});

describe("buildBootstrapSessionServices policy limits wiring", () => {
  test("initializes policy limits and stops polling on shutdown", async () => {
    const stopBackgroundPolling = vi.fn();
    const policyLimits = {
      initializePolicyLimitsLoadingPromise: vi.fn(),
      loadPolicyLimits: vi.fn(async () => {}),
      stopBackgroundPolling,
    };
    policyLimitsMocks.configurePolicyLimitsService.mockReturnValue(
      policyLimits as never,
    );
    const home = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-policy-bootstrap-ws-"));
    try {
      const handle = buildBootstrapSessionServices({
        provider: {
          name: "anthropic",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          chatStream: async () => ({
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
          healthCheck: async () => true,
        },
        providerName: "anthropic",
        apiKey: "direct-policy-key",
        registry: { tools: [] } as never,
        mcpManager: {} as never,
        unifiedExecManager: {} as never,
        sandboxExecutionBroker: explicitDangerBroker,
        permissionModeRegistry: new PermissionModeRegistry(
          createEmptyToolPermissionContext(),
        ),
        configStore: {
          current: () => defaultConfig(),
          subscribe: () => () => {},
        } as never,
        toolApprovals: {
          get: () => undefined,
          set: () => {},
          clear: () => {},
          withCachedApproval: async (request: {
            fetchDecision: () => Promise<unknown>;
          }) => request.fetchDecision(),
        } as never,
        networkApproval: {
          clearSessionHosts: () => {},
          requestNetworkApproval: async () => ({ kind: "approved" }),
          requestDeferredApproval: async () => ({ kind: "approved" }),
        } as never,
        modelsManager: {} as never,
        agencHome: home,
        workspaceRoot: workspace,
        env: { HOME: home, SHELL: "/bin/sh" },
        conversationId: "session-policy-bootstrap",
        model: "agenc-opus-4-7",
        sessionConfiguration: {} as never,
      });

      expect(policyLimitsMocks.configurePolicyLimitsService).toHaveBeenCalledWith(
        expect.objectContaining({
          agencHome: home,
          providerName: "anthropic",
          apiKey: "direct-policy-key",
          sessionId: "session-policy-bootstrap",
        }),
      );
      expect(policyLimits.initializePolicyLimitsLoadingPromise).toHaveBeenCalled();
      expect(policyLimits.loadPolicyLimits).toHaveBeenCalled();
      expect(handle.services.policyLimits).toBe(policyLimits);

      await handle.shutdown();

      expect(stopBackgroundPolling).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("exposes a live LSP refresh service", async () => {
    _resetLspManagerForTesting();
    const stopBackgroundPolling = vi.fn();
    const policyLimits = {
      initializePolicyLimitsLoadingPromise: vi.fn(),
      loadPolicyLimits: vi.fn(async () => {}),
      stopBackgroundPolling,
    };
    policyLimitsMocks.configurePolicyLimitsService.mockReturnValue(
      policyLimits as never,
    );
    const home = mkdtempSync(join(tmpdir(), "agenc-lsp-refresh-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-lsp-refresh-ws-"));
    const marker = join(workspace, "lsp-escaped");
    const sandboxExecutionBroker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: workspace,
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: process.platform,
        reason: "probe: injected bootstrap LSP namespace failure",
        remediation: "repair sandbox support",
      }),
    });
    const handle = buildBootstrapSessionServices({
      provider: {
        name: "anthropic",
        chat: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        chatStream: async () => ({
          content: "ok",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
        healthCheck: async () => true,
      },
      providerName: "anthropic",
      apiKey: "direct-policy-key",
      registry: { tools: [] } as never,
      mcpManager: {} as never,
      unifiedExecManager: {} as never,
      sandboxExecutionBroker,
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext(),
      ),
      configStore: {
        current: () => defaultConfig(),
        subscribe: () => () => {},
      } as never,
      toolApprovals: {
        get: () => undefined,
        set: () => {},
        clear: () => {},
        withCachedApproval: async (request: {
          fetchDecision: () => Promise<unknown>;
        }) => request.fetchDecision(),
      } as never,
      networkApproval: {
        clearSessionHosts: () => {},
        requestNetworkApproval: async () => ({ kind: "approved" }),
        requestDeferredApproval: async () => ({ kind: "approved" }),
      } as never,
      modelsManager: {} as never,
      agencHome: home,
      workspaceRoot: workspace,
      env: { HOME: home, SHELL: "/bin/sh" },
      conversationId: "session-lsp-refresh",
      model: "agenc-opus-4-7",
      sessionConfiguration: {} as never,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));

      await handle.services.lspManager?.refreshFromConfig({
        ...defaultConfig(),
        lsp_servers: {
          ts: {
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
            ],
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
      });
      await waitForInitialization();

      expect(getInitializationStatus().status).toBe("success");
      const manager = getLspServerManager();
      expect(manager?.getAllServers().has("ts")).toBe(true);
      if (manager === undefined) throw new Error("LSP manager was not initialized");
      await expect(
        manager.ensureServerStarted(join(workspace, "file.ts")),
      ).rejects.toMatchObject({
        code: "sandbox_probe_failed",
        surface: "lsp",
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await handle.shutdown();
      await shutdownLspServerManager();
      _resetLspManagerForTesting();
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
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
