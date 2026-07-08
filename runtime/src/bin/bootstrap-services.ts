import { randomUUID } from "node:crypto";

import type { LLMProvider } from "../llm/types.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import { createPermissionAuditFileLogger } from "../permissions/permission-audit-log.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import { NetworkApprovalService as RuntimeNetworkApprovalService } from "../permissions/network-approval.js";
import {
  requestManagedNetworkApprovalForSandbox,
  type ManagedNetworkApprovalOptions,
} from "../sandbox/escalation/network-approval.js";
import { Policy } from "../sandbox/execpolicy/policy.js";
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { createGuardianRejectionCircuitBreaker } from "../permissions/guardian/rejection-circuit-breaker.js";
import { createDefaultGuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import { ReviewManager } from "../session/review.js";
import { createMcpStartupCancellationToken } from "../session/mcp-startup.js";
import {
  createRolloutTraceRecorder,
  type RolloutTraceRecorder,
  type ThreadStartedTraceMetadata,
} from "../session/rollout-trace.js";
import type {
  AuthManager,
  SessionConfiguration,
} from "../session/turn-context.js";
import type { AgenCConfig } from "../config/schema.js";
import type {
  ExecPolicyManager,
  Hooks,
  LocalThreadStore,
  McpConnectionManager,
  ModelClient,
  RolloutRecorder,
  Session,
  SessionServices,
} from "../session/session.js";
import {
  createCodeModeService,
} from "../tools/code-mode/service.js";
import type { CodeModeService } from "../tools/code-mode/types.js";
import {
  ToolLatencyStore,
  type ToolLatencyConfig,
} from "../tools/tool-latency-store.js";
import { initMagicDocs } from "../services/MagicDocs/magicDocs.js";
import { configurePolicyLimitsService } from "../services/policyLimits/index.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { RolloutStore } from "../session/rollout-store.js";
import {
  FileThreadStore,
  ThreadNotFoundError,
} from "../thread-store/store.js";
import {
  createLiveThread,
  resumeLiveThread,
  type LiveThread,
} from "../thread-store/live-thread.js";
import type { RegisteredAgentTask } from "../session/agent-task-lifecycle.js";
import { BehaviorSubject } from "../utils/behavior-subject.js";
import { dispatchPostCompact, dispatchPreCompact, dispatchSessionStart } from "../llm/hooks/dispatcher.js";
import {
  registerNotificationHook,
  registerPostCompactHook,
  registerPreCompactHook,
  registerSessionEndHook,
  registerSessionStartHook,
  registerSubagentStopHook,
} from "../llm/hooks/registry.js";
import { ConfiguredHooksRuntime } from "../hooks/configured-hooks.js";
import { createAutoFixPostToolHook } from "../services/autoFix/autoFixHook.js";
import {
  configureLspServerSource,
  parseLspServersConfig,
} from "../services/lsp/config.js";
import {
  getInitializationStatus as getLspInitializationStatus,
  initializeLspServerManager,
  reinitializeLspServerManager,
  shutdownLspServerManager,
} from "../services/lsp/manager.js";
import type { UserPromptSubmitHook } from "../hooks/user-prompt-submit.js";
import {
  evaluateStopHooks,
  executeStopFailureHooks,
  type StopHookHandler,
} from "../phases/stop-hooks.js";
import type {
  PermissionDecisionHook,
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
} from "../tools/hooks.js";
import type { ConfigStore } from "../config/store.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/types.js";
import type {
  AuthBackend,
  AuthSubscriptionTier,
} from "../auth/backend.js";
import { isRecord } from "../utils/record.js";

interface BootstrapShellSnapshot {
  readonly cwd: string;
  readonly shell: string | null;
  readonly path: string | null;
  readonly capturedAtUnixMs: number;
}

export interface BootstrapSessionServicesOptions {
  readonly provider: LLMProvider;
  readonly providerName: string;
  readonly apiKey?: string;
  readonly authBackend?: AuthBackend;
  readonly authSubscriptionTier?: AuthSubscriptionTier;
  readonly registry: ToolRegistry;
  readonly mcpManager: SessionServices["mcpManager"];
  readonly unifiedExecManager: UnifiedExecProcessManagerLike;
  readonly permissionModeRegistry: PermissionModeRegistry;
  readonly configStore: ConfigStore;
  readonly toolApprovals: RuntimeApprovalStore<unknown>;
  readonly networkApproval: RuntimeNetworkApprovalService;
  readonly modelsManager: SessionServices["modelsManager"];
  readonly agencHome: string;
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly conversationId: string;
  readonly model: string;
  readonly sessionConfiguration: SessionConfiguration;
  readonly codeModeService?: CodeModeService;
}

export interface BootstrapRolloutBinding {
  readonly session: Session;
  readonly rolloutStore: RolloutStore;
  readonly resume: boolean;
  readonly threadMetadata: Omit<
    ThreadStartedTraceMetadata,
    "threadId" | "cwd" | "rolloutPath" | "model" | "providerName"
  >;
}

export interface BootstrapSessionServicesHandle {
  readonly services: SessionServices;
  readonly execPolicy: BootstrapExecPolicyManager;
  readonly modelClient: BootstrapModelClient;
  readonly rolloutRecorder: BootstrapRolloutRecorderFacade;
  readonly rolloutTrace: RolloutTraceRecorder;
  readonly threadStore: FileThreadStore;
  bindSession(session: Session): void;
  bindRolloutStore(binding: BootstrapRolloutBinding): LiveThread;
  shutdown(): Promise<void>;
}

export class BootstrapRolloutRecorderFacade implements RolloutRecorder {
  private rolloutStore: RolloutStore | null = null;
  private readonly pending: RolloutItem[] = [];
  private windowGeneration = 0;

  attach(store: RolloutStore): void {
    this.rolloutStore = store;
    while (this.pending.length > 0) {
      store.appendRollout(this.pending.shift()!, { durable: true });
    }
  }

  rolloutPath(): string {
    return this.rolloutStore?.rolloutPath ?? "";
  }

  async record(item: unknown): Promise<void> {
    const rolloutItem = item as RolloutItem;
    if (this.rolloutStore) {
      this.rolloutStore.appendRollout(rolloutItem, { durable: true });
      return;
    }
    this.pending.push(rolloutItem);
  }

  async flushAndSync(): Promise<void> {
    this.rolloutStore?.flushDurable();
  }

  setWindowGeneration(n: number): void {
    this.windowGeneration = n;
  }

  currentWindowGeneration(): number {
    return this.windowGeneration;
  }
}

export class BootstrapModelClient implements ModelClient {
  private windowGeneration = 0;

  constructor(private readonly provider: LLMProvider) {}

  setWindowGeneration(n: number): void {
    this.windowGeneration = n;
    const providerHook = this.provider as unknown as {
      setWindowGeneration?: (generation: number) => void;
    };
    providerHook.setWindowGeneration?.(n);
  }

  currentWindowGeneration(): number {
    return this.windowGeneration;
  }
}

export class BootstrapExecPolicyManager implements ExecPolicyManager {
  private session: Session | null = null;
  private readonly policy = Policy.empty();

  constructor(
    private readonly permissionModeRegistry: PermissionModeRegistry,
    private readonly fallbackConfiguration: SessionConfiguration,
  ) {}

  bindSession(session: Session): void {
    this.session = session;
  }

  current(): unknown {
    const configuration =
      this.session?.sessionConfiguration ?? this.fallbackConfiguration;
    const permissionContext = this.permissionModeRegistry.current();
    return {
      cwd: configuration.cwd,
      permissionMode: permissionContext.mode,
      approvalPolicy: configuration.approvalPolicy.value,
      sandboxPolicy: configuration.sandboxPolicy.value,
      fileSystemSandboxPolicy: configuration.fileSystemSandboxPolicy,
      networkSandboxPolicy: configuration.networkSandboxPolicy,
      windowsSandboxLevel: configuration.windowsSandboxLevel,
      bypassPermissionsAcceptedIn:
        permissionContext.bypassPermissionsAcceptedIn ?? [],
      policy: this.policy,
    };
  }
}

class BootstrapMcpConnectionManager implements McpConnectionManager {
  private approvalPolicy: unknown;
  private sandboxPolicy: unknown;

  constructor(private readonly mcpManager: SessionServices["mcpManager"]) {}

  setApprovalPolicy(policy: unknown): void {
    this.approvalPolicy = policy;
  }

  setSandboxPolicy(policy: unknown): void {
    this.sandboxPolicy = policy;
  }

  async requiredStartupFailures(
    servers: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ server: string; error: string }>> {
    const isConnected = this.mcpManager.isConnected;
    if (!isConnected) return [];
    return servers
      .filter((server) => !isConnected(server))
      .map((server) => ({
        server,
        error: `required MCP server "${server}" is not connected`,
      }));
  }

  currentPolicy(): {
    readonly approvalPolicy: unknown;
    readonly sandboxPolicy: unknown;
  } {
    return {
      approvalPolicy: this.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy,
    };
  }
}

class BootstrapThreadNameStore implements LocalThreadStore {
  constructor(private readonly store: FileThreadStore) {}

  async threadName(threadId: string): Promise<string | undefined> {
    try {
      return this.store.readThread({
        threadId,
        includeArchived: true,
        includeHistory: false,
      }).name;
    } catch (err) {
      if (err instanceof ThreadNotFoundError) return undefined;
      throw err;
    }
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.store.updateThreadMetadata({
      threadId,
      includeArchived: true,
      patch: { name },
    });
  }
}

class BootstrapAgentIdentityManager {
  private readonly agentRuntimeId: string;
  private task: RegisteredAgentTask | null = null;

  constructor(conversationId: string) {
    this.agentRuntimeId = `agenc:${conversationId}:${randomUUID()}`;
  }

  async ensureRegistered(): Promise<void> {
    await this.registerTask();
  }

  async registerTask(): Promise<RegisteredAgentTask> {
    if (this.task !== null) return this.task;
    this.task = {
      agentRuntimeId: this.agentRuntimeId,
      taskId: `task:${randomUUID()}`,
      registeredAt: new Date().toISOString(),
    };
    return this.task;
  }

  async taskMatchesCurrentIdentity(
    task: RegisteredAgentTask,
  ): Promise<boolean> {
    return task.agentRuntimeId === this.agentRuntimeId;
  }
}

function createHooksService(): Hooks & {
  readonly stopHooks: StopHookHandler[];
  readonly stopFailureHooks: StopHookHandler[];
  readonly preToolUseHooks: PreToolUseHook[];
  readonly postToolUseHooks: PostToolUseHook[];
  readonly failureToolUseHooks: PostToolUseFailureHook[];
  readonly permissionDecisionHooks: PermissionDecisionHook[];
  readonly userPromptSubmitHooks: UserPromptSubmitHook[];
  addPreCompactHook(
    hook: Parameters<typeof registerPreCompactHook>[0],
  ): void;
  addPostCompactHook(
    hook: Parameters<typeof registerPostCompactHook>[0],
  ): void;
  addSessionStartHook(
    hook: Parameters<typeof registerSessionStartHook>[0],
  ): void;
  addSubagentStopHook(
    hook: Parameters<typeof registerSubagentStopHook>[0],
  ): void;
  addSessionEndHook(
    hook: Parameters<typeof registerSessionEndHook>[0],
  ): void;
  addNotificationHook(
    hook: Parameters<typeof registerNotificationHook>[0],
  ): void;
  clearConfiguredLifecycleHooks(): void;
  processSessionStart(
    ...args: Parameters<typeof dispatchSessionStart>
  ): ReturnType<typeof dispatchSessionStart>;
} {
  const stopHooks: StopHookHandler[] = [];
  const stopFailureHooks: StopHookHandler[] = [];
  const preToolUseHooks: PreToolUseHook[] = [];
  const postToolUseHooks: PostToolUseHook[] = [];
  const failureToolUseHooks: PostToolUseFailureHook[] = [];
  const permissionDecisionHooks: PermissionDecisionHook[] = [];
  const userPromptSubmitHooks: UserPromptSubmitHook[] = [];
  const lifecycleUnregisters: Array<() => void> = [];

  return {
    stopHooks,
    stopFailureHooks,
    preToolUseHooks,
    postToolUseHooks,
    failureToolUseHooks,
    permissionDecisionHooks,
    userPromptSubmitHooks,
    addPreCompactHook: (hook) => {
      lifecycleUnregisters.push(registerPreCompactHook(hook));
    },
    addPostCompactHook: (hook) => {
      lifecycleUnregisters.push(registerPostCompactHook(hook));
    },
    addSessionStartHook: (hook) => {
      lifecycleUnregisters.push(registerSessionStartHook(hook));
    },
    addSubagentStopHook: (hook) => {
      lifecycleUnregisters.push(registerSubagentStopHook(hook));
    },
    addSessionEndHook: (hook) => {
      lifecycleUnregisters.push(registerSessionEndHook(hook));
    },
    addNotificationHook: (hook) => {
      lifecycleUnregisters.push(registerNotificationHook(hook));
    },
    clearConfiguredLifecycleHooks: () => {
      for (const unregister of lifecycleUnregisters.splice(0)) {
        unregister();
      }
    },
    startupWarnings: () => [],
    executePreCompact: async (...args: unknown[]) => {
      const first = recordOrEmpty(args[0]);
      return dispatchPreCompact(
        {
          hook_event_name: "PreCompact",
          trigger: compactTrigger(first.trigger),
          custom_instructions:
            stringOrNull(first.customInstructions) ??
            stringOrNull(first.custom_instructions),
        },
        { signal: abortSignalOrUndefined(args[1]) },
      );
    },
    executePostCompact: async (...args: unknown[]) => {
      const first = recordOrEmpty(args[0]);
      return dispatchPostCompact(
        {
          hook_event_name: "PostCompact",
          trigger: compactTrigger(first.trigger),
          compact_summary:
            stringOrNull(first.compactSummary) ??
            stringOrNull(first.compact_summary) ??
            "",
        },
        { signal: abortSignalOrUndefined(args[1]) },
      );
    },
    executeStop: async (...args: unknown[]) => {
      if (args.length >= 3 && isRecord(args[2])) {
        return evaluateStopHooks(
          args[0] as never,
          args[1] as never,
          args[2] as never,
          abortSignalOrUndefined(args[3]),
        );
      }
      return { allowStop: true, blocking: false };
    },
    executeStopFailure: async (...args: unknown[]) => {
      if (args.length >= 3 && isRecord(args[2])) {
        await executeStopFailureHooks(
          args[0] as never,
          args[1] as never,
          args[2] as never,
        );
      }
    },
    processSessionStart: (...args) => dispatchSessionStart(...args),
  };
}

export function loadBootstrapHooks(opts: {
  readonly hooksRuntime: Pick<ConfiguredHooksRuntime, "load">;
  readonly hooksService: { readonly postToolUseHooks: PostToolUseHook[] };
  readonly config: Pick<AgenCConfig, "hooks">;
  readonly autoFixPostToolHook: PostToolUseHook;
}): void {
  opts.hooksRuntime.load(opts.config.hooks);
  if (!opts.hooksService.postToolUseHooks.includes(opts.autoFixPostToolHook)) {
    opts.hooksService.postToolUseHooks.push(opts.autoFixPostToolHook);
  }
}

function readConfiguredLspServers(
  cfg: ReturnType<ConfigStore["current"]>,
): ReturnType<typeof parseLspServersConfig> {
  return parseLspServersConfig(cfg.lsp_servers);
}

export async function loadBootstrapLspServers(
  cfg: ReturnType<ConfigStore["current"]>,
  opts: { readonly workspaceRoot?: string } = {},
): Promise<void> {
  const parsed = readConfiguredLspServers(cfg);
  const managerOptions =
    opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {};
  if (!parsed.success) {
    configureLspServerSource(() => {
      throw new Error(`Invalid LSP server config: ${parsed.reason}`);
    });
    const status = getLspInitializationStatus().status;
    if (status === "not-started" || status === "failed") {
      initializeLspServerManager(managerOptions);
      return;
    }
    reinitializeLspServerManager(managerOptions);
    return;
  }
  if (Object.keys(parsed.servers).length === 0) {
    configureLspServerSource(() => ({}));
    await shutdownLspServerManager();
    return;
  }
  configureLspServerSource(() => parsed.servers);
  const status = getLspInitializationStatus().status;
  if (status === "not-started" || status === "failed") {
    initializeLspServerManager(managerOptions);
    return;
  }
  reinitializeLspServerManager(managerOptions);
}

function lspErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadBootstrapLspServersInBackground(
  cfg: ReturnType<ConfigStore["current"]>,
  opts: { readonly workspaceRoot?: string } = {},
): void {
  void loadBootstrapLspServers(cfg, opts).catch((error) => {
    // eslint-disable-next-line no-console
    console.warn("[lsp] bootstrap config reload failed:", lspErrorMessage(error));
  });
}

export async function shutdownBootstrapLspServers(): Promise<void> {
  try {
    await shutdownLspServerManager();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[lsp] bootstrap shutdown failed:", lspErrorMessage(error));
  }
}

function createShellSnapshotTx(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): SessionServices["shellSnapshotTx"] {
  return new BehaviorSubject<unknown | null>({
    cwd: workspaceRoot,
    shell: env.SHELL?.trim() || null,
    path: env.PATH?.trim() || null,
    capturedAtUnixMs: Date.now(),
  } satisfies BootstrapShellSnapshot);
}

function createAuthManager(opts: {
  readonly provider: LLMProvider;
  readonly providerName: string;
  readonly apiKey?: string;
}): AuthManager {
  const providerOptions = readProviderFactoryOptions(opts.provider);
  const authMode = readRecord(providerOptions.extra)?.authMode;
  if (authMode === "oauth") {
    return {
      mode: "oauth",
      authProvider: authProviderFor(opts.providerName),
    };
  }
  const providerName = opts.providerName;
  if (
    providerName === "ollama" ||
    ((providerName === "lmstudio" ||
      providerName === "openai-compatible") &&
      !opts.apiKey &&
      !providerOptions.apiKey)
  ) {
    return { mode: "local_no_auth" };
  }
  return { mode: "bearer_key" };
}

function authProviderFor(providerName: string): AuthManager["authProvider"] {
  switch (providerName) {
    case "openai":
      return "openai";
    case "grok":
      return "xai";
    case "openrouter":
      return "openrouter";
    case "azure":
      return "azure";
    default:
      return "other";
  }
}

/**
 * Resolve the adaptive per-tool drain-timeout latency-store config (Goal #4a)
 * from env. Each knob follows the `AGENC_MAX_TOOL_DRAIN_MS` precedent:
 * a parseable, in-range positive value overrides the default; anything
 * invalid (NaN, non-positive, out-of-range probability) falls back to the
 * `ToolLatencyStore` default. Only knobs that are explicitly set are returned,
 * so unset env leaves the store on `DEFAULT_TOOL_LATENCY_CONFIG`.
 */
function resolveToolLatencyConfig(
  env: NodeJS.ProcessEnv,
): Partial<ToolLatencyConfig> {
  const cfg: { -readonly [K in keyof ToolLatencyConfig]?: number } = {};
  const intKnob = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
  };
  const probKnob = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) return undefined;
    return n;
  };
  const floatKnob = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
  };
  const minSamples = intKnob(env.AGENC_DRAIN_MIN_SAMPLES);
  if (minSamples !== undefined) cfg.minSamples = minSamples;
  const ringCap = intKnob(env.AGENC_DRAIN_RING_CAP);
  if (ringCap !== undefined) cfg.ringCap = ringCap;
  const percentile = probKnob(env.AGENC_DRAIN_PERCENTILE);
  if (percentile !== undefined) cfg.percentile = percentile;
  const kSigma = floatKnob(env.AGENC_DRAIN_K_SIGMA);
  if (kSigma !== undefined) cfg.kSigma = kSigma;
  return cfg;
}

export function buildBootstrapSessionServices(
  opts: BootstrapSessionServicesOptions,
): BootstrapSessionServicesHandle {
  const skillsServices = createLocalSkillsServices({
    agencHome: opts.agencHome,
    workspaceRoot: opts.workspaceRoot,
    config: opts.configStore.current(),
    env: {
      HOME: opts.env.HOME,
      AGENC_MANAGED_HOME: opts.env.AGENC_MANAGED_HOME,
    },
  });
  const execPolicy = new BootstrapExecPolicyManager(
    opts.permissionModeRegistry,
    opts.sessionConfiguration,
  );
  const modelClient = new BootstrapModelClient(opts.provider);
  const providerOptions = readProviderFactoryOptions(opts.provider);
  const policyApiKey = opts.apiKey ?? providerOptions.apiKey;
  const policyLimits = configurePolicyLimitsService({
    agencHome: opts.agencHome,
    providerName: opts.providerName,
    ...(providerOptions.baseURL !== undefined
      ? { baseURL: providerOptions.baseURL }
      : {}),
    ...(policyApiKey !== undefined ? { apiKey: policyApiKey } : {}),
    ...(opts.authBackend !== undefined
      ? { authBackend: opts.authBackend }
      : {}),
    ...(opts.authSubscriptionTier !== undefined
      ? { authSubscriptionTier: opts.authSubscriptionTier }
      : {}),
    sessionId: opts.conversationId,
    env: opts.env,
  });
  policyLimits.initializePolicyLimitsLoadingPromise();
  void policyLimits.loadPolicyLimits();
  const codeModeService =
    opts.codeModeService ?? createCodeModeService({ env: opts.env });
  const rolloutRecorder = new BootstrapRolloutRecorderFacade();
  const rolloutTrace = createRolloutTraceRecorder({
    threadId: opts.conversationId,
  });
  const fileThreadStore = new FileThreadStore({
    cwd: opts.workspaceRoot,
    agencHome: opts.agencHome,
    defaultModelProviderId: opts.providerName,
    projectRootMarkers: opts.configStore.current().project_root_markers,
  });
  const threadNameStore = new BootstrapThreadNameStore(fileThreadStore);
  const mcpConnectionManager = new BootstrapMcpConnectionManager(
    opts.mcpManager,
  );
  const hooksService = createHooksService();
  initMagicDocs();
  const hooksRuntime = new ConfiguredHooksRuntime({
    cwd: opts.workspaceRoot,
    env: opts.env,
    agencHome: opts.agencHome,
    shellPath: opts.env.SHELL ?? "/bin/sh",
  });
  const autoFixPostToolHook = createAutoFixPostToolHook({
    configSource: () => opts.configStore.current().autoFix,
    cwd: opts.workspaceRoot,
  });
  hooksRuntime.attachTarget(hooksService);
  const loadHooks = (cfg: ReturnType<ConfigStore["current"]>): void => {
    loadBootstrapHooks({
      hooksRuntime,
      hooksService,
      config: cfg,
      autoFixPostToolHook,
    });
  };
  loadHooks(opts.configStore.current());
  loadBootstrapLspServersInBackground(opts.configStore.current(), {
    workspaceRoot: opts.workspaceRoot,
  });
  const lspManager: NonNullable<SessionServices["lspManager"]> = {
    refreshFromConfig: (config: unknown) =>
      loadBootstrapLspServers(
        config as ReturnType<ConfigStore["current"]>,
        { workspaceRoot: opts.workspaceRoot },
      ),
  };
  const unsubscribeHooksConfig = opts.configStore.subscribe((cfg) => {
    loadHooks(cfg);
    loadBootstrapLspServersInBackground(cfg, { workspaceRoot: opts.workspaceRoot });
  });

  const services: SessionServices = {
    mcpConnectionManager,
    mcpStartupCancellationToken: createMcpStartupCancellationToken(),
    unifiedExecManager: opts.unifiedExecManager,
    hooks: hooksService,
    hooksRuntime,
    rollout: rolloutRecorder,
    rolloutTrace,
    userShell: {
      path: opts.env.SHELL ?? "/bin/sh",
      deriveExecArgs: (input: string) => ["-c", input],
    },
    agentIdentityManager: new BootstrapAgentIdentityManager(opts.conversationId),
    shellSnapshotTx: createShellSnapshotTx(opts.workspaceRoot, opts.env),
    showRawAgentReasoning: false,
    execPolicy,
    authManager: createAuthManager({
      provider: opts.provider,
      providerName: opts.providerName,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    }),
    ...(opts.authBackend !== undefined
      ? { authBackend: opts.authBackend }
      : {}),
    ...(opts.authSubscriptionTier !== undefined
      ? { authSubscriptionTier: opts.authSubscriptionTier }
      : {}),
    toolLatencyStore: new ToolLatencyStore(resolveToolLatencyConfig(opts.env)),
    modelsManager: opts.modelsManager,
    toolApprovals: {
      hasApproval: (key: string) => opts.toolApprovals.get(key) !== undefined,
      approve: (key: string) => {
        opts.toolApprovals.set(key, { kind: "approved_for_session" });
      },
      clear: () => {
        opts.toolApprovals.clear();
      },
      withCachedApproval: ({ keys, fetchDecision }) =>
        opts.toolApprovals.withCachedApproval({
          keys,
          fetchDecision: () => fetchDecision() as Promise<ReviewDecision>,
        }),
    },
    guardianRejections: new Map(),
    guardianRejectionCircuitBreaker: createGuardianRejectionCircuitBreaker(),
    guardianApprovalReviewer: createDefaultGuardianApprovalReviewer(),
    reviewManager: new ReviewManager(),
    skillsManager: skillsServices.skillsManager,
    pluginsManager: skillsServices.pluginsManager,
    mcpManager: opts.mcpManager,
    lspManager,
    skillsWatcher: skillsServices.skillsWatcher,
    agentControl: {
      maxThreads: 0,
      spawnAgent: async () => null,
      shutdownAgentTree: async () => {},
    },
    networkApproval: {
      enabled: () => true,
      clearSessionHosts: () => {
        opts.networkApproval.clearSessionHosts();
      },
      requestNetworkApproval: (request: unknown) =>
        requestBootstrapNetworkApproval(opts.networkApproval, request),
      requestDeferredApproval: (request: unknown) =>
        opts.networkApproval.requestDeferredApproval(
          request as Parameters<
            typeof opts.networkApproval.requestDeferredApproval
          >[0],
        ),
    },
    threadStore: threadNameStore,
    modelClient,
    codeModeService,
    provider: opts.provider,
    registry: opts.registry,
    permissionAuditLogger: createPermissionAuditFileLogger({
      agencHome: opts.agencHome,
    }),
    permissionModeRegistry: opts.permissionModeRegistry,
    configStore: opts.configStore,
    policyLimits,
  };

  return {
    services,
    execPolicy,
    modelClient,
    rolloutRecorder,
    rolloutTrace,
    threadStore: fileThreadStore,
    bindSession: (session: Session) => {
      execPolicy.bindSession(session);
    },
    bindRolloutStore: (binding: BootstrapRolloutBinding) => {
      rolloutRecorder.attach(binding.rolloutStore);
      const liveThread = binding.resume
        ? resumeLiveThread({
            threadId: binding.session.conversationId,
            rolloutStore: binding.rolloutStore,
            rolloutPath: binding.rolloutStore.rolloutPath,
            includeArchived: true,
            threadStore: fileThreadStore,
            model: opts.model,
            modelProvider: opts.providerName,
          })
        : createLiveThread({
            threadId: binding.session.conversationId,
            rolloutStore: binding.rolloutStore,
            threadStore: fileThreadStore,
            source: "cli_main",
            model: opts.model,
            modelProvider: opts.providerName,
            cwd: opts.workspaceRoot,
          });
      (services as { liveThread?: LiveThread }).liveThread = liveThread;
      rolloutTrace.recordThreadStarted({
        ...binding.threadMetadata,
        threadId: binding.session.conversationId,
        cwd: opts.workspaceRoot,
        rolloutPath: binding.rolloutStore.rolloutPath,
        model: opts.model,
        providerName: opts.providerName,
      });
      return liveThread;
    },
    shutdown: async () => {
      unsubscribeHooksConfig();
      await skillsServices.skillsWatcher.stop?.();
      await shutdownBootstrapLspServers();
      hooksService.clearConfiguredLifecycleHooks();
      rolloutTrace.flush();
      rolloutTrace.close();
      services.shellSnapshotTx.complete();
      policyLimits.stopBackgroundPolling();
      fileThreadStore.close();
    },
  };
}

function compactTrigger(value: unknown): "manual" | "auto" {
  return value === "auto" ? "auto" : "manual";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function abortSignalOrUndefined(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requestBootstrapNetworkApproval(
  service: RuntimeNetworkApprovalService,
  request: unknown,
): Promise<unknown> {
  if (isManagedNetworkApprovalRequest(request)) {
    return requestManagedNetworkApprovalForSandbox({
      ...request,
      service,
    });
  }
  return service.requestNetworkApproval(
    request as Parameters<RuntimeNetworkApprovalService["requestNetworkApproval"]>[0],
  );
}

function isManagedNetworkApprovalRequest(
  value: unknown,
): value is Omit<ManagedNetworkApprovalOptions, "service"> {
  if (!isRecord(value)) return false;
  return (
    isRecord(value["key"]) &&
    isRecord(value["sandboxPolicy"]) &&
    isBootstrapApprovalPolicy(value["approvalPolicy"])
  );
}

function isBootstrapApprovalPolicy(
  value: unknown,
): value is ManagedNetworkApprovalOptions["approvalPolicy"] {
  return (
    value === "never" ||
    value === "on_failure" ||
    value === "on_request" ||
    value === "granular" ||
    value === "untrusted"
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
