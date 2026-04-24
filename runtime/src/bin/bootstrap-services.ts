import { randomUUID } from "node:crypto";

import type { LLMProvider } from "../llm/types.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import { NetworkApprovalService as RuntimeNetworkApprovalService } from "../permissions/network-approval.js";
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { createGuardianRejectionCircuitBreaker } from "../session/guardian-rejection-circuit-breaker.js";
import { createDefaultGuardianApprovalReviewer } from "../session/guardian-approval-review.js";
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
  SessionTelemetry,
} from "../session/turn-context.js";
import type {
  AnalyticsEventsClient,
  CodeModeService,
  ExecPolicyManager,
  Hooks,
  LocalThreadStore,
  McpConnectionManager,
  ModelClient,
  RolloutRecorder,
  Session,
  SessionServices,
} from "../session/session.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { RolloutStore } from "../session/rollout-store.js";
import {
  FileThreadStore,
  ThreadNotFoundError,
} from "../session/thread-store.js";
import {
  createLiveThread,
  resumeLiveThread,
  type LiveThread,
} from "../session/live-thread.js";
import type { RegisteredAgentTask } from "../session/agent-task-lifecycle.js";
import { BehaviorSubject } from "../utils/behavior-subject.js";
import {
  executePostCompactHooks,
  executePreCompactHooks,
  processSessionStartHooks,
} from "../llm/compact/_deps/hooks.js";
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
import type { UnifiedExecProcessManagerLike } from "../unified-exec/index.js";

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
  readonly analyticsEventsClient: BootstrapAnalyticsEventsClient;
  readonly execPolicy: BootstrapExecPolicyManager;
  readonly modelClient: BootstrapModelClient;
  readonly rolloutRecorder: BootstrapRolloutRecorderFacade;
  readonly rolloutTrace: RolloutTraceRecorder;
  readonly threadStore: FileThreadStore;
  bindSession(session: Session): void;
  bindRolloutStore(binding: BootstrapRolloutBinding): LiveThread;
  shutdown(): void;
}

export class BootstrapAnalyticsEventsClient
  implements AnalyticsEventsClient
{
  private readonly records: Array<{
    readonly atUnixMs: number;
    readonly event: unknown;
  }> = [];

  constructor(private readonly maxRecords = 1_000) {}

  async emit(event: unknown): Promise<void> {
    this.records.push({ atUnixMs: Date.now(), event });
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  events(): ReadonlyArray<{ readonly atUnixMs: number; readonly event: unknown }> {
    return [...this.records];
  }
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

export class BootstrapCodeModeService implements CodeModeService {
  private readonly codeModeEnabled: boolean;

  constructor(opts: {
    readonly env: NodeJS.ProcessEnv;
    readonly registry: ToolRegistry;
  }) {
    const raw = opts.env.AGENC_CODE_MODE?.trim().toLowerCase();
    const requested = raw === "1" || raw === "true" || raw === "on";
    this.codeModeEnabled =
      requested &&
      opts.registry.tools.some(
        (tool) => tool.name === "js_repl" || tool.name === "system.js_repl",
      );
  }

  enabled(): boolean {
    return this.codeModeEnabled;
  }
}

export class BootstrapExecPolicyManager implements ExecPolicyManager {
  private session: Session | null = null;

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
  processSessionStart(
    ...args: Parameters<typeof processSessionStartHooks>
  ): ReturnType<typeof processSessionStartHooks>;
} {
  const stopHooks: StopHookHandler[] = [];
  const stopFailureHooks: StopHookHandler[] = [];
  const preToolUseHooks: PreToolUseHook[] = [];
  const postToolUseHooks: PostToolUseHook[] = [];
  const failureToolUseHooks: PostToolUseFailureHook[] = [];
  const permissionDecisionHooks: PermissionDecisionHook[] = [];

  return {
    stopHooks,
    stopFailureHooks,
    preToolUseHooks,
    postToolUseHooks,
    failureToolUseHooks,
    permissionDecisionHooks,
    startupWarnings: () => [],
    executePreCompact: async (...args: unknown[]) => {
      const first = recordOrEmpty(args[0]);
      return executePreCompactHooks(
        {
          trigger: compactTrigger(first.trigger),
          customInstructions:
            stringOrNull(first.customInstructions) ??
            stringOrNull(first.custom_instructions),
        },
        abortSignalOrUndefined(args[1]),
      );
    },
    executePostCompact: async (...args: unknown[]) => {
      const first = recordOrEmpty(args[0]);
      return executePostCompactHooks(
        {
          trigger: compactTrigger(first.trigger),
          compactSummary:
            stringOrNull(first.compactSummary) ??
            stringOrNull(first.compact_summary) ??
            "",
        },
        abortSignalOrUndefined(args[1]),
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
    processSessionStart: (...args) => processSessionStartHooks(...args),
  };
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
    (providerName === "lmstudio" && !opts.apiKey && !providerOptions.apiKey)
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

function createSessionTelemetry(opts: {
  readonly model: string;
  readonly providerName: string;
  readonly conversationId: string;
}): SessionTelemetry {
  return {
    modelSlug: opts.model,
    providerName: opts.providerName,
    conversationId: opts.conversationId,
    startedAtUnixMs: Date.now(),
  } as SessionTelemetry;
}

export function buildBootstrapSessionServices(
  opts: BootstrapSessionServicesOptions,
): BootstrapSessionServicesHandle {
  const skillsServices = createLocalSkillsServices({
    agencHome: opts.agencHome,
    workspaceRoot: opts.workspaceRoot,
    env: opts.env,
  });
  const analyticsEventsClient = new BootstrapAnalyticsEventsClient();
  const execPolicy = new BootstrapExecPolicyManager(
    opts.permissionModeRegistry,
    opts.sessionConfiguration,
  );
  const modelClient = new BootstrapModelClient(opts.provider);
  const rolloutRecorder = new BootstrapRolloutRecorderFacade();
  const rolloutTrace = createRolloutTraceRecorder({
    threadId: opts.conversationId,
  });
  const fileThreadStore = new FileThreadStore({
    cwd: opts.workspaceRoot,
    projectRootMarkers: opts.configStore.current().project_root_markers,
  });
  const threadNameStore = new BootstrapThreadNameStore(fileThreadStore);
  const mcpConnectionManager = new BootstrapMcpConnectionManager(
    opts.mcpManager,
  );

  const services: SessionServices = {
    mcpConnectionManager,
    mcpStartupCancellationToken: createMcpStartupCancellationToken(),
    unifiedExecManager: opts.unifiedExecManager,
    analyticsEventsClient,
    hooks: createHooksService(),
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
    sessionTelemetry: createSessionTelemetry({
      model: opts.model,
      providerName: opts.providerName,
      conversationId: opts.conversationId,
    }),
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
        opts.networkApproval.requestNetworkApproval(
          request as Parameters<
            typeof opts.networkApproval.requestNetworkApproval
          >[0],
        ),
      requestDeferredApproval: (request: unknown) =>
        opts.networkApproval.requestDeferredApproval(
          request as Parameters<
            typeof opts.networkApproval.requestDeferredApproval
          >[0],
        ),
    },
    threadStore: threadNameStore,
    modelClient,
    codeModeService: new BootstrapCodeModeService({
      env: opts.env,
      registry: opts.registry,
    }),
    provider: opts.provider,
    registry: opts.registry,
    permissionModeRegistry: opts.permissionModeRegistry,
    configStore: opts.configStore,
  };

  return {
    services,
    analyticsEventsClient,
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
          })
        : createLiveThread({
            threadId: binding.session.conversationId,
            rolloutStore: binding.rolloutStore,
            threadStore: fileThreadStore,
            source: "cli_main",
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
    shutdown: () => {
      rolloutTrace.flush();
      rolloutTrace.close();
      services.shellSnapshotTx.complete();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
