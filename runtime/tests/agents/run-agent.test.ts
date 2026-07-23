import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
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
  MAX_PARENT_RECEIPT_FIELD_BYTES,
  MCP_INIT_TIMEOUT_MS,
  mergeRoleDisallowlist,
  resolveThreadSpawnDisabledTools,
  runAgent,
  setParentNotificationOutboxLimitsForTesting,
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
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  disposeSandboxExecutionBroker,
  isSandboxExecutionBrokerDisposed,
} from "../sandbox/execution-lifecycle.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/tmp");
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../session/session.js";
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
import { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../session/execution-admission-journal.js";
import { AgenCDaemonRunInspectionService } from "../app-server/run-inspection.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
} from "../state/sqlite-driver.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  SESSION_ID_ARG,
  signAllowedRoots,
  verifyAllowedRoots,
  withSignedAllowedRoots,
} from "../tools/system/filesystem.js";
import { signSessionId } from "../agents/_deps/filesystem-args.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
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

function mkSessionConfiguration(overrides?: {
  readonly [K in keyof SessionConfiguration]?: SessionConfiguration[K];
}): SessionConfiguration {
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

function makeStubSession(
  opts: {
    services?: { readonly [K in keyof SessionServices]?: SessionServices[K] };
    sessionConfiguration?: SessionConfiguration;
    config?: Config;
    modelInfo?: ModelInfo;
    roleWorkspace?: SessionOpts["roleWorkspace"];
    agentDefinitions?: SessionOpts["agentDefinitions"];
    conversationId?: string;
  } = {},
): Session {
  const state = {
    sessionConfiguration:
      opts.sessionConfiguration ??
      mkSessionConfiguration({
        provider: {
          slug: "fake-provider",
        } as unknown as SessionConfiguration["provider"],
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

async function nextProgressEvent<Kind extends RunAgentProgressEvent["kind"]>(
  iter: AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void>,
  kind: Kind,
): Promise<Extract<RunAgentProgressEvent, { readonly kind: Kind }>> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      throw new Error(`agent run ended before emitting ${kind}`);
    }
    if (step.value.kind === kind) {
      return step.value as Extract<
        RunAgentProgressEvent,
        { readonly kind: Kind }
      >;
    }
  }
}

async function stopKeepAliveRun(
  iter: AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void>,
  signal: AbortController,
): Promise<RunAgentResult> {
  if (!signal.signal.aborted) signal.abort("test cleanup");
  return (await collectRun(iter)).result;
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeWorktreeEvidenceRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agenc-receipt-worktree-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "tests@example.com");
  git(repo, "config", "user.name", "Tests");
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  return repo;
}

beforeEach(() => {
  _resetAgentRolesForTesting();
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  setParentNotificationOutboxLimitsForTesting();
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
    const { control, live } = await spawnLive(session);

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
            childBroker =
              options.sandboxExecutionBroker as SandboxExecutionBroker;
            return childProvider;
          }),
        },
      },
    });
    const { control, live } = await spawnLive(session);
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
    const { control, live } = await spawnLive(session);
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
      const providerOptions = (provider.chatStream as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[2] as LLMChatOptions | undefined;
      expect(providerOptions?.tools?.map((tool) => tool.function.name)).toEqual(
        ["system.echo"],
      );
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
    const { control, live } = await spawnLive(session);
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

    expect(sent.map((msg) => msg.metadata?.kind)).toEqual(["subagent_status"]);
    const parentMessages = session.mailbox.drain();
    expect(parentMessages).toHaveLength(1);
    expect(parentMessages[0]).toMatchObject({
      author: live.agentPath,
      recipient: "/root",
      direction: "up",
      triggerTurn: true,
      metadata: { kind: "subagent_notification" },
    });
    expect(parentMessages[0]!.content).toContain(
      `"receipt":{"lifecycle":"turn","outcome":"completed"`,
    );
    expect(parentMessages[0]!.content).toContain('"message":"hello world"');

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
          parent: session as unknown as Parameters<
            typeof runAgent
          >[0]["parent"],
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
      expect(
        options.systemPrompt?.match(/CHILD_WORKSPACE_SENTINEL_92ac/g),
      ).toHaveLength(1);
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
        taskId: "cancelled-task",
      }),
    );

    expect(provider.chatStream).not.toHaveBeenCalled();
    expect(result.outcome).toBe("interrupted");
    expect(live.status.value.status).toBe("interrupted");
    expect(events.some((event) => event.kind === "run_interrupted")).toBe(true);
    expect(events.some((event) => event.kind === "run_complete")).toBe(false);
    const receipt = session.mailbox
      .drain()
      .find((message) => message.metadata?.lifecycle === "turn");
    expect(receipt?.metadata).toMatchObject({
      outcome: "interrupted",
      taskId: "cancelled-task",
    });
    expect(receipt?.content).toContain('"outcome":"interrupted"');
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
    const chatStreamCall = (provider.chatStream as ReturnType<typeof vi.fn>)
      .mock.calls[0] as
      [LLMMessage[], StreamProgressCallback, LLMChatOptions] | undefined;
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
    expect(
      params.toolUseContext.options.tools.map((tool) => tool.name),
    ).toEqual(providerOptions.tools?.map((tool) => tool.function.name));
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
    expect(params.forkContextMessages[0]).toEqual(
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
        taskId: "max-turns-task",
        maxTurns: 1,
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "subagent exceeded maxTurns (1)",
    );
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    const receipt = session.mailbox
      .drain()
      .find((message) => message.metadata?.lifecycle === "turn");
    expect(receipt?.metadata).toMatchObject({
      outcome: "errored",
      taskId: "max-turns-task",
    });
    expect(receipt?.content).toContain('"outcome":"errored"');
  });

  it("does not reuse a non-keep-alive worker for queued follow-up input", async () => {
    const provider = makeProvider([
      { content: "first turn" },
      { content: "second turn" },
    ]);
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

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("first turn");
  });

  it("publishes a completed result for each keep-alive turn before idling", async () => {
    const provider = makeProvider([{ content: "first result" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "go" }],
      taskPrompt: "go",
      keepAlive: true,
    });

    try {
      const completed = await nextProgressEvent(iter, "turn_complete");

      expect(completed.finalMessage).toBe("first result");
      const notifications = session.mailbox.drain();
      expect(notifications).toEqual([
        expect.objectContaining({
          author: live.agentPath,
          recipient: "/root",
          direction: "up",
          triggerTurn: true,
          content: expect.stringContaining(
            `"durable_outcome_ref":{"projection_id":"${live.agentId}:${completed.turnId}:completed","agent_id":"${live.agentId}","turn_id":"${completed.turnId}"}`,
          ),
          metadata: expect.objectContaining({
            kind: "subagent_notification",
            projectionId: `${live.agentId}:${completed.turnId}:completed`,
            lifecycle: "turn",
            turnId: completed.turnId,
            toolCallCount: 0,
          }),
        }),
      ]);
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
    }
  });

  it("fsyncs one correlated child outcome before projecting its one parent receipt", async () => {
    const provider = makeProvider([{ content: "durable result" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const order: string[] = [];
    const childOutcomes: unknown[] = [];
    let unsubscribeChild: (() => void) | undefined;
    const originalParentSend = session.mailbox.send.bind(session.mailbox);
    (
      session.mailbox as typeof session.mailbox & {
        send: typeof session.mailbox.send;
      }
    ).send = (message) => {
      if (message.metadata?.kind === "subagent_notification") {
        order.push("parent_receipt");
      }
      return originalParentSend(message);
    };

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "do durable work" }],
        taskPrompt: "do durable work",
        taskId: "durable-task",
        onCacheSafeParams: (captured) => {
          const child = (
            captured as unknown as {
              toolUseContext: { admissionSession: Session };
            }
          ).toolUseContext.admissionSession;
          unsubscribeChild ??= child.eventLog.subscribe((event) => {
            if (event.msg.type !== "subagent_turn_outcome") return;
            order.push("durable_outcome");
            childOutcomes.push(event.msg.payload);
          });
        },
      }),
    );
    unsubscribeChild?.();

    expect(result.outcome).toBe("completed");
    expect(order).toEqual(["durable_outcome", "parent_receipt"]);
    expect(childOutcomes).toEqual([
      expect.objectContaining({
        taskId: "durable-task",
        outcome: "completed",
        toolCallCount: 0,
      }),
    ]);
    expect(
      session.mailbox
        .drain()
        .filter((message) => message.metadata?.lifecycle === "turn"),
    ).toHaveLength(1);
  });

  it("bounds parent receipt reason metadata while retaining the durable full outcome", async () => {
    const hugeReason = `provider_boom:${"x".repeat(
      MAX_PARENT_RECEIPT_FIELD_BYTES * 4,
    )}`;
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream: vi.fn().mockRejectedValue(new Error(hugeReason)),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const durableReasons: string[] = [];

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "fail verbosely" }],
        taskPrompt: "fail verbosely",
        onCacheSafeParams: (captured) => {
          const child = (
            captured as unknown as {
              toolUseContext: { admissionSession: Session };
            }
          ).toolUseContext.admissionSession;
          child.eventLog.subscribe((event) => {
            if (event.msg.type !== "subagent_turn_outcome") return;
            if (event.msg.payload.reason !== undefined) {
              durableReasons.push(event.msg.payload.reason);
            }
          });
        },
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(durableReasons).toHaveLength(1);
    expect(durableReasons[0]).toContain(hugeReason);
    const receipt = session.mailbox
      .drain()
      .find((message) => message.metadata?.lifecycle === "turn");
    expect(receipt).toBeDefined();
    const projectedReason = String(receipt?.metadata?.reason ?? "");
    expect(Buffer.byteLength(projectedReason, "utf8")).toBeLessThanOrEqual(
      MAX_PARENT_RECEIPT_FIELD_BYTES,
    );
    expect(projectedReason).toContain("[parent projection truncated");
    expect(receipt?.content).toContain("[parent projection truncated");
  });

  it("retains an outbox head across thrown sends and eventually projects it once", async () => {
    const provider = makeProvider([{ content: "retry result" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const originalSend = session.mailbox.send.bind(session.mailbox);
    let receiptAttempts = 0;
    session.mailbox.send = (message) => {
      if (message.metadata?.kind === "subagent_notification") {
        receiptAttempts += 1;
        if (receiptAttempts <= 2) {
          throw new Error(`transient parent send ${receiptAttempts}`);
        }
      }
      return originalSend(message);
    };

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "retry projection" }],
        taskPrompt: "retry projection",
      }),
    );

    expect(result.outcome).toBe("completed");
    await vi.waitFor(() => expect(receiptAttempts).toBeGreaterThanOrEqual(3), {
      timeout: 1_000,
    });
    const receipts = session.mailbox
      .drain()
      .filter((message) => message.metadata?.lifecycle === "turn");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.metadata?.projectionId).toBe(
      `${live.agentId}:${String(receipts[0]?.metadata?.turnId)}:completed`,
    );
  });

  it("turns outbox saturation into explicit worker backpressure after the durable outcome", async () => {
    setParentNotificationOutboxLimitsForTesting({ depth: 0, bytes: 0 });
    const provider = makeProvider([{ content: "durable but unprojected" }]);
    const session = makeStubSession({ services: { provider } });
    const warningCauses: string[] = [];
    session.eventLog.subscribe((event) => {
      if (event.msg.type === "warning") {
        warningCauses.push(event.msg.payload.cause);
      }
    });
    const originalSend = session.mailbox.send.bind(session.mailbox);
    session.mailbox.send = (message) =>
      message.metadata?.kind === "subagent_notification"
        ? -1
        : originalSend(message);
    const { live } = await spawnLive(session);
    const durableOutcomes: unknown[] = [];

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "complete durably" }],
        taskPrompt: "complete durably",
        onCacheSafeParams: (captured) => {
          const child = (
            captured as unknown as {
              toolUseContext: { admissionSession: Session };
            }
          ).toolUseContext.admissionSession;
          child.eventLog.subscribe((event) => {
            if (event.msg.type === "subagent_turn_outcome") {
              durableOutcomes.push(event.msg.payload);
            }
          });
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    expect(durableOutcomes).toEqual([
      expect.objectContaining({
        outcome: "completed",
        message: "durable but unprojected",
      }),
    ]);
    expect(
      session.mailbox
        .drain()
        .filter((message) => message.metadata?.lifecycle === "turn"),
    ).toHaveLength(0);
    expect(warningCauses).toContain("subagent_notification_outbox_full");
    expect(live.status.value.status).toBe("errored");
    if (live.status.value.status === "errored") {
      expect(live.status.value.error).toContain("parent projection failed");
    }
  });

  it("retries a transient parent follow-up submit while its receipt remains queued", async () => {
    vi.useFakeTimers();
    const provider = makeProvider([{ content: "follow-up result" }]);
    const session = makeStubSession({ services: { provider } });
    let submitAttempt = 0;
    const submit = vi.fn(async () => {
      submitAttempt += 1;
      if (submitAttempt === 1) {
        throw new Error("transient submit failure");
      }
      session.drainPendingInputMessages();
    });
    session.installTurnDriverHooks({ submit });
    const { live } = await spawnLive(session);

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "schedule follow-up" }],
        taskPrompt: "schedule follow-up",
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(session.mailbox.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(session.mailbox.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(session.mailbox.hasPending()).toBe(false);
  });

  it("durably NACKs an accepted assignment that teardown prevents from starting", async () => {
    const provider = makeProvider([{ content: "initial result" }]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    const childOutcomes: unknown[] = [];
    let unsubscribeChild: (() => void) | undefined;
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
      onCacheSafeParams: (captured) => {
        const child = (
          captured as unknown as {
            toolUseContext: { admissionSession: Session };
          }
        ).toolUseContext.admissionSession;
        unsubscribeChild ??= child.eventLog.subscribe((event) => {
          if (event.msg.type === "subagent_turn_outcome") {
            childOutcomes.push(event.msg.payload);
          }
        });
      },
    });

    await nextProgressEvent(iter, "turn_complete");
    session.mailbox.drain();
    const parked = iter.next();
    await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
    const accepted = control.assignTask(live.agentId, {
      author: "/root",
      recipient: live.agentPath,
      content: "never start this",
      taskId: "nack-task",
    });
    live.abortController.abort("teardown");
    await parked;
    await collectRun(iter);
    unsubscribeChild?.();

    const notifications = session.mailbox
      .drain()
      .filter((message) => message.metadata?.lifecycle === "turn");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.metadata).toMatchObject({
      outcome: "nack",
      taskId: "nack-task",
      turnId: accepted.turnId,
      reason: "worker_teardown_before_start",
    });
    expect(notifications[0]?.content).toContain('"outcome":"nack"');
    expect(childOutcomes).toContainEqual(
      expect.objectContaining({
        taskId: "nack-task",
        turnId: accepted.turnId,
        outcome: "nack",
        reason: "worker_teardown_before_start",
      }),
    );
  });

  it("fails the worker closed and releases admission when receipt durability fails", async () => {
    const provider = makeProvider([
      { content: "initial result" },
      { content: "unprojectable result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    let childSession: Session | undefined;
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
      onCacheSafeParams: (captured) => {
        childSession = (
          captured as unknown as {
            toolUseContext: { admissionSession: Session };
          }
        ).toolUseContext.admissionSession;
      },
    });

    await nextProgressEvent(iter, "turn_complete");
    session.mailbox.drain();
    const parked = iter.next();
    await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
    expect(childSession).toBeDefined();
    const originalEmit = childSession!.emit.bind(childSession);
    const emitSpy = vi
      .spyOn(childSession!, "emit")
      .mockImplementation((event, opts) => {
        if (event.msg.type === "subagent_turn_outcome") {
          throw new Error("fsync failed");
        }
        return originalEmit(event, opts);
      });
    control.assignTask(live.agentId, {
      author: "/root",
      recipient: live.agentPath,
      content: "second task",
      taskId: "durability-failure-task",
    });
    await parked;
    const errorEvent = await nextProgressEvent(iter, "run_error");
    const result = (await collectRun(iter)).result;
    emitSpy.mockRestore();

    expect(errorEvent).toMatchObject({
      taskId: "durability-failure-task",
      error: expect.stringContaining("task receipt durability failed"),
    });
    expect(result.outcome).toBe("errored");
    expect(live.status.value.status).toBe("errored");
    expect(live.assignment).toBeUndefined();
    expect(
      session.mailbox
        .drain()
        .filter(
          (message) => message.metadata?.taskId === "durability-failure-task",
        ),
    ).toEqual([]);
  });

  it("rolls clean worktree baselines without mutating the first immutable receipt", async () => {
    const repo = makeWorktreeEvidenceRepo();
    try {
      const baseCommit = git(repo, "rev-parse", "HEAD");
      const baseProvider = makeProvider([
        { content: "first committed result" },
        { content: "second committed result" },
      ]);
      let commitIndex = 0;
      const provider: LLMProvider = {
        ...baseProvider,
        chatStream: vi.fn(async (...args) => {
          commitIndex += 1;
          const filename = `result-${commitIndex}.txt`;
          writeFileSync(
            join(repo, filename),
            `result ${commitIndex}\n`,
            "utf8",
          );
          git(repo, "add", filename);
          git(repo, "commit", "-m", `task result ${commitIndex}`);
          return baseProvider.chatStream(...args);
        }),
      };
      const session = makeStubSession({
        sessionConfiguration: mkSessionConfiguration({ cwd: repo }),
        services: {
          provider,
          sandboxExecutionBroker: explicitDangerBroker.forkForCwd(repo),
        },
      });
      const { control, live } = await spawnLive(session);
      const iter = runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "commit first result" }],
        taskPrompt: "commit first result",
        taskId: "commit-task-1",
        keepAlive: true,
        worktree: {
          path: repo,
          branch: "main",
          gitRoot: repo,
          created: false,
        },
        worktreeBaseCommit: baseCommit,
      });

      const firstTurn = await nextProgressEvent(iter, "turn_complete");
      const firstHead = git(repo, "rev-parse", "HEAD");
      const firstReceipt = session.mailbox
        .drain()
        .find((message) => message.metadata?.lifecycle === "turn");
      const firstReceiptContent = firstReceipt?.content ?? "";
      expect(firstTurn.worktreeEvidence).toMatchObject({
        state: "committed_clean",
        baseCommit,
        headCommit: firstHead,
        integrationRef: firstHead,
      });
      expect(firstReceiptContent).toContain(`"integration_ref":"${firstHead}"`);

      const secondPromise = nextProgressEvent(iter, "turn_complete");
      await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "commit second result",
        taskId: "commit-task-2",
      });
      const secondTurn = await secondPromise;
      const secondHead = git(repo, "rev-parse", "HEAD");
      const secondReceipt = session.mailbox
        .drain()
        .find((message) => message.metadata?.lifecycle === "turn");

      expect(secondHead).not.toBe(firstHead);
      expect(secondTurn.worktreeEvidence).toMatchObject({
        state: "committed_clean",
        baseCommit: firstHead,
        headCommit: secondHead,
        integrationRef: secondHead,
      });
      expect(secondReceipt?.content).toContain(
        `"integration_ref":"${secondHead}"`,
      );
      expect(firstReceiptContent).toContain(firstHead);
      expect(firstReceiptContent).not.toContain(secondHead);
      await stopKeepAliveRun(iter, live.abortController);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed after dirty worktree evidence and rejects worker reuse", async () => {
    const repo = makeWorktreeEvidenceRepo();
    try {
      const baseCommit = git(repo, "rev-parse", "HEAD");
      const baseProvider = makeProvider([{ content: "dirty result" }]);
      const provider: LLMProvider = {
        ...baseProvider,
        chatStream: vi.fn(async (...args) => {
          writeFileSync(join(repo, "uncommitted.txt"), "dirty\n", "utf8");
          return baseProvider.chatStream(...args);
        }),
      };
      const session = makeStubSession({
        sessionConfiguration: mkSessionConfiguration({ cwd: repo }),
        services: {
          provider,
          sandboxExecutionBroker: explicitDangerBroker.forkForCwd(repo),
        },
      });
      const { control, live } = await spawnLive(session);

      const { events, result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "write result" }],
          taskPrompt: "write result",
          taskId: "dirty-task",
          keepAlive: true,
          worktree: {
            path: repo,
            branch: "main",
            gitRoot: repo,
            created: false,
          },
          worktreeBaseCommit: baseCommit,
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(live.status.value.status).toBe("completed");
      const completed = events.find((event) => event.kind === "turn_complete");
      expect(completed?.worktreeEvidence).toMatchObject({
        state: "dirty_uncommitted",
        baseCommit,
      });
      const receipt = session.mailbox
        .drain()
        .find((message) => message.metadata?.lifecycle === "turn");
      expect(receipt?.metadata?.worktreeEvidence).toMatchObject({
        state: "dirty_uncommitted",
      });
      expect(receipt?.content).not.toContain("integration_ref");
      expect(() =>
        control.assignTask(live.agentId, {
          author: "/root",
          recipient: live.agentPath,
          content: "unsafe reuse",
          taskId: "unsafe-task",
        }),
      ).toThrow("not an idle reusable worker");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("applies a parent permission downgrade to a keep-alive child's next turn", async () => {
    const provider = makeProvider([
      { content: "first result" },
      { content: "second result" },
    ]);
    const permissionModeRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const session = makeStubSession({
      services: { provider, permissionModeRegistry },
    });
    const { control, live } = await spawnLive(session);
    let childSession: Session | undefined;
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
      onCacheSafeParams: (params) => {
        childSession = (
          params as unknown as {
            toolUseContext: { admissionSession: Session };
          }
        ).toolUseContext.admissionSession;
      },
    });

    try {
      await nextProgressEvent(iter, "turn_complete");
      expect(childSession).toBeDefined();
      expect(childSession!.permissionModeRegistry.current().mode).toBe(
        "bypassPermissions",
      );

      await permissionModeRegistry.update(
        createEmptyToolPermissionContext({ mode: "default" }),
      );
      const secondTurn = nextProgressEvent(iter, "turn_complete");
      await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "continue under downgraded permissions",
        taskId: "permission-downgrade-task",
      });

      await secondTurn;
      expect(childSession!.permissionModeRegistry.current().mode).toBe(
        "default",
      );
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
    }
  });

  it("wakes a keep-alive worker with exactly the assigned input and a fresh turn id", async () => {
    const provider = makeProvider([
      { content: "first result" },
      { content: "second result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
    });

    try {
      const first = await nextProgressEvent(iter, "turn_complete");
      session.mailbox.drain();
      const secondPromise = nextProgressEvent(iter, "turn_complete");
      await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));

      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "second task",
        taskId: "task-2",
      });

      const second = await secondPromise;
      expect(second.turnId).not.toBe(first.turnId);
      expect(second.taskId).toBe("task-2");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
      const secondMessages = (provider.chatStream as ReturnType<typeof vi.fn>)
        .mock.calls[1]![0] as LLMMessage[];
      expect(secondMessages.at(-1)).toEqual({
        role: "user",
        content: "second task",
      });
      const notifications = session.mailbox.drain();
      expect(notifications).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            kind: "subagent_notification",
            lifecycle: "turn",
            taskId: "task-2",
            turnId: second.turnId,
          }),
        }),
      ]);
      expect(notifications[0]?.content).toContain('"task_id":"task-2"');
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
    }
  });

  it("queues passive context without starting a turn and folds it into the next assignment", async () => {
    const provider = makeProvider([
      { content: "first result" },
      { content: "context-aware result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
    });

    try {
      await nextProgressEvent(iter, "turn_complete");
      const nextTurn = nextProgressEvent(iter, "turn_complete");
      await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
      live.downInbox.send({
        author: "/root",
        recipient: live.agentPath,
        content: "context note",
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "inter_agent_communication" },
      });
      expect(live.downInbox.size).toBe(1);
      expect(provider.chatStream).toHaveBeenCalledTimes(1);

      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "do the next task",
        taskId: "queued-task",
      });

      const completed = await nextTurn;
      expect(completed.taskId).toBe("queued-task");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
      const secondMessages = (provider.chatStream as ReturnType<typeof vi.fn>)
        .mock.calls[1]![0] as LLMMessage[];
      expect(secondMessages.at(-1)).toEqual({
        role: "user",
        content: "context note\n\ndo the next task",
      });
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
    }
  });

  it("rejects a second assignment until the accepted task reaches a receipt", async () => {
    const provider = makeProvider([
      { content: "initial result" },
      { content: "first queued result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
    });

    try {
      await nextProgressEvent(iter, "turn_complete");
      session.mailbox.drain();
      const firstQueuedPromise = nextProgressEvent(iter, "turn_complete");
      await vi.waitFor(() => expect(live.status.value.status).toBe("idle"));
      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "first queued task",
        taskId: "queued-1",
      });
      expect(() =>
        control.assignTask(live.agentId, {
          author: "/root",
          recipient: live.agentPath,
          content: "second queued task",
          taskId: "queued-2",
        }),
      ).toThrow("outstanding assignment");

      const firstQueued = await firstQueuedPromise;
      const firstReceipt = session.mailbox.drain();

      expect(firstQueued).toMatchObject({
        taskId: "queued-1",
        finalMessage: "first queued result",
      });
      expect(firstReceipt[0]?.metadata).toMatchObject({
        lifecycle: "turn",
        taskId: "queued-1",
        turnId: firstQueued.turnId,
      });
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
      const calls = (provider.chatStream as ReturnType<typeof vi.fn>).mock
        .calls;
      expect((calls[1]![0] as LLMMessage[]).at(-1)).toEqual({
        role: "user",
        content: "first queued task",
      });
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
    }
  });

  it("starts a fresh timeout budget after a keep-alive worker has idled", async () => {
    vi.useFakeTimers();
    const provider = makeProvider([
      { content: "first result" },
      { content: "late assignment result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
      timeoutMs: 1_000,
    });

    try {
      await nextProgressEvent(iter, "turn_complete");
      const nextTurn = nextProgressEvent(iter, "turn_complete");
      expect(live.status.value.status).toBe("idle");
      await vi.advanceTimersByTimeAsync(10_000);
      control.assignTask(live.agentId, {
        author: "/root",
        recipient: live.agentPath,
        content: "late assignment",
        taskId: "late-task",
      });

      const completed = await nextTurn;
      expect(completed.finalMessage).toBe("late assignment result");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
    } finally {
      await stopKeepAliveRun(iter, live.abortController);
      vi.useRealTimers();
    }
  });

  it("does not lose an assignment admitted synchronously on the idle transition", async () => {
    const provider = makeProvider([
      { content: "first result" },
      { content: "gap result" },
    ]);
    const session = makeStubSession({ services: { provider } });
    const { control, live } = await spawnLive(session);
    let assigned = false;
    const unsubscribe = live.status.subscribe((status) => {
      if (status.status === "idle" && !assigned) {
        assigned = true;
        control.assignTask(live.agentId, {
          author: "/root",
          recipient: live.agentPath,
          content: "assignment in the drain/wait gap",
          taskId: "idle-transition-task",
        });
      }
    });

    const iter = runAgent({
      live,
      parent: session,
      initialMessages: [{ role: "user", content: "initial task" }],
      taskPrompt: "initial task",
      keepAlive: true,
    });
    let nextTurn:
      | Promise<
          Extract<RunAgentProgressEvent, { readonly kind: "turn_complete" }>
        >
      | undefined;

    try {
      await nextProgressEvent(iter, "turn_complete");
      nextTurn = nextProgressEvent(iter, "turn_complete");
      expect((await nextTurn).finalMessage).toBe("gap result");
      expect(provider.chatStream).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      if (!live.abortController.signal.aborted) {
        live.abortController.abort("test cleanup");
      }
      await nextTurn?.catch(() => undefined);
      await collectRun(iter);
    }
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
      runId: "child-direct",
      sessionId: "child-direct",
    });
    const childSession = makeStubSession({
      conversationId: "child-direct",
      services: {
        executionAdmission: admission.client,
        admissionRequired: true,
      },
    });
    const childCwd = childSession.sessionConfiguration.cwd;
    const childRolloutStore = new RolloutStore({
      cwd: childCwd,
      sessionId: childSession.conversationId,
      agencVersion: "0.2.0",
    });
    childRolloutStore.open({
      sessionId: childSession.conversationId,
      timestamp: new Date().toISOString(),
      cwd: childCwd,
      originator: "run-agent-direct-child-test",
      agencVersion: "0.2.0",
      model: childSession.modelInfo.slug,
      modelProvider: childSession.services.provider.name,
    });
    childSession.mountRolloutStore(childRolloutStore);
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

    try {
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
      const effectEvents = childRolloutStore
        .readAll()
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload)
        .filter(
          (event) =>
            event.msg.type === "effect_intent" ||
            event.msg.type === "effect_result",
        );
      expect(effectEvents.map((event) => event.msg.type)).toEqual([
        "effect_intent",
        "effect_result",
      ]);
      expect(
        effectEvents.map((event) =>
          event.msg.type === "effect_intent" ||
          event.msg.type === "effect_result"
            ? event.msg.payload.runId
            : null,
        ),
      ).toEqual(["child-direct", "child-direct"]);
    } finally {
      await childSession.shutdown();
    }
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
    const mutating = [
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "apply_patch",
      "spawn_agent",
    ];
    const tools = [...mutating.map(mkTool), mkTool("Read")];
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () =>
          tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.name,
              parameters: { type: "object" },
            },
          })),
        dispatch: async () => ({ content: "{}", isError: false }),
      },
      {
        childConversationId: "child-deny",
        unadmittedDispatchOverride:
          TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
        // Mirrors run-agent's call site: the read-only role denylist folded in.
        disabledTools: mergeRoleDisallowlist(
          new Set<string>(),
          BUILTIN_READONLY_DISALLOWLIST,
        ),
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
    const session = makeStubSession({
      services: { provider, registry: parentRegistry },
    });
    const { live } = await spawnLive(session, "Plan");
    expect(live.role.name).toBe("Plan");
    // The resolved role carries the read-only denylist (covers every mutating tool).
    expect(live.role.config.disallowlist).toEqual(
      BUILTIN_READONLY_DISALLOWLIST,
    );

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
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "apply_patch",
              description: applyPatchTool.description,
              parameters: applyPatchTool.inputSchema,
            },
          },
        ],
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
      registry.dispatch({
        id: "call-task-list",
        name: "TaskList",
        arguments: "{}",
      }),
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
        registry.dispatch({
          id: `call-${toolName}`,
          name: toolName,
          arguments: "{}",
        }),
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
      registry.dispatch({
        id: "call-task-list",
        name: "TaskList",
        arguments: "{}",
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: TaskList",
      }),
    });
  });

  it("does not re-advertise tools hidden by the parent registry", async () => {
    const tools = ["system.echo", "NotebookEdit", "TaskCreate"].map(
      mkNamedTool,
    );
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
      registry.dispatch({
        id: "call-notebook",
        name: "NotebookEdit",
        arguments: "{}",
      }),
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
      registry.dispatch({
        id: "call-grep-before",
        name: "Grep",
        arguments: "{}",
      }),
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

  it("mounts one child rollout and refuses the same identity after terminal", async () => {
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
      expect(
        rolloutFiles.some((entry) =>
          readFileSync(join(childSessionDir, entry), "utf8").includes(
            '"type":"run_terminal"',
          ),
        ),
      ).toBe(true);
      const terminalRows = rolloutFiles.flatMap((entry) =>
        readFileSync(join(childSessionDir, entry), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; payload?: Event })
          .filter(
            (item) =>
              item.type === "event_msg" &&
              item.payload?.msg.type === "run_terminal",
          ),
      );
      expect(terminalRows).toHaveLength(1);
      expect(terminalRows[0]?.payload).toMatchObject({
        msg: {
          payload: { runId: live.agentId, epoch: 1, status: "completed" },
        },
      });
      const diagnosticState = openStateDatabases({ cwd });
      try {
        expect(
          diagnosticState
            .prepareState<[string], { readonly epoch: number }>(
              "SELECT epoch FROM run_lifecycle_epochs WHERE run_id = ?",
            )
            .all(live.agentId),
        ).toEqual([{ epoch: 1 }]);
        expect(
          diagnosticState
            .prepareState<
              [string],
              { readonly source_path: string; readonly active: number }
            >(
              "SELECT source_path, active FROM run_journal_bindings WHERE run_id = ?",
            )
            .all(live.agentId),
        ).toEqual([
          expect.objectContaining({
            source_path: expect.stringContaining(live.agentId),
            active: 1,
          }),
        ]);
      } finally {
        diagnosticState.close();
      }

      const duplicate = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "run again" }],
          taskPrompt: "run again",
        }),
      );
      expect(
        readdirSync(childSessionDir).filter(
          (entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"),
        ),
      ).toEqual(rolloutFiles);
      expect(duplicate.result).toMatchObject({
        threadId: live.agentId,
        outcome: "errored",
        error: {
          name: "TerminalRunEpochOpenError",
          message: expect.stringContaining(
            `refusing to open terminal run ${live.agentId} epoch 1`,
          ),
        },
      });
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

  it("records a failed child terminal when setup stops before Session construction", async () => {
    const previousAgencHome = process.env.AGENC_HOME;
    const home = mkdtempSync(
      join(tmpdir(), "agenc-child-preconstruction-home-"),
    );
    const cwd = mkdtempSync(
      join(tmpdir(), "agenc-child-preconstruction-workspace-"),
    );
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;
    const invalidProvider = {
      name: "missing-chat-provider",
    } as unknown as LLMProvider;
    const session = makeStubSession({
      conversationId: "root-preconstruction-failure",
      services: { provider: invalidProvider },
      sessionConfiguration: mkSessionConfiguration({ cwd }),
      config: { ...mkConfig(), cwd },
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
      originator: "run-agent-preconstruction-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: invalidProvider.name,
    });
    session.mountRolloutStore(parentRolloutStore);

    try {
      const { live } = await spawnLive(session);
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );
      expect(result).toMatchObject({
        threadId: live.agentId,
        outcome: "errored",
      });
      expect(live.rolloutPath).toBeDefined();

      const inspection = new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () => [
          resolveStateDatabasePaths({ cwd, agencHome: home }),
        ],
      });
      expect(inspection.status({ runId: live.agentId })).toMatchObject({
        runId: live.agentId,
        status: "failed",
        terminal: true,
      });
      expect(inspection.result({ runId: live.agentId })).toMatchObject({
        runId: live.agentId,
        status: "failed",
        terminal: true,
        output: {
          available: true,
          stopReason: "subagent has no provider on parent.services.provider",
          finalMessage: null,
        },
      });
    } finally {
      await session.shutdown();
      if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousAgencHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a completed child result when post-terminal provider disposal fails", async () => {
    const previousAgencHome = process.env.AGENC_HOME;
    const home = mkdtempSync(join(tmpdir(), "agenc-child-disposal-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-child-disposal-workspace-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_HOME = home;
    const parentBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd,
    });
    const childProvider: LLMProvider = {
      ...makeProvider([{ content: "completed before disposal" }]),
      dispose: vi.fn(async () => {
        throw new Error("forced child provider disposal failure");
      }),
    };
    const parentProvider: LLMProvider = {
      ...makeProvider([]),
      forkForSession: vi.fn(() => childProvider),
    };
    const session = makeStubSession({
      conversationId: "root-post-terminal-disposal",
      services: {
        provider: parentProvider,
        sandboxExecutionBroker: parentBroker,
      },
      sessionConfiguration: mkSessionConfiguration({ cwd }),
      config: { ...mkConfig(), cwd },
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
      originator: "run-agent-disposal-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: parentProvider.name,
    });
    session.mountRolloutStore(parentRolloutStore);
    const parentEvents: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => {
      parentEvents.push(event);
    });

    try {
      const { live } = await spawnLive(session);
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );
      expect(result).toMatchObject({
        threadId: live.agentId,
        outcome: "completed",
        finalMessage: "completed before disposal",
      });
      expect(childProvider.dispose).toHaveBeenCalledOnce();
      expect(parentEvents).toContainEqual(
        expect.objectContaining({
          msg: {
            type: "warning",
            payload: {
              cause: "subagent_resource_cleanup_failed",
              message: "forced child provider disposal failure",
            },
          },
        }),
      );

      const inspection = new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () => [
          resolveStateDatabasePaths({ cwd, agencHome: home }),
        ],
      });
      expect(inspection.result({ runId: live.agentId })).toMatchObject({
        runId: live.agentId,
        status: "completed",
        terminal: true,
        output: {
          available: true,
          stopReason: "turn_completed",
          finalMessage: "completed before disposal",
        },
      });
    } finally {
      unsubscribe();
      await session.shutdown();
      await disposeSandboxExecutionBroker(parentBroker);
      if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousAgencHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps root spawn evidence and child model evidence in their canonical run journals", async () => {
    const previousConfigDir = process.env.AGENC_CONFIG_DIR;
    const previousAgencHome = process.env.AGENC_HOME;
    const home = mkdtempSync(join(tmpdir(), "agenc-child-journal-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-child-journal-workspace-"));
    mkdirSync(join(cwd, ".git"));
    process.env.AGENC_CONFIG_DIR = home;
    process.env.AGENC_HOME = home;
    const kernel = new ExecutionAdmissionKernel({
      agencHome: home,
      ownerId: "run-agent-child-journal-test",
      ownerPid: process.pid,
      limits: {
        global: 4,
        workspace: 4,
        session: 4,
        parent: 4,
        provider: 4,
      },
    });
    const rootAdmission = kernel.bindClient({
      cwd,
      scope: {
        runId: "root-journal-run",
        sessionId: "root-journal-run",
        autonomous: false,
      },
    });
    const provider: LLMProvider = {
      ...makeProvider([
        {
          content: "child admitted model complete",
          usage: {
            promptTokens: 8,
            completionTokens: 4,
            totalTokens: 12,
            availability: "reported",
            provenance: "provider",
          },
        },
      ]),
      getExecutionProfile: async () => ({
        provider: "fake",
        model: "fake-model",
        usageReporting: "authoritative",
        supportsMaxOutputTokens: true,
      }),
    };
    const session = makeStubSession({
      conversationId: "root-journal-run",
      services: {
        provider,
        executionAdmission: rootAdmission,
        admissionRequired: true,
      },
      sessionConfiguration: mkSessionConfiguration({
        cwd,
        provider: {
          slug: "fake",
        } as unknown as SessionConfiguration["provider"],
      }),
      config: { ...mkConfig(), cwd },
      modelInfo: { ...mkModelInfo(), maxOutputTokens: 32 },
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
      originator: "run-agent-root-journal-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: provider.name,
    });
    session.mountRolloutStore(parentRolloutStore);
    session.onBeforeDurableClose(
      bindExecutionAdmissionJournal(session, rootAdmission),
    );
    let childRolloutPath: string | undefined;

    try {
      const { live } = await spawnLive(session);
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );
      expect(result.outcome).toBe("completed");
      childRolloutPath = live.rolloutPath;
      expect(childRolloutPath).toBeDefined();

      const rootAdmissionEvents = parentRolloutStore
        .readAll()
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload)
        .filter((event) => event.msg.type === "execution_admission")
        .map((event) =>
          event.msg.type === "execution_admission" ? event.msg.payload : null,
        )
        .filter((event) => event !== null);
      const childAdmissionEvents = readFileSync(childRolloutPath!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload?: Event })
        .filter((item) => item.type === "event_msg")
        .map((item) => item.payload!)
        .filter((event) => event.msg.type === "execution_admission")
        .map((event) =>
          event.msg.type === "execution_admission" ? event.msg.payload : null,
        )
        .filter((event) => event !== null);

      expect(rootAdmissionEvents.length).toBeGreaterThan(0);
      expect(
        rootAdmissionEvents.every(
          (event) => event.runId === "root-journal-run",
        ),
      ).toBe(true);
      expect(rootAdmissionEvents.some((event) => event.kind === "spawn")).toBe(
        true,
      );
      expect(childAdmissionEvents.length).toBeGreaterThan(0);
      expect(
        childAdmissionEvents.every((event) => event.runId === live.agentId),
      ).toBe(true);
      expect(
        childAdmissionEvents.some((event) => event.kind === "model_turn"),
      ).toBe(true);
      expect(
        rootAdmissionEvents.some((event) => event.runId === live.agentId),
      ).toBe(false);
      expect(
        childAdmissionEvents.some(
          (event) => event.runId === "root-journal-run",
        ),
      ).toBe(false);

      const diagnosticState = openStateDatabases({ cwd, agencHome: home });
      const childBindings = diagnosticState
        .prepareState<
          [string],
          { readonly run_id: string; readonly source_path: string }
        >(
          "SELECT run_id, source_path FROM run_journal_bindings WHERE run_id = ?",
        )
        .all(live.agentId);
      diagnosticState.close();
      expect(childBindings).toEqual([
        { run_id: live.agentId, source_path: childRolloutPath },
      ]);

      const inspection = new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () => [
          resolveStateDatabasePaths({ cwd, agencHome: home }),
        ],
      });
      expect(inspection.status({ runId: live.agentId })).toMatchObject({
        runId: live.agentId,
        status: "completed",
        terminal: true,
      });
      expect(inspection.result({ runId: live.agentId })).toMatchObject({
        runId: live.agentId,
        status: "completed",
        terminal: true,
        output: {
          available: true,
          exitCode: 0,
          stopReason: "turn_completed",
          finalMessage: "child admitted model complete",
        },
      });
      const replay = inspection.replay({ runId: live.agentId, limit: 200 });
      expect(replay.source).toMatchObject({
        available: true,
        kind: "run_journal",
      });
      expect(replay.events.length).toBeGreaterThan(0);
      expect(replay.events.every((event) => event.runId === live.agentId)).toBe(
        true,
      );
      expect(
        replay.events.some(
          (event) =>
            event.category === "admission" &&
            event.kind === "execution_admission" &&
            event.stepId !== undefined,
        ),
      ).toBe(true);
      expect(replay.events.at(-1)).toMatchObject({
        runId: live.agentId,
        category: "terminal",
        kind: "run_terminal",
      });
    } finally {
      await session.shutdown();
      kernel.close();
      if (previousConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
      else process.env.AGENC_CONFIG_DIR = previousConfigDir;
      if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previousAgencHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["failed", "failed"],
    ["interrupted", "cancelled"],
  ] as const)(
    "makes a %s child run durably terminal and replayable by child id",
    async (scenario, terminalStatus) => {
      const previousAgencHome = process.env.AGENC_HOME;
      const home = mkdtempSync(join(tmpdir(), `agenc-child-${scenario}-home-`));
      const cwd = mkdtempSync(
        join(tmpdir(), `agenc-child-${scenario}-workspace-`),
      );
      mkdirSync(join(cwd, ".git"));
      process.env.AGENC_HOME = home;
      const provider: LLMProvider =
        scenario === "failed"
          ? {
              ...makeProvider([]),
              chatStream: vi.fn().mockRejectedValue(new Error("provider_boom")),
            }
          : makeProvider([{ content: "should not run" }]);
      const session = makeStubSession({
        conversationId: `root-${scenario}-child-terminal`,
        services: {
          provider,
          ...(scenario === "interrupted"
            ? {
                guardianRejectionCircuitBreaker: {
                  clearTurn: vi.fn(),
                  isOpen: vi.fn(() => true),
                } as never,
              }
            : {}),
        },
        sessionConfiguration: mkSessionConfiguration({
          cwd,
          provider: {
            slug: "fake",
          } as unknown as SessionConfiguration["provider"],
        }),
        config: { ...mkConfig(), cwd },
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
        originator: `run-agent-${scenario}-terminal-test`,
        agencVersion: "0.2.0",
        model: session.modelInfo.slug,
        modelProvider: provider.name,
      });
      session.mountRolloutStore(parentRolloutStore);

      try {
        const { live } = await spawnLive(session);
        const { result } = await collectRun(
          runAgent({
            live,
            parent: session,
            initialMessages: [{ role: "user", content: "go" }],
            taskPrompt: "go",
          }),
        );
        expect(result.outcome).toBe(
          scenario === "failed" ? "errored" : "interrupted",
        );

        const inspection = new AgenCDaemonRunInspectionService({
          stateDatabasePaths: () => [
            resolveStateDatabasePaths({ cwd, agencHome: home }),
          ],
        });
        expect(inspection.status({ runId: live.agentId })).toMatchObject({
          runId: live.agentId,
          status: terminalStatus,
          terminal: true,
        });
        expect(inspection.result({ runId: live.agentId })).toMatchObject({
          runId: live.agentId,
          status: terminalStatus,
          terminal: true,
          output: { available: true },
        });
        const replay = inspection.replay({ runId: live.agentId, limit: 200 });
        expect(replay.events.at(-1)).toMatchObject({
          runId: live.agentId,
          category: "terminal",
          kind: "run_terminal",
        });
      } finally {
        await session.shutdown();
        if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
        else process.env.AGENC_HOME = previousAgencHome;
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("suppresses parent mailbox notifications but preserves the child rollout in silent mode", async () => {
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
      expect(live.rolloutPath).toBeDefined();
      expect(existsSync(childSessionDir)).toBe(true);
      expect(existsSync(live.rolloutPath!)).toBe(true);
      expect(readFileSync(live.rolloutPath!, "utf8")).toContain(
        '"type":"event_msg"',
      );
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

    for (
      let attempt = 0;
      attempt < 20 && chatReject === undefined;
      attempt += 1
    ) {
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
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: [] },
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:true when no roleConfig is supplied (back-compat)", async () => {
    const session = makeStubSession();
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
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
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
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
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
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
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
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
      parent: session as unknown as Parameters<
        typeof initMcpForAgent
      >[0]["parent"],
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
