import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
/**
 * runAgent + initMcpForAgent — driver tests.
 *
 * Covers T9 gaps #112 and #113: the single-turn provider drive in
 * runAgent and the MCP-readiness polling branches of
 * initMcpForAgent. Uses a lightweight session fake (see
 * control.test.ts) and a provider wired up via `vi.fn()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../utils/async-queue.js";
import { AgentControl } from "./control.js";
import { AgentRegistry } from "./registry.js";
import {
  buildFilteredRegistry,
  drainChildMailboxForTesting,
  initMcpForAgent,
  MCP_INIT_TIMEOUT_MS,
  mergeRoleDisallowlist,
  resolveThreadSpawnDisabledTools,
  runAgent,
  TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
  type RunAgentProgressEvent,
  type RunAgentResult,
} from "./run-agent.js";
import {
  _resetAgentRolesForTesting,
  _resetNicknamePoolForTesting,
  createAgentRoleWorkspace,
  registerAgentRole,
} from "./role.js";
import { BUILTIN_READONLY_DISALLOWLIST } from "./built-in-prompts.js";
import type { InterAgentCommunication } from "./mailbox.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import {
  SandboxExecutionBroker,
  readSandboxExecutionBroker,
} from "../sandbox/execution-broker.js";
import { isSandboxExecutionBrokerDisposed } from "../sandbox/execution-lifecycle.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/tmp");
import { Session, type Event, type SessionOpts, type SessionServices } from "../session/session.js";
import { RolloutStore } from "../session/rollout-store.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
} from "../session/turn-context.js";
import type { ToolRegistry } from "../tool-registry.js";
import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../budget/admission-client.js";
import { AdmissionDeniedError } from "../budget/admission-client.js";
import type { AdmissionLease } from "../budget/admission-types.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  SESSION_ID_ARG,
  signAllowedRoots,
  verifyAllowedRoots,
  withSignedAllowedRoots,
} from "../tools/system/filesystem.js";
import { signSessionId } from "../agents/_deps/filesystem-args.js";
import { createApplyPatchTool } from "../tools/apply-patch/tool.js";
import { cloneFileStateCache } from "../utils/fileStateCache.js";
import { normalizeLspServerConfig } from "../services/lsp/config.js";
import type { LSPServerInstance } from "../services/lsp/LSPServerInstance.js";
import {
  getLspServerManager,
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
} from "../services/lsp/manager.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "fake-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "fake-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(
  overrides?: { readonly [K in keyof SessionConfiguration]?: SessionConfiguration[K] },
): SessionConfiguration {
  const base: SessionConfiguration = {
    cwd: "/tmp",
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
    collaborationMode: { model: "fake-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...overrides,
    collaborationMode: {
      ...base.collaborationMode,
      ...(overrides?.collaborationMode ?? {}),
    },
  };
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  };
}

function makeStubSession(opts: {
  services?: { readonly [K in keyof SessionServices]?: SessionServices[K] };
  sessionConfiguration?: SessionConfiguration;
  config?: Config;
  modelInfo?: ModelInfo;
  roleWorkspace?: SessionOpts["roleWorkspace"];
  agentDefinitions?: SessionOpts["agentDefinitions"];
  conversationId?: string;
} = {}): Session {
  const state = {
    sessionConfiguration:
      opts.sessionConfiguration ??
      mkSessionConfiguration({
        provider: { slug: "fake-provider" } as unknown as SessionConfiguration["provider"],
      }),
    history: [],
  };
  const session = new Session({
    conversationId: opts.conversationId ?? "conv-parent",
    ...(opts.roleWorkspace !== undefined
      ? { roleWorkspace: opts.roleWorkspace }
      : {}),
    ...(opts.agentDefinitions !== undefined
      ? { agentDefinitions: opts.agentDefinitions }
      : {}),
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    services: {
      mcpConnectionManager: {
        setApprovalPolicy: () => {},
        setSandboxPolicy: () => {},
        requiredStartupFailures: async () => [],
      },
      mcpStartupCancellationToken: {
        cancel: () => {},
        isCancelled: () => false,
      },
      provider: makeProvider([]),
      registry: mkRegistry(),
      hooks: {
        executeStop: async () => ({}),
      },
      admissionRequired: false,
      ...(opts.services ?? {}),
    } as unknown as SessionServices,
    jsRepl: { id: "repl-test" },
    config: opts.config ?? mkConfig(),
    modelInfo: opts.modelInfo ?? mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  return session;
}

function makeProvider(
  responses: Array<{ readonly [K in keyof LLMResponse]?: LLMResponse[K] }>,
): LLMProvider {
  const queue = [...responses];
  return {
    name: "fake",
    chat: vi.fn(async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "fake-model",
      finishReason: "stop",
      ...(queue.shift() ?? {}),
    })),
    chatStream: vi.fn(
      async (
        _messages: LLMMessage[],
        _onChunk: StreamProgressCallback,
      ): Promise<LLMResponse> => ({
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "fake-model",
        finishReason: "stop",
        ...(queue.shift() ?? {}),
      }),
    ),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

async function collectRun(
  iter: AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void>,
): Promise<{
  events: RunAgentProgressEvent[];
  result: RunAgentResult;
}> {
  const events: RunAgentProgressEvent[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return { events, result: step.value };
    }
    events.push(step.value);
  }
}

async function spawnLive(session: Session, roleName?: string) {
  const registry = new AgentRegistry();
  const control = new AgentControl({
    session: session as unknown as ConstructorParameters<
      typeof AgentControl
    >[0]["session"],
    registry,
  });
  const live = await control.spawn({
    parentPath: "/root",
    ...(roleName !== undefined ? { roleName } : {}),
  });
  return { control, registry, live };
}

function makeChildToolAdmission(options: {
  readonly runId: string;
  readonly sessionId: string;
  readonly denyReason?: string;
}) {
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => {
      if (options.denyReason !== undefined) {
        throw new AdmissionDeniedError(options.denyReason);
      }
      return {
        decision: "allow",
        reservation: {
          reservationId: `reservation-${input.stepId}`,
          step: { runId: options.runId, stepId: input.stepId },
          reservedCostUsd: input.maxCostUsd ?? 0,
          reservedTokens: input.maxInputTokens + input.maxOutputTokens,
          reservedAt: "2026-07-18T00:00:00.000Z",
        },
        request: {
          step: { runId: options.runId, stepId: input.stepId },
          kind: input.kind,
          estimate: {
            maxInputTokens: input.maxInputTokens,
            maxOutputTokens: input.maxOutputTokens,
            maxCostUsd: input.maxCostUsd,
          },
          workspaceId: "workspace-child",
          sessionId: input.sessionId ?? options.sessionId,
          parentScopeId: input.parentScopeId,
          autonomous: false,
        },
        signal: new AbortController().signal,
      };
    },
  );
  const markDispatched = vi.fn();
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: "reconciled" as const,
  }));
  let client: ExecutionAdmissionClient;
  client = {
    scope: {
      runId: options.runId,
      workspaceId: "workspace-child",
      sessionId: options.sessionId,
      autonomous: false,
    },
    acquire,
    markDispatched,
    reconcile,
    holdUnknown: vi.fn(),
    cancelRun: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(() => client),
    subscribe: vi.fn(() => () => {}),
  };
  return { acquire, client, markDispatched, reconcile };
}

type OwnedChildProviderScenario = "success" | "error" | "abort";

async function exerciseOwnedChildProvider(
  scenario: OwnedChildProviderScenario,
): Promise<{
  readonly result: RunAgentResult;
  readonly forkForSession: ReturnType<typeof vi.fn>;
  readonly childDispose: ReturnType<typeof vi.fn>;
  readonly parentDispose: ReturnType<typeof vi.fn>;
  readonly parentPrewarmClear: ReturnType<typeof vi.fn>;
  readonly cleanupOrder: readonly string[];
  readonly childStartupPrewarm: unknown;
  readonly parentBroker: SandboxExecutionBroker;
  readonly childCwd: string;
}> {
  const cleanupOrder: string[] = [];
  let childStartupPrewarm: unknown;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const childDispose = vi.fn(async () => {
    cleanupOrder.push("provider_dispose");
  });
  const childProvider: LLMProvider = {
    ...makeProvider([]),
    dispose: childDispose,
    chatStream: vi.fn(async (_messages, _onChunk, options) => {
      resolveStarted?.();
      if (scenario === "error") throw new Error("owned_child_failure");
      if (scenario === "abort") {
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          const rejectAbort = () => reject(new Error("owned_child_aborted"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return {
        content: "owned child response",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "fake-model",
        finishReason: "stop",
      };
    }),
  };
  const parentDispose = vi.fn(async () => {});
  const forkForSession = vi.fn(() => childProvider);
  const parentProvider: LLMProvider = {
    ...makeProvider([]),
    dispose: parentDispose,
    forkForSession,
  };
  const parentBroker = new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd: "/tmp",
  });
  const parentPrewarmClear = vi.fn(async () => {});
  const session = makeStubSession({
    services: {
      provider: parentProvider,
      sandboxExecutionBroker: parentBroker,
      startupPrewarm: {
        setProviderHandle: vi.fn(),
        setProviderTask: vi.fn(),
        consumeProviderHandle: vi.fn(async () => undefined),
        expireProviderHandle: vi.fn(async () => {}),
        clear: parentPrewarmClear,
      },
    },
  });
  const { live } = await spawnLive(session);
  const childCwd = `/tmp/agenc-owned-child-${scenario}`;
  const externalAbort = new AbortController();
  const originalShutdown = Session.prototype.shutdown;
  const shutdownSpy = vi
    .spyOn(Session.prototype, "shutdown")
    .mockImplementation(async function (this: Session): Promise<void> {
      if (this !== session) {
        childStartupPrewarm = this.services.startupPrewarm;
        cleanupOrder.push("child_shutdown");
      }
      await originalShutdown.call(this);
    });

  try {
    const run = collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        worktree: {
          path: childCwd,
          branch: `worktree-${scenario}`,
          gitRoot: "/tmp",
          created: false,
        },
        externalSignal: externalAbort.signal,
      }),
    );
    if (scenario === "abort") {
      await started;
      externalAbort.abort("ownership_test_abort");
    }
    const { result } = await run;
    return {
      result,
      forkForSession,
      childDispose,
      parentDispose,
      parentPrewarmClear,
      cleanupOrder,
      childStartupPrewarm,
      parentBroker,
      childCwd,
    };
  } finally {
    shutdownSpy.mockRestore();
  }
}

function mkNamedTool(name: string): ToolRegistry["tools"][number] {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    execute: async () => ({ content: "{}" }),
  };
}

function mkNamedRegistry(names: readonly string[]): ToolRegistry {
  const tools = names.map(mkNamedTool);
  return {
    tools,
    toLLMTools: () =>
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    dispatch: async () => ({ content: "{}" }),
  };
}

beforeEach(() => {
  _resetAgentRolesForTesting();
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  _resetAgentRolesForTesting();
  _resetNicknamePoolForTesting();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// runAgent
// ─────────────────────────────────────────────────────────────────────

describe("runAgent", () => {
  it.each([
    ["success", "completed"],
    ["error", "errored"],
    ["abort", "interrupted"],
  ] as const)(
    "owns a forked child provider through %s cleanup",
    async (scenario, expectedOutcome) => {
      const exercised = await exerciseOwnedChildProvider(scenario);

      expect(exercised.result.outcome).toBe(expectedOutcome);
      expect(exercised.forkForSession).toHaveBeenCalledOnce();
      const forkOptions = exercised.forkForSession.mock.calls[0]?.[0] as {
        readonly cwd: string;
        readonly sandboxExecutionBroker: SandboxExecutionBroker;
      };
      expect(forkOptions.cwd).toBe(exercised.childCwd);
      expect(forkOptions.sandboxExecutionBroker).not.toBe(
        exercised.parentBroker,
      );
      expect(forkOptions.sandboxExecutionBroker.cwd).toBe(exercised.childCwd);
      expect(exercised.childStartupPrewarm).toBeUndefined();
      expect(exercised.parentPrewarmClear).not.toHaveBeenCalled();
      expect(exercised.childDispose).toHaveBeenCalledOnce();
      expect(exercised.parentDispose).not.toHaveBeenCalled();
      expect(exercised.cleanupOrder).toEqual([
        "child_shutdown",
        "provider_dispose",
      ]);
    },
  );

  it("forks the LSP manager into the child authority and stops it before provider disposal", async () => {
    const lspEnv = {
      AGENC_SIMPLE: process.env.AGENC_SIMPLE,
      AGENC_BARE: process.env.AGENC_BARE,
      AGENC_DISABLE_LSP: process.env.AGENC_DISABLE_LSP,
    };
    delete process.env.AGENC_SIMPLE;
    delete process.env.AGENC_BARE;
    delete process.env.AGENC_DISABLE_LSP;
    const cleanupOrder: string[] = [];
    const openedUris: string[] = [];
    const parentBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: tmpdir(),
    });
    const config = normalizeLspServerConfig("typescript", {
      command: "test-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    let serverIndex = 0;
    const instanceFactory = (): LSPServerInstance => {
      const index = serverIndex++;
      let state: LSPServerInstance["state"] = "stopped";
      return {
        name: `server-${index}`,
        config,
        get state() {
          return state;
        },
        start: async () => {
          state = "running";
        },
        stop: async () => {
          state = "stopped";
          cleanupOrder.push(`lsp_stop_${index}`);
        },
        restart: async () => {},
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async (method, params) => {
          if (method !== "textDocument/didOpen") return;
          const uri = (
            params as { readonly textDocument?: { readonly uri?: unknown } }
          ).textDocument?.uri;
          if (typeof uri === "string") openedUris.push(uri);
        },
        onNotification: () => {},
        onRequest: () => {},
      } as unknown as LSPServerInstance;
    };
    initializeLspServerManager({
      workspaceRoot: tmpdir(),
      sandboxExecutionBroker: parentBroker,
      configSource: () => ({ typescript: config }),
      instanceFactory,
    });
    await waitForInitialization(parentBroker);
    const parentManager = getLspServerManager(parentBroker);
    const childCwd = join(tmpdir(), "agenc-owned-child-lsp");
    let childBroker: SandboxExecutionBroker | undefined;
    let observedChildManager: ReturnType<typeof getLspServerManager>;
    const childDispose = vi.fn(async () => {
      cleanupOrder.push("provider_dispose");
    });
    const childProvider: LLMProvider = {
      ...makeProvider([]),
      dispose: childDispose,
      chatStream: vi.fn(async () => {
        expect(childBroker).toBeDefined();
        await waitForInitialization(childBroker);
        observedChildManager = getLspServerManager(childBroker);
        await observedChildManager?.openFile("owned.ts", "const owned = true;");
        return {
          content: "done",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "fake-model",
          finishReason: "stop",
        };
      }),
    };
    const parentProvider: LLMProvider = {
      ...makeProvider([]),
      forkForSession: vi.fn((options) => {
        childBroker = options.sandboxExecutionBroker as SandboxExecutionBroker;
        return childProvider;
      }),
    };
    const session = makeStubSession({
      services: {
        provider: parentProvider,
        sandboxExecutionBroker: parentBroker,
      },
    });
    const { live } = await spawnLive(session);

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
          worktree: {
            path: childCwd,
            branch: "worktree-lsp",
            gitRoot: "/tmp",
            created: false,
          },
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(observedChildManager).toBeDefined();
      expect(observedChildManager).not.toBe(parentManager);
      expect(openedUris).toEqual([
        pathToFileURL(join(childCwd, "owned.ts")).href,
      ]);
      expect(getLspServerManager(parentBroker)).toBe(parentManager);
      expect(getLspServerManager(childBroker)).toBeUndefined();
      expect(childDispose).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["lsp_stop_1", "provider_dispose"]);
    } finally {
      await shutdownLspServerManager(parentBroker);
      for (const [key, value] of Object.entries(lspEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("cleans child broker participants when Session construction fails", async () => {
    const lspEnv = {
      AGENC_SIMPLE: process.env.AGENC_SIMPLE,
      AGENC_BARE: process.env.AGENC_BARE,
      AGENC_DISABLE_LSP: process.env.AGENC_DISABLE_LSP,
    };
    delete process.env.AGENC_SIMPLE;
    delete process.env.AGENC_BARE;
    delete process.env.AGENC_DISABLE_LSP;
    const parentBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: tmpdir(),
    });
    const config = normalizeLspServerConfig("typescript", {
      command: "test-language-server",
      extensionToLanguage: { ".ts": "typescript" },
    });
    let serverIndex = 0;
    const instanceFactory = (): LSPServerInstance => {
      const name = `server-${serverIndex++}`;
      let state: LSPServerInstance["state"] = "stopped";
      return {
        name,
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
        isHealthy: () => true,
        sendRequest: async () => ({}),
        sendNotification: async () => {},
        onNotification: () => {},
        onRequest: () => {},
      } as unknown as LSPServerInstance;
    };
    initializeLspServerManager({
      workspaceRoot: tmpdir(),
      sandboxExecutionBroker: parentBroker,
      configSource: () => ({ typescript: config }),
      instanceFactory,
    });
    await waitForInitialization(parentBroker);
    const childDispose = vi.fn(async () => {});
    const childProvider: LLMProvider = {
      ...makeProvider([]),
      dispose: childDispose,
    };
    let childBroker: SandboxExecutionBroker | undefined;
    const session = makeStubSession({
      services: {
        sandboxExecutionBroker: parentBroker,
        provider: {
          ...makeProvider([]),
          forkForSession: vi.fn((options) => {
            childBroker = options.sandboxExecutionBroker as SandboxExecutionBroker;
            return childProvider;
          }),
        },
      },
    });
    const { live } = await spawnLive(session);
    // Force the child constructor's trust-domain assertion to fail after the
    // forked LSP participant has registered on its broker.
    (
      session.agentDefinitions as unknown as {
        agentRoleWorkspaceId: string;
      }
    ).agentRoleWorkspaceId = "mismatched-workspace";

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );

      expect(result.outcome).toBe("errored");
      expect(childBroker).toBeDefined();
      expect(getLspServerManager(childBroker)).toBeUndefined();
      expect(isSandboxExecutionBrokerDisposed(childBroker!)).toBe(true);
      expect(getLspServerManager(parentBroker)).toBeDefined();
      expect(childDispose).toHaveBeenCalledOnce();
    } finally {
      await shutdownLspServerManager(parentBroker);
      for (const [key, value] of Object.entries(lspEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps parent MCP transports and MCP-origin tool closures out of child sessions", async () => {
    const refreshFromConfig = vi.fn(async () => ({
      configuredServers: ["parent"],
      requiredServers: [],
    }));
    const parentMcpManager = {
      effectiveServers: async () => new Map(),
      toolPluginProvenance: async () => null,
      refreshFromConfig,
      getTools: () => [],
      getConnectedServers: () => ["parent"],
      isConnected: () => true,
    } as unknown as SessionServices["mcpManager"];
    const builtin = mkNamedTool("system.echo");
    const directMcp = {
      ...mkNamedTool("mcp.parent.query"),
      serverId: "parent",
      metadata: { source: "mcp", family: "mcp" },
    };
    const resourceMcp = {
      ...mkNamedTool("ListMcpResources"),
      metadata: { source: "builtin", family: "mcp" },
    };
    const registry = {
      tools: [builtin, directMcp, resourceMcp],
      toLLMTools: () =>
        [builtin, directMcp, resourceMcp].map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      dispatch: vi.fn(async () => ({ content: "parent dispatch" })),
    } satisfies ToolRegistry;
    const provider = makeProvider([{ content: "done" }]);
    const session = makeStubSession({
      services: { provider, registry, mcpManager: parentMcpManager },
    });
    const { live } = await spawnLive(session);
    live.downInbox.send({
      author: "/root",
      recipient: live.agentPath,
      content: "",
      triggerTurn: false,
      direction: "down",
      metadata: { kind: "mcp_refresh", mcpConfig: { servers: ["child"] } },
    });
    let childServices: SessionServices | undefined;
    const originalShutdown = Session.prototype.shutdown;
    const shutdownSpy = vi
      .spyOn(Session.prototype, "shutdown")
      .mockImplementation(async function (this: Session): Promise<void> {
        if (this !== session) childServices = this.services;
        await originalShutdown.call(this);
      });

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(refreshFromConfig).not.toHaveBeenCalled();
      expect(childServices?.mcpManager).not.toBe(parentMcpManager);
      expect(childServices?.mcpManager.getConnectedServers?.()).toEqual([]);
      expect(childServices?.registry.tools.map((tool) => tool.name)).toEqual([
        "system.echo",
      ]);
      const deniedMcpDispatch = await childServices!.registry.dispatch({
        id: "mcp-call",
        name: "mcp.parent.query",
        arguments: "{}",
      });
      expect(deniedMcpDispatch).toMatchObject({ isError: true });
      expect(registry.dispatch).not.toHaveBeenCalled();
      const providerOptions = (
        provider.chatStream as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[2] as LLMChatOptions | undefined;
      expect(providerOptions?.tools?.map((tool) => tool.function.name)).toEqual([
        "system.echo",
      ]);
    } finally {
      shutdownSpy.mockRestore();
    }
  });

  it("preserves provider session forking and disposal through the AgentSummary wrapper", async () => {
    const nestedDispose = vi.fn(async () => {});
    const nestedProvider: LLMProvider = {
      ...makeProvider([]),
      dispose: nestedDispose,
    };
    const nestedFork = vi.fn(() => nestedProvider);
    const childDispose = vi.fn(async () => {});
    const childProvider: LLMProvider = {
      ...makeProvider([{ content: "summary seed" }]),
      forkForSession: nestedFork,
      dispose: childDispose,
    };
    const parentBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/tmp",
    });
    const session = makeStubSession({
      services: {
        sandboxExecutionBroker: parentBroker,
        provider: {
          ...makeProvider([]),
          forkForSession: vi.fn(() => childProvider),
        },
      },
    });
    const { live } = await spawnLive(session);
    let summaryProvider: LLMProvider | undefined;

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        onCacheSafeParams: (params) => {
          summaryProvider = (
            params as unknown as {
              toolUseContext: { provider: LLMProvider };
            }
          ).toolUseContext.provider;
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    expect(summaryProvider).toBeDefined();
    expect(summaryProvider).not.toBe(childProvider);
    const nestedBroker = parentBroker.forkForCwd("/tmp/nested-agent");
    const nestedWrapped = summaryProvider!.forkForSession?.({
      cwd: nestedBroker.cwd,
      sandboxExecutionBroker: nestedBroker,
    });
    expect(nestedFork).toHaveBeenCalledOnce();
    expect(nestedWrapped).toBeDefined();
    expect(nestedWrapped).not.toBe(nestedProvider);
    await nestedWrapped?.dispose?.();
    expect(nestedDispose).toHaveBeenCalledOnce();
    expect(childDispose).toHaveBeenCalledOnce();
  });

  it("drives a single provider turn and forwards the assistant text via upInbox", async () => {
    const provider = makeProvider([{ content: "hello world" }]);
    const session = makeStubSession({ services: { provider } });
    const submit = vi.fn(async () => {});
    session.installTurnDriverHooks({ submit });
    const { live } = await spawnLive(session);

    const sent: InterAgentCommunication[] = [];
    const originalSend = live.upInbox.send.bind(live.upInbox);
    live.upInbox.send = (msg) => {
      sent.push({ ...(msg as InterAgentCommunication), seq: 0 });
      return originalSend(msg);
    };

    const initial: LLMMessage[] = [
      { role: "system", content: "you are a subagent" },
      { role: "user", content: "please respond" },
    ];
    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: initial,
        taskPrompt: "please respond",
      }),
    );

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    const [passedMessages, _onChunk, passedOptions] = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[0]! as [
      LLMMessage[],
      StreamProgressCallback,
      { signal?: AbortSignal; systemPrompt?: string },
    ];
    expect(passedMessages).toHaveLength(1);
    expect(passedMessages[0]!.role).toBe("user");
    expect(passedOptions?.systemPrompt).toContain("you are a subagent");
    expect(passedOptions?.signal).toBeDefined();

    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("hello world");
    expect(result.toolCallCount).toBe(0);

    expect(
      sent.map((msg) => msg.metadata?.kind),
    ).toEqual(["subagent_status"]);
    const parentMessages = session.mailbox.drain();
    expect(parentMessages).toHaveLength(1);
    expect(parentMessages[0]).toMatchObject({
      author: live.agentPath,
      recipient: "/root",
      direction: "up",
      triggerTurn: true,
      metadata: { kind: "subagent_notification" },
    });
    expect(parentMessages[0]!.content).toBe(
      `<subagent_notification>\n{"agent_path":"${live.agentPath}","status":{"completed":"hello world"}}\n</subagent_notification>`,
    );

    expect(events.some((e) => e.kind === "run_complete")).toBe(true);
    expect(events.some((e) => e.kind === "status")).toBe(true);
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith("", { displayUserMessage: null });
    });
    // Initial messages + assistant reply message.
    expect(events.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("resolves project instructions from the child workspace exactly once", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-child-instructions-"));
    try {
      writeFileSync(join(workspace, "package.json"), "{}", "utf8");
      writeFileSync(
        join(workspace, "AGENC.md"),
        "CHILD_WORKSPACE_SENTINEL_92ac",
        "utf8",
      );
      const provider = makeProvider([{ content: "child done" }]);
      const session = makeStubSession({
        services: {
          provider,
          configStore: {
            current: () => ({}),
          } as SessionServices["configStore"],
        },
        roleWorkspace: createAgentRoleWorkspace(workspace),
        config: { ...mkConfig(), cwd: workspace },
        sessionConfiguration: mkSessionConfiguration({ cwd: workspace }),
      });
      const { live } = await spawnLive(session);
      await collectRun(
        runAgent({
          live,
          parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
          initialMessages: [{ role: "user", content: "do it" }],
          taskPrompt: "do it",
        }),
      );

      const [_messages, _onChunk, options] = (
        provider.chatStream as ReturnType<typeof vi.fn>
      ).mock.calls[0]! as [
        LLMMessage[],
        StreamProgressCallback,
        LLMChatOptions,
      ];
      expect(options.systemPrompt?.match(/CHILD_WORKSPACE_SENTINEL_92ac/g)).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  // LIVE-USAGE backstop (D1/D2). The fan-out Agents rail + `/cost` BY-AGENT
  // read `live.tokenUsage.totalTokens` (via tasks/agent-thread.ts
  // liveAgentCounts). D2 (#1329) proved the event->rail plumbing with an
  // INJECTED count; this proves the UPSTREAM: a real subagent turn whose
  // provider reports usage actually populates `live.tokenUsage` (and emits a
  // `usage_update` progress event) through the real run-turn/stream-model
  // path — so the rail shows TRUE tokens, not the live `tokens 0` bug.
  it("accumulates real provider usage onto live.tokenUsage for a completed subagent turn (the rail's source)", async () => {
    const provider = makeProvider([
      {
        content: "subagent done",
        finishReason: "stop",
        usage: { promptTokens: 31, completionTokens: 11, totalTokens: 42 },
      },
    ]);
    const session = makeStubSession({ services: { provider } });
    const submit = vi.fn(async () => {});
    session.installTurnDriverHooks({ submit });
    const { live } = await spawnLive(session);

    // Pre-condition: the live handle starts at the frozen-zero state that the
    // live bug never moved off of.
    expect(live.tokenUsage.totalTokens).toBe(0);

    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(result.outcome).toBe("completed");
    // The real upstream populated the per-agent counter the rail renders.
    expect(live.tokenUsage.totalTokens).toBe(42);
    expect(live.tokenUsage.inputTokens).toBe(31);
    expect(live.tokenUsage.outputTokens).toBe(11);
    // …and surfaced it as a progress event so live snapshots refresh.
    const usageUpdate = events.find((e) => e.kind === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(
      (usageUpdate as { totalTokens?: number } | undefined)?.totalTokens,
    ).toBe(42);
  });

  it("ignores array-shaped parent services when resolving the provider", async () => {
    const provider = makeProvider([{ content: "should not run" }]);
    const session = makeStubSession();
    const { live } = await spawnLive(session);
    (session as unknown as { services: unknown }).services = Object.assign(
      ["spoof"],
      { provider },
    );

    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "run_error")).toBe(true);
  });

  it("marks completed on success", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(live.status.value.status).toBe("completed");
    if (live.status.value.status === "completed") {
      expect(live.status.value.lastMessage).toBe("ok");
    }
  });

  it("marks interrupted when the child turn reports cancellation", async () => {
    const provider = makeProvider([{ content: "should not run" }]);
    const session = makeStubSession({
      services: {
        provider,
        guardianRejectionCircuitBreaker: {
          clearTurn: vi.fn(),
          isOpen: vi.fn(() => true),
        } as never,
      },
    });
    const { live } = await spawnLive(session);

    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(result.outcome).toBe("interrupted");
    expect(live.status.value.status).toBe("interrupted");
    expect(events.some((event) => event.kind === "run_interrupted")).toBe(true);
    expect(events.some((event) => event.kind === "run_complete")).toBe(false);
  });

  it("removes the external abort listener after completion", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const external = new AbortController();
    const addListener = vi.spyOn(external.signal, "addEventListener");
    const removeListener = vi.spyOn(external.signal, "removeEventListener");

    await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        externalSignal: external.signal,
      }),
    );

    const abortListener = addListener.mock.calls.find(
      (call) => call[0] === "abort",
    )?.[1];
    expect(abortListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });

  it("runs child turns through the session turn loop and counts tool calls", async () => {
    const provider = makeProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
      { content: "tool work complete" },
    ]);
    const session = makeStubSession({
      services: {
        provider,
        registry: {
          tools: [
            {
              name: "system.echo",
              description: "echo",
              inputSchema: { type: "object" },
              execute: async () => ({ content: JSON.stringify({ ok: true }) }),
            },
          ],
          toLLMTools: () => [
            {
              type: "function",
              function: {
                name: "system.echo",
                description: "echo",
                parameters: { type: "object" },
              },
            },
          ],
          dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
        } satisfies ToolRegistry,
      },
    });
    const { live } = await spawnLive(session);

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    expect(result.finalMessage).toBe("tool work complete");
    expect(result.toolCallCount).toBe(1);
  });

  it("applies a per-spawn service tier to the child session provider request", async () => {
    const seenOptions: LLMChatOptions[] = [];
    const provider = {
      ...makeProvider([]),
      chatStream: vi.fn(
        async (
          _messages: LLMMessage[],
          _onChunk: StreamProgressCallback,
          options?: LLMChatOptions,
        ): Promise<LLMResponse> => {
          if (options !== undefined) seenOptions.push(options);
          return {
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "fake-model",
            finishReason: "stop",
          };
        },
      ),
    } satisfies LLMProvider;
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        serviceTier: "priority",
      }),
    );

    expect(seenOptions[0]?.serviceTier).toBe("priority");
    expect(live.configSnapshot).toMatchObject({ serviceTier: "priority" });
  });

  it("applies role model, reasoning, and service tier to the child session", async () => {
    registerAgentRole(ROLE_WORKSPACE, {
      name: "priority-reviewer",
      config: {
        description: "Review quickly.",
        configToml: [
          'model = "gpt-5.4"',
          'model_reasoning_effort = "high"',
          'service_tier = "priority"',
        ].join("\n"),
      },
    });
    const seenOptions: LLMChatOptions[] = [];
    const provider = {
      ...makeProvider([]),
      chatStream: vi.fn(
        async (
          _messages: LLMMessage[],
          _onChunk: StreamProgressCallback,
          options?: LLMChatOptions,
        ): Promise<LLMResponse> => {
          if (options !== undefined) seenOptions.push(options);
          return {
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "gpt-5.4",
            finishReason: "stop",
          };
        },
      ),
    } satisfies LLMProvider;
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session, "priority-reviewer");

    await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(seenOptions[0]?.reasoningEffort).toBe("high");
    expect(seenOptions[0]?.serviceTier).toBe("priority");
    expect(live.configSnapshot).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });

  it("captures AgentSummary cache-safe params from the real child run state", async () => {
    const provider = makeProvider([{ content: "summary seed" }]);
    const registry = {
      tools: [
        {
          name: "system.echo",
          description: "echo",
          inputSchema: { type: "object" },
          execute: async () => ({ content: JSON.stringify({ ok: true }) }),
        },
      ],
      toLLMTools: () => [
        {
          type: "function",
          function: {
            name: "system.echo",
            description: "echo",
            parameters: { type: "object" },
          },
        },
      ],
      dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
    } satisfies ToolRegistry;
    const session = makeStubSession({ services: { provider, registry } });
    const { live } = await spawnLive(session);
    const captured: unknown[] = [];

    await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        onCacheSafeParams: (params) => {
          captured.push(params);
        },
      }),
    );

    expect(captured).toHaveLength(1);
    const chatStreamCall = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[0] as
      | [LLMMessage[], StreamProgressCallback, LLMChatOptions]
      | undefined;
    expect(chatStreamCall).toBeDefined();
    const [providerMessages, , providerOptions] = chatStreamCall!;
    const params = captured[0] as {
      systemPrompt: string;
      systemContext: { cwd: string };
      toolUseContext: {
        provider: LLMProvider;
        options: {
          mainLoopModel: string;
          tools: Array<{ name: string }>;
          contextWindowTokens: number;
        };
        getAppState: () => unknown;
        readFileState: {
          max: number;
          maxSize: number;
          dump: () => unknown;
        };
      };
      forkContextMessages: unknown[];
    };
    expect(params.systemPrompt).toBe(providerOptions.systemPrompt ?? "");
    expect(params.systemContext).toEqual({ cwd: "/tmp" });
    expect(params.toolUseContext.provider.name).toBe(provider.name);
    expect(params.toolUseContext.options.mainLoopModel).toBe("fake-model");
    expect(params.toolUseContext.options.tools.map((tool) => tool.name)).toEqual(
      providerOptions.tools?.map((tool) => tool.function.name),
    );
    expect(params.toolUseContext.options.contextWindowTokens).toBe(
      providerOptions.contextWindowTokens,
    );
    expect(typeof params.toolUseContext.getAppState).toBe("function");
    expect(params.toolUseContext.readFileState.max).toBeGreaterThan(0);
    expect(params.toolUseContext.readFileState.maxSize).toBeGreaterThan(0);
    expect(typeof params.toolUseContext.readFileState.dump).toBe("function");
    expect(
      cloneFileStateCache(params.toolUseContext.readFileState as never).max,
    ).toBe(params.toolUseContext.readFileState.max);
    expect(
      params.forkContextMessages[0],
    ).toEqual(
      expect.objectContaining({
        type: "user",
        message: expect.objectContaining({
          content: providerMessages[0]?.content,
        }),
      }),
    );
  });

  it("preserves the canonical parent catalog in a real worktree child session", async () => {
    const provider = makeProvider([{ content: "nested catalog" }]);
    const exactPluginAgent = {
      agentType: "plugin:strict-reviewer",
      description: "workspace exact plugin role",
      source: "plugin",
      getSystemPrompt: () => "strict reviewer prompt",
    };
    const session = makeStubSession({
      services: { provider },
      roleWorkspace: ROLE_WORKSPACE,
      agentDefinitions: {
        agentRoleWorkspaceId: ROLE_WORKSPACE.id,
        activeAgents: [exactPluginAgent],
        allAgents: [exactPluginAgent],
        allowedAgentTypes: ["plugin:strict-reviewer"],
      },
    });
    const { live } = await spawnLive(session);
    const childWorktree = mkdtempSync(join(tmpdir(), "agenc-child-catalog-"));
    let childCatalog:
      | {
          agentRoleWorkspaceId?: string;
          activeAgents: unknown[];
          allAgents?: unknown[];
          allowedAgentTypes?: unknown[];
        }
      | undefined;

    try {
      await collectRun(
        runAgent({
          live,
          parent: session,
          worktree: {
            path: childWorktree,
            branch: "agent/catalog-child",
            gitRoot: childWorktree,
            created: false,
          },
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
          onCacheSafeParams: (params) => {
            childCatalog = (
              params.toolUseContext as unknown as {
                options: { agentDefinitions: typeof childCatalog };
              }
            ).options.agentDefinitions;
          },
        }),
      );
    } finally {
      rmSync(childWorktree, { recursive: true, force: true });
    }

    expect(childCatalog).toMatchObject({
      agentRoleWorkspaceId: ROLE_WORKSPACE.id,
      activeAgents: [exactPluginAgent],
      allAgents: [exactPluginAgent],
      allowedAgentTypes: ["plugin:strict-reviewer"],
    });
    expect(childCatalog?.activeAgents).not.toBe(
      session.agentDefinitions.activeAgents,
    );
  });

  it("treats child maxTurns termination as an errored run", async () => {
    const provider = makeProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ]);
    const session = makeStubSession({
      services: {
        provider,
        registry: {
          tools: [
            {
              name: "system.echo",
              description: "echo",
              inputSchema: { type: "object" },
              execute: async () => ({ content: JSON.stringify({ ok: true }) }),
            },
          ],
          toLLMTools: () => [
            {
              type: "function",
              function: {
                name: "system.echo",
                description: "echo",
                parameters: { type: "object" },
              },
            },
          ],
          dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
        } satisfies ToolRegistry,
      },
    });
    const { live } = await spawnLive(session);

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        maxTurns: 1,
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("subagent exceeded maxTurns (1)");
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
  });

  it("drains triggerTurn messages from the child downInbox into a follow-up turn", async () => {
    const provider = makeProvider([{ content: "first turn" }, { content: "second turn" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    live.downInbox.send({
      author: "/root",
      recipient: live.agentPath,
      content: "follow up",
      triggerTurn: true,
      direction: "down",
      metadata: { kind: "user_input" },
    });

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    const secondCall = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[1]![0] as LLMMessage[];
    expect(secondCall.at(-1)).toEqual({
      role: "user",
      content: "follow up",
    });
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("second turn");
  });

  it("surfaces a refresh_mcp_servers control message from the child downInbox", async () => {
    const provider = makeProvider([]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    live.downInbox.send({
      author: live.agentPath,
      recipient: live.agentPath,
      content: "",
      triggerTurn: false,
      direction: "down",
      metadata: { kind: "mcp_refresh", mcpConfig: { servers: ["x"] } },
    });

    const drained = drainChildMailboxForTesting(live);
    // Routed to the child as a control message (applied between turns); it
    // surfaces the config and does NOT trigger a follow-up turn.
    expect(drained.refreshMcpConfig).toEqual({ servers: ["x"] });
    expect(drained.nextUserMessage).toBeUndefined();
  });

  it("injects child session metadata and worktree roots into wrapped child tools", async () => {
    const childBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/tmp/subagent-wt",
    });
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
        sandboxExecutionBroker: childBroker,
      },
    );

    await registry.tools[0]!.execute({ value: "hello" });

    expect(execute).toHaveBeenCalledOnce();
    const parsed = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(parsed[SESSION_ID_ARG]).toBe("child-123");
    expect(parsed[SESSION_ALLOWED_ROOTS_ARG]).toEqual(["/tmp/subagent-wt"]);
    expect(parsed.value).toBe("hello");
    expect(readSandboxExecutionBroker(parsed)).toBe(childBroker);
  });

  it("admits direct child-registry dispatch with the child run/session identity", async () => {
    const admission = makeChildToolAdmission({
      runId: "run-child-direct",
      sessionId: "child-direct",
    });
    const childSession = makeStubSession({
      conversationId: "child-direct",
      services: {
        executionAdmission: admission.client,
        admissionRequired: true,
      },
    });
    const childBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/tmp/child-direct",
    });
    const execute = vi.fn(async () => ({ content: "admitted" }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            recoveryCategory: "idempotent",
            admissionEstimate: () => ({
              maxInputTokens: 0,
              maxOutputTokens: 0,
              maxCostUsd: 0,
            }),
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({ content: "base bypass" }),
      },
      {
        childConversationId: "child-direct",
        getSession: () => childSession,
        sandboxExecutionBroker: childBroker,
        childToolPolicy: (_tool, input) => ({
          behavior: "allow",
          updatedInput: { ...input, policyValue: "approved" },
        }),
      },
    );

    await expect(
      registry.dispatch({
        id: "call-direct",
        name: "system.echo",
        arguments: JSON.stringify({ value: "hello" }),
      }),
    ).resolves.toEqual({ content: "admitted" });

    expect(admission.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        stepId: "tool:registry:child-direct:call-direct",
        kind: "tool_exec",
        sessionId: "child-direct",
        parentScopeId: "registry:child-direct",
      }),
      undefined,
    );
    expect(admission.markDispatched).toHaveBeenCalledOnce();
    expect(admission.reconcile).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    const executedArgs = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(executedArgs).toMatchObject({
      value: "hello",
      policyValue: "approved",
      [SESSION_ID_ARG]: "child-direct",
    });
    expect(readSandboxExecutionBroker(executedArgs)).toBe(childBroker);
  });

  it("does not execute a direct child-registry dispatch denied by admission", async () => {
    const admission = makeChildToolAdmission({
      runId: "run-child-denied",
      sessionId: "child-denied",
      denyReason: "child_budget_exhausted",
    });
    const childSession = makeStubSession({
      conversationId: "child-denied",
      services: {
        executionAdmission: admission.client,
        admissionRequired: true,
      },
    });
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({ content: "base bypass" }),
      },
      {
        childConversationId: "child-denied",
        getSession: () => childSession,
      },
    );

    await expect(
      registry.dispatch({
        id: "call-denied",
        name: "Write",
        arguments: "{}",
      }),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "child_budget_exhausted",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(admission.markDispatched).not.toHaveBeenCalled();
  });

  it("fails direct child-registry dispatch closed without a child session", async () => {
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({ content: "base bypass" }),
      },
      { childConversationId: "child-missing-session" },
    );

    await expect(
      registry.dispatch({
        id: "call-missing-session",
        name: "system.echo",
        arguments: "{}",
      }),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "child_tool_admission_session_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails direct child-registry dispatch closed when the child has no kernel", async () => {
    const childSession = makeStubSession({
      conversationId: "child-without-kernel",
      services: { admissionRequired: false },
    });
    const execute = vi.fn(async () => ({ content: "must not run" }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({ content: "base bypass" }),
      },
      {
        childConversationId: "child-without-kernel",
        getSession: () => childSession,
      },
    );

    await expect(
      registry.dispatch({
        id: "call-without-kernel",
        name: "system.echo",
        arguments: "{}",
      }),
    ).rejects.toMatchObject({
      code: "ADMISSION_DENIED",
      reason: "child_tool_admission_kernel_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("mergeRoleDisallowlist unions a role denylist into the disabled set", () => {
    const base = new Set(["spawn_agent"]);
    expect(mergeRoleDisallowlist(base, undefined)).toBe(base);
    expect(mergeRoleDisallowlist(base, [])).toBe(base);
    const merged = mergeRoleDisallowlist(base, ["Edit", "Write"]);
    expect([...merged].sort()).toEqual(["Edit", "Write", "spawn_agent"]);
  });

  it("denies every read-only-disallowed tool (incl. MultiEdit/apply_patch) in advertised tools and at dispatch", async () => {
    const mkTool = (name: string) => ({
      name,
      description: name,
      inputSchema: { type: "object" } as const,
      execute: vi.fn(async () => ({ content: "{}", isError: false })),
    });
    // The full set of first-class mutating file tools + the allowed Read.
    const mutating = ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "spawn_agent"];
    const tools = [...mutating.map(mkTool), mkTool("Read")];
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () =>
          tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.name, parameters: { type: "object" } },
          })),
        dispatch: async () => ({ content: "{}", isError: false }),
      },
      {
        childConversationId: "child-deny",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        // Mirrors run-agent's call site: the read-only role denylist folded in.
        disabledTools: mergeRoleDisallowlist(new Set<string>(), BUILTIN_READONLY_DISALLOWLIST),
      },
    );

    const advertised = registry.tools.map((t) => t.name);
    for (const name of mutating) {
      expect(advertised).not.toContain(name);
      const denied = await registry.dispatch({ name, arguments: "{}" });
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain("tool not allowed for subagent");
    }
    // The non-denied read tool stays advertised and dispatchable.
    expect(advertised).toContain("Read");
    const allowed = await registry.dispatch({ name: "Read", arguments: "{}" });
    expect(allowed.isError).toBe(false);
  });

  it("a live read-only role spawn (Plan) strips mutating tools end-to-end", async () => {
    // Drives the real wiring: control.spawn -> role resolution (Plan carries the
    // read-only disallowlist) -> buildChildSession reads role.config.disallowlist
    // -> mergeRoleDisallowlist -> buildFilteredRegistry. A mutation on that chain
    // (e.g. dropping the disallowlist fold) makes this fail.
    const seenOptions: LLMChatOptions[] = [];
    const provider = {
      ...makeProvider([]),
      chatStream: vi.fn(
        async (
          _messages: LLMMessage[],
          _onChunk: StreamProgressCallback,
          options?: LLMChatOptions,
        ): Promise<LLMResponse> => {
          if (options !== undefined) seenOptions.push(options);
          return {
            content: "ok",
            toolCalls: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            model: "fake-model",
            finishReason: "stop",
          };
        },
      ),
    } satisfies LLMProvider;
    const parentRegistry = mkNamedRegistry([
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "apply_patch",
      "spawn_agent",
      "Read",
    ]);
    const session = makeStubSession({ services: { provider, registry: parentRegistry } });
    const { live } = await spawnLive(session, "Plan");
    expect(live.role.name).toBe("Plan");
    // The resolved role carries the read-only denylist (covers every mutating tool).
    expect(live.role.config.disallowlist).toEqual(BUILTIN_READONLY_DISALLOWLIST);

    await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    const advertised = (seenOptions[0]?.tools ?? []).map(
      (t: { name?: string; function?: { name?: string } }) =>
        t.name ?? t.function?.name ?? "",
    );
    for (const denied of [
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "apply_patch",
      "spawn_agent",
    ]) {
      expect(advertised).not.toContain(denied);
    }
    expect(advertised).toContain("Read");
  });

  it("strips model-supplied __agenc* keys before they reach a wrapped child tool", async () => {
    // SECURITY (audit #1/#2/#4): a child model that emits
    // `__agencSessionAllowedRoots:["/"]` must NOT have it folded into the
    // child's allowed roots. The runtime injects only the worktree root.
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
      },
    );

    await registry.tools[0]!.execute({
      value: "hello",
      // Model-controlled injection attempt:
      [SESSION_ALLOWED_ROOTS_ARG]: ["/"],
      [SESSION_ID_ARG]: "attacker-session",
      __agencHome: "/etc",
    });

    expect(execute).toHaveBeenCalledOnce();
    const parsed = execute.mock.calls[0]![0] as Record<string, unknown>;
    // The model's "/" root is stripped; only the runtime worktree remains.
    expect(parsed[SESSION_ALLOWED_ROOTS_ARG]).toEqual(["/tmp/subagent-wt"]);
    // The runtime's own session id wins, not the model-supplied one.
    expect(parsed[SESSION_ID_ARG]).toBe("child-123");
    // Arbitrary model `__agenc*` keys never reach the tool.
    expect(parsed.__agencHome).toBeUndefined();
    expect(parsed.value).toBe("hello");
  });

  it("strips model-supplied __agenc* keys on fallback dispatch before injection", async () => {
    const dispatch = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [],
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "VirtualTool",
              description: "virtual",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch,
      },
      {
        childConversationId: "child-123",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
      },
    );

    await registry.dispatch({
      id: "call-virtual",
      name: "VirtualTool",
      arguments: JSON.stringify({
        value: 1,
        [SESSION_ALLOWED_ROOTS_ARG]: ["/"],
      }),
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const forwarded = dispatch.mock.calls[0]![0] as {
      readonly arguments: string;
    };
    expect(JSON.parse(forwarded.arguments)).toEqual({
      value: 1,
      // Model's "/" stripped; runtime worktree injected and HMAC-signed.
      __agencSessionAllowedRoots: ["/tmp/subagent-wt"],
      __agencSessionAllowedRootsSig: signAllowedRoots(["/tmp/subagent-wt"]),
      // Session id injected via withSignedSessionId — id + HMAC signature.
      __agencSessionId: "child-123",
      __agencSessionIdSig: signSessionId("child-123"),
    });
    // The signed channel verifies and the model's "/" never enters it.
    const forwardedArgs = JSON.parse(forwarded.arguments) as Record<
      string,
      unknown
    >;
    expect(
      verifyAllowedRoots(
        forwardedArgs[SESSION_ALLOWED_ROOTS_ARG],
        forwardedArgs[SESSION_ALLOWED_ROOTS_SIG_ARG],
      ),
    ).toEqual(["/tmp/subagent-wt"]);
  });

  it("layers child tool policy before wrapped child tool execution", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
        childToolPolicy: (_tool, input) => ({
          behavior: "allow",
          // Real policies sign their injected roots via
          // withSignedAllowedRoots; the run-loop then unions + re-signs
          // alongside the worktree root.
          updatedInput: withSignedAllowedRoots(
            { ...input, file_path: "/tmp/memory/feedback.md" },
            ["/tmp/memory"],
          ),
        }),
      },
    );

    await registry.tools[0]!.execute({ file_path: "feedback.md" });

    expect(execute).toHaveBeenCalledOnce();
    const parsed = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(parsed.file_path).toBe("/tmp/memory/feedback.md");
    // Canonical (sorted) union of the signed policy root and worktree root.
    expect(parsed[SESSION_ALLOWED_ROOTS_ARG]).toEqual([
      "/tmp/memory",
      "/tmp/subagent-wt",
    ]);
    expect(
      verifyAllowedRoots(
        parsed[SESSION_ALLOWED_ROOTS_ARG],
        parsed[SESSION_ALLOWED_ROOTS_SIG_ARG],
      ),
    ).toEqual(["/tmp/memory", "/tmp/subagent-wt"]);
    expect(parsed[SESSION_ID_ARG]).toBe("child-123");
  });

  it("returns child policy denials with metadata", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        childToolPolicy: () => ({
          behavior: "deny",
          message: "outside memory",
          metadata: { reason: "write_outside_memory" },
        }),
      },
    );

    const result = await registry.tools[0]!.execute({
      file_path: "/tmp/other.md",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ error: "outside memory" }),
      isError: true,
      metadata: {
        reason: "write_outside_memory",
        childPolicyDenied: true,
      },
    });
  });

  it("preserves child policy denial metadata through registry dispatch", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "Write",
              description: "write",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        childToolPolicy: () => ({
          behavior: "deny",
          message: "outside memory",
          metadata: { reason: "write_outside_memory" },
        }),
      },
    );

    const result = await registry.dispatch({
      id: "call-write",
      name: "Write",
      arguments: JSON.stringify({ file_path: "/tmp/other.md" }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ error: "outside memory" }),
      isError: true,
      metadata: {
        reason: "write_outside_memory",
        childPolicyDenied: true,
      },
    });
  });

  it("applies child tool policy on fallback dispatch", async () => {
    const dispatch = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [],
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "VirtualTool",
              description: "virtual",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch,
      },
      {
        childConversationId: "child-123",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        childToolPolicy: (_tool, input) => ({
          behavior: "allow",
          updatedInput: {
            ...input,
            [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/memory"],
          },
        }),
      },
    );

    await registry.dispatch({
      id: "call-virtual",
      name: "VirtualTool",
      arguments: JSON.stringify({ value: 1 }),
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const forwarded = dispatch.mock.calls[0]![0] as {
      readonly arguments: string;
    };
    expect(JSON.parse(forwarded.arguments)).toEqual({
      value: 1,
      __agencSessionAllowedRoots: ["/tmp/memory"],
      __agencSessionId: "child-123",
      __agencSessionIdSig: signSessionId("child-123"),
    });
  });

  it("runs child apply_patch calls relative to the child worktree", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "agenc-parent-patch-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "agenc-child-patch-"));
    const applyPatchTool = createApplyPatchTool({
      cwd: parentRoot,
      allowedPaths: [parentRoot],
    });
    const registry = buildFilteredRegistry(
      {
        tools: [applyPatchTool],
        toLLMTools: () => [{
          type: "function",
          function: {
            name: "apply_patch",
            description: applyPatchTool.description,
            parameters: applyPatchTool.inputSchema,
          },
        }],
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        worktree: {
          path: worktreeRoot,
          branch: "worktree-child",
          gitRoot: parentRoot,
          created: false,
        },
      },
    );

    try {
      const result = await registry.dispatch({
        id: "patch-1",
        name: "apply_patch",
        arguments: JSON.stringify({
          input: `*** Begin Patch
*** Add File: child.txt
+child
*** End Patch`,
        }),
      });

      expect(result.isError).toBeUndefined();
      expect(readFileSync(join(worktreeRoot, "child.txt"), "utf8")).toBe(
        "child\n",
      );
      expect(existsSync(join(parentRoot, "child.txt"))).toBe(false);
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("keeps V2 agent tools available to child agents at the configured depth cap", async () => {
    const registry = buildFilteredRegistry(
      mkNamedRegistry(["spawn_agent", "wait_agent", "TaskList", "system.echo"]),
      {
        childConversationId: "child-123",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 1,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "wait_agent",
      "system.echo",
    ]);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "spawn_agent",
      "wait_agent",
      "system.echo",
    ]);
    await expect(
      registry.dispatch({ id: "call-1", name: "spawn_agent", arguments: "{}" }),
    ).resolves.toEqual({ content: "{}" });
    await expect(
      registry.dispatch({ id: "call-task-list", name: "TaskList", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: TaskList",
      }),
    });
  });

  it("filters task and main-thread coordination tools from V2 child agents", async () => {
    const leakedToolNames = [
      "TaskCreate",
      "TaskGet",
      "TaskUpdate",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "Brief",
      "SendUserMessage",
      "VerifyPlanExecution",
      "CronCreate",
      "CronDelete",
      "CronList",
      "WorkflowTool",
      "RemoteTrigger",
      "EnterPlanMode",
      "ExitPlanMode",
    ];
    const registry = buildFilteredRegistry(
      mkNamedRegistry([
        "spawn_agent",
        "wait_agent",
        "StructuredOutput",
        "system.echo",
        ...leakedToolNames,
      ]),
      {
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 1,
          maxDepth: 2,
        }),
      },
    );

    const advertisedNames = registry.tools.map((tool) => tool.name);
    expect(advertisedNames).toEqual([
      "spawn_agent",
      "wait_agent",
      "StructuredOutput",
      "system.echo",
    ]);
    for (const toolName of leakedToolNames) {
      expect(advertisedNames).not.toContain(toolName);
      await expect(
        registry.dispatch({ id: `call-${toolName}`, name: toolName, arguments: "{}" }),
      ).resolves.toMatchObject({
        isError: true,
        content: JSON.stringify({
          error: `tool not allowed for subagent: ${toolName}`,
        }),
      });
    }
  });

  it("keeps child denylisted tools blocked even when a role allowlist names them", async () => {
    const registry = buildFilteredRegistry(
      mkNamedRegistry(["TaskList", "system.echo"]),
      {
        allowlist: ["TaskList", "system.echo"],
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 0,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual(["system.echo"]);
    await expect(
      registry.dispatch({ id: "call-task-list", name: "TaskList", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: TaskList",
      }),
    });
  });

  it("does not re-advertise tools hidden by the parent registry", async () => {
    const tools = ["system.echo", "NotebookEdit", "TaskCreate"].map(mkNamedTool);
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "system.echo",
              description: "echo",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 0,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual(["system.echo"]);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.echo",
    ]);
    await expect(
      registry.dispatch({ id: "call-notebook", name: "NotebookEdit", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: NotebookEdit",
      }),
    });
  });

  it("tracks parent registry visibility when hidden coding tools are discovered later", async () => {
    const tools = ["system.searchTools", "Grep"].map(mkNamedTool);
    let visibleNames = ["system.searchTools"];
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () =>
          visibleNames.map((name) => ({
            type: "function",
            function: {
              name,
              description: `${name} tool`,
              parameters: { type: "object" },
            },
          })),
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
      },
    );

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.searchTools",
    ]);
    await expect(
      registry.dispatch({ id: "call-grep-before", name: "Grep", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: Grep",
      }),
    });

    visibleNames = ["system.searchTools", "Grep"];

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.searchTools",
      "Grep",
    ]);
    const result = await registry.dispatch({
      id: "call-grep-after",
      name: "Grep",
      arguments: "{}",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("{}");
  });

  it("mounts a child rollout store when the parent owns one", async () => {
    const provider = makeProvider([{ content: "child wrote rollout" }]);
    const cwd = mkdtempSync(join(tmpdir(), "agenc-run-agent-"));
    const session = makeStubSession({
      services: { provider },
      sessionConfiguration: mkSessionConfiguration({
        cwd,
        provider: provider as unknown as SessionConfiguration["provider"],
      }),
      config: {
        ...mkConfig(),
        cwd,
      },
    });
    const parentRolloutStore = new RolloutStore({
      cwd,
      sessionId: session.conversationId,
      agencVersion: "0.2.0",
    });
    parentRolloutStore.open({
      sessionId: session.conversationId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "run-agent-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: provider.name,
    });
    session.mountRolloutStore(parentRolloutStore);

    const { live } = await spawnLive(session);
    const childSessionDir = join(
      dirname(parentRolloutStore.store.sessionDir),
      live.agentId,
    );

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );

      expect(result.outcome).toBe("completed");
      const rolloutFiles = readdirSync(childSessionDir).filter(
        (entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"),
      );
      expect(rolloutFiles.length).toBeGreaterThan(0);
    } finally {
      parentRolloutStore.close();
      rmSync(childSessionDir, { recursive: true, force: true });
      rmSync(parentRolloutStore.store.sessionDir, {
        recursive: true,
        force: true,
      });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses parent mailbox notifications and child rollout in silent mode", async () => {
    const provider = makeProvider([{ content: "silent complete" }]);
    const cwd = mkdtempSync(join(tmpdir(), "agenc-run-agent-silent-"));
    const session = makeStubSession({
      services: { provider },
      sessionConfiguration: mkSessionConfiguration({
        cwd,
        provider: provider as unknown as SessionConfiguration["provider"],
      }),
      config: {
        ...mkConfig(),
        cwd,
      },
    });
    const parentRolloutStore = new RolloutStore({
      cwd,
      sessionId: session.conversationId,
      agencVersion: "0.2.0",
    });
    parentRolloutStore.open({
      sessionId: session.conversationId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "run-agent-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: provider.name,
    });
    session.mountRolloutStore(parentRolloutStore);

    const { live } = await spawnLive(session);
    const childSessionDir = join(
      dirname(parentRolloutStore.store.sessionDir),
      live.agentId,
    );

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
          silent: true,
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(session.mailbox.drain()).toHaveLength(0);
      expect(live.rolloutPath).toBeUndefined();
      expect(existsSync(childSessionDir)).toBe(false);
    } finally {
      parentRolloutStore.close();
      rmSync(childSessionDir, { recursive: true, force: true });
      rmSync(parentRolloutStore.store.sessionDir, {
        recursive: true,
        force: true,
      });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("marks errored when the provider rejects", async () => {
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream: vi.fn().mockRejectedValue(new Error("provider_boom")),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(live.status.value.status).toBe("errored");
    if (live.status.value.status === "errored") {
      expect(live.status.value.error).toContain("provider_boom");
    }
    expect(events.some((e) => e.kind === "run_error")).toBe(true);
  });

  it("classifies role timeout as run error", async () => {
    vi.useFakeTimers();
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let observedAbortReason: unknown;
    const chatStream = vi.fn<LLMProvider["chatStream"]>().mockImplementation(
      (_messages, _onChunk, options) =>
        new Promise<LLMResponse>((_resolve, reject) => {
          const signal = options?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              observedAbortReason = signal.reason;
              reject(new Error(String(signal.reason ?? "aborted")));
            },
            { once: true },
          );
          resolveStarted();
        }),
    );
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream,
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    const runPromise = collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        timeoutMs: 1,
      }),
    );

    await started;
    await vi.advanceTimersByTimeAsync(1);
    const { events, result } = await runPromise;

    expect(observedAbortReason).toBe("role_timeout");
    expect(result.outcome).toBe("errored");
    expect(live.status.value.status).toBe("errored");
    if (live.status.value.status === "errored") {
      expect(live.status.value.error).toContain("role_timeout");
    }
    expect(events.some((e) => e.kind === "run_error")).toBe(true);
    expect(events.some((e) => e.kind === "run_interrupted")).toBe(false);
  });

  it("marks interrupted on signal.abort", async () => {
    let chatReject: ((err: Error) => void) | undefined;
    const chatStream = vi.fn<LLMProvider["chatStream"]>().mockImplementation(
      (_messages, _onChunk, options) =>
        new Promise<LLMResponse>((_resolve, reject) => {
          chatReject = reject;
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream,
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    const iter = runAgent({
      live,
      parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
      initialMessages: [{ role: "user", content: "go" }],
      taskPrompt: "go",
    });

    // Pump events until the generator is awaiting the provider call.
    const collected: RunAgentProgressEvent[] = [];
    let result: RunAgentResult | undefined;
    const runPromise = (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const step = await iter.next();
        if (step.done) {
          result = step.value;
          return;
        }
        collected.push(step.value);
      }
    })();

    for (let attempt = 0; attempt < 20 && chatReject === undefined; attempt += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(chatReject).toBeDefined();
    live.abortController.abort("user_interrupt");
    await runPromise;

    expect(result?.outcome).toBe("interrupted");
    expect(live.status.value.status).toBe("interrupted");
    expect(collected.some((e) => e.kind === "run_interrupted")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// initMcpForAgent
// ─────────────────────────────────────────────────────────────────────

describe("initMcpForAgent", () => {
  it("returns ready:true when requiredMcpServers is empty", async () => {
    const session = makeStubSession();
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: [] },
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:true when no roleConfig is supplied (back-compat)", async () => {
    const session = makeStubSession();
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
    });
    expect(result.ready).toBe(true);
  });

  it("ignores array-shaped service bags while checking MCP readiness", async () => {
    vi.useFakeTimers();
    const mcpManager = {
      isConnected: vi.fn(() => false),
    };
    const session = makeStubSession();
    (session as unknown as { services: unknown }).services = Object.assign(
      ["spoof"],
      { mcpManager },
    );
    const ctrl = new AbortController();

    const promise = initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs"] },
    });
    await vi.advanceTimersByTimeAsync(MCP_INIT_TIMEOUT_MS + 100);
    const result = await promise;

    expect(result.ready).toBe(true);
    expect(mcpManager.isConnected).not.toHaveBeenCalled();
  });

  it("returns ready:false, reason:'aborted' when signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    const connected = new Map<string, boolean>([
      ["fs", false],
      ["net", false],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ services: { mcpManager } });
    const ctrl = new AbortController();

    const promise = initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });

    // Let the poll start.
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort("user_cancel");
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("aborted");
  });

  it("returns ready:true when all required servers are connected", async () => {
    const connected = new Map<string, boolean>([
      ["fs", true],
      ["net", true],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ services: { mcpManager } });
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:false, reason includes missing server when one never becomes ready", async () => {
    vi.useFakeTimers();
    const connected = new Map<string, boolean>([
      ["fs", true],
      ["net", false],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ services: { mcpManager } });
    const ctrl = new AbortController();

    const promise = initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });
    // Advance past the 30s default timeout.
    await vi.advanceTimersByTimeAsync(MCP_INIT_TIMEOUT_MS + 100);
    const result = await promise;
    expect(result.ready).toBe(false);
    // Either the generic timeout bucket or the specific missing-server
    // bucket is acceptable; the implementation prefers the latter.
    expect(
      result.reason === "timeout" || result.reason === "missing_server:net",
    ).toBe(true);
  });
});
