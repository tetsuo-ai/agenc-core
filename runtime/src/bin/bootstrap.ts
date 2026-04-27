import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createProvider,
  type ProviderName,
} from "../llm/provider.js";
import type { LLMProvider } from "../llm/types.js";
import { StaticModelsManager } from "../llm/models-manager.js";
import { setContextWindowUpgradeContext } from "../llm/context-window-upgrade.js";
import {
  markCapabilityDrift,
  markCapabilityVerified,
  resolveProviderCapabilityEntry,
  shouldProbeCapabilityEntry,
} from "../llm/capabilities.js";
import { MCPManager } from "../mcp-client/manager.js";
import {
  registerAutoSaveSidecar,
  type TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";
import { getSessionMemoryMode } from "../prompts/memory/index.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { isAutoModeGateEnabled } from "../permissions/classifier.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import {
  NetworkApprovalService as RuntimeNetworkApprovalService,
} from "../permissions/network-approval.js";
import { initializeToolPermissionContext } from "../permissions/settings.js";
import { buildTurnContext, type TurnContext } from "../session/turn-context.js";
import { Session, type SessionState } from "../session/session.js";
import {
  createSessionMcpManagerFromConfig,
  createSessionMcpService,
} from "../session/mcp-startup.js";
import type {
  Config,
  ModelInfo,
  SessionConfiguration,
} from "../session/turn-context.js";
import {
  SchemaMismatchError,
  SessionLockedError,
  getProjectDir,
  readIndexSnapshot,
} from "../session/session-store.js";
import { RolloutStore } from "../session/rollout-store.js";
import { reconstructFromRollout } from "../session/rollout-reconstruction.js";
import { recordInitialHistoryOnResume } from "../session/agent-task-lifecycle.js";
import {
  bootstrapSession,
  type BootstrapSessionConfiguredPayload,
} from "../session/bootstrap.js";
import { SidecarManager } from "../session/sidecar.js";
import { FileHistory, FileHistorySidecar } from "../session/file-history.js";
import { ErrorLogSidecar } from "../session/error-log.js";
import { CostSidecar } from "../session/cost.js";
import { shutdownSessionLifecycle } from "../session/lifecycle.js";
import type { EventMsg } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from "./_deps/types-logs.js";
import { AgentControl } from "../agents/control.js";
import { AgentRegistry } from "../agents/registry.js";
import {
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";
import {
  UnifiedExecProcessManager,
} from "../unified-exec/index.js";
import { createCodeModeService } from "../tools/code-mode/index.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "./_deps/current-session.js";
import {
  getClaudeConfigHomeDir,
  resolveClaudeConfigHomeDir,
} from "./_deps/env-utils.js";
import {
  loadTranscriptFile,
} from "./_deps/session-storage.js";
import { resolveTransportMode } from "../transport/fallback-ladder.js";
import { toInfraSessionId } from "./_deps/session-id-compat.js";
import { restoreFromEntries } from "./_deps/context-collapse.js";
import {
  ConfigStore,
  resolveAgencHome as resolveAgencHomeFromEnv,
  resolveProviderSettings,
  resolveWorkspace as resolveWorkspaceFromEnv,
  type AgenCConfig,
} from "../config/index.js";
import { bindSessionAgentControl } from "./delegate-tool.js";
import {
  readStartupCliFlags,
  resolveStartupSelection,
} from "./startup-selection.js";
export {
  DEFAULT_MODEL,
  PROVIDER_MODEL_CATALOG,
  readStartupCliFlags,
  resolveModelOrExit,
  resolveStartupSelection,
} from "./startup-selection.js";
export type {
  StartupCliFlags,
  StartupSelection,
} from "./startup-selection.js";
import {
  buildExtractMemoriesViaSubagent,
  TurnStateAccumulator,
} from "./memory-bootstrap.js";
import {
  buildBootstrapSessionServices,
  type BootstrapSessionServicesHandle,
} from "./bootstrap-services.js";
export {
  EXTRACT_MEMORIES_TIMEOUT_MS,
  buildExtractMemoriesViaSubagent,
  parseExtractedMemoryCandidates,
  TurnStateAccumulator,
} from "./memory-bootstrap.js";

type StartupInternalEvent = {
  readonly payload: Record<string, unknown>;
  readonly agent_id?: string;
};

type StartupInternalEventPage = {
  readonly data?: ReadonlyArray<{
    readonly payload?: Record<string, unknown> | null;
    readonly agent_id?: string;
  }>;
  readonly next_cursor?: string;
};

async function loadPersistedContextCollapseState(params: {
  readonly configHomes: readonly string[];
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly projectRootMarkers?: readonly string[];
}): Promise<{
  readonly contextCollapseCommits: ContextCollapseCommitEntry[];
  readonly contextCollapseSnapshot?: ContextCollapseSnapshotEntry;
} | null> {
  const candidates = new Set<string>([
    join(
      getProjectDir(params.workspaceRoot, params.projectRootMarkers),
      `${params.conversationId}.jsonl`,
    ),
  ]);

  for (const configHome of params.configHomes) {
    try {
      const projectRoots = await readdir(join(configHome, "projects"), {
        withFileTypes: true,
      });
      for (const entry of projectRoots) {
        if (!entry.isDirectory()) continue;
        candidates.add(
          join(
            configHome,
            "projects",
            entry.name,
            `${params.conversationId}.jsonl`,
          ),
        );
      }
    } catch {
      // No projects directory yet for this config-home candidate.
    }
  }

  let firstTranscript: Awaited<ReturnType<typeof loadTranscriptFile>> | null =
    null;
  for (const transcriptPath of candidates) {
    try {
      const transcript = await loadTranscriptFile(transcriptPath);
      if (
        (transcript.contextCollapseCommits?.length ?? 0) > 0 ||
        transcript.contextCollapseSnapshot !== undefined
      ) {
        return transcript;
      }
      firstTranscript ??= transcript;
    } catch {
      // Best-effort candidate probing. Caller emits a warning only if no
      // candidate with valid transcript data can be restored.
    }
  }

  return firstTranscript;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildSessionIngressLogUrl(baseUrl: string, sessionId: string): string {
  return `${trimTrailingSlash(baseUrl)}/v1/session_ingress/session/${sessionId}`;
}

function buildCodeSessionBaseUrl(baseUrl: string, sessionId: string): string {
  return `${trimTrailingSlash(baseUrl)}/v1/code/sessions/${toInfraSessionId(sessionId)}`;
}

function parseWorkerEpoch(env: NodeJS.ProcessEnv): number | null {
  const raw = env.CLAUDE_CODE_WORKER_EPOCH;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

async function fetchStartupInternalEvents(params: {
  readonly sessionBaseUrl: string;
  readonly headers: Record<string, string>;
  readonly subagents?: boolean;
}): Promise<StartupInternalEvent[] | null> {
  const allEvents: StartupInternalEvent[] = [];
  let cursor: string | undefined;

  while (true) {
    const url = new URL(
      `${params.sessionBaseUrl}/worker/internal-events`,
    );
    if (params.subagents) {
      url.searchParams.set("subagents", "true");
    }
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, {
      headers: params.headers,
    });
    if (!response.ok) {
      return null;
    }

    const page = (await response.json()) as StartupInternalEventPage;
    for (const event of page.data ?? []) {
      if (event.payload) {
        allEvents.push({
          payload: event.payload,
          ...(event.agent_id ? { agent_id: event.agent_id } : {}),
        });
      }
    }

    if (!page.next_cursor) {
      return allEvents;
    }
    cursor = page.next_cursor;
  }
}

async function writeStartupInternalEvent(params: {
  readonly sessionBaseUrl: string;
  readonly headers: Record<string, string>;
  readonly workerEpoch: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly options?: { readonly isCompaction?: boolean; readonly agentId?: string };
}): Promise<void> {
  const response = await fetch(`${params.sessionBaseUrl}/worker/internal-events`, {
    method: "POST",
    headers: {
      ...params.headers,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      worker_epoch: params.workerEpoch,
      events: [
        {
          payload: {
            type: params.eventType,
            ...params.payload,
            uuid:
              typeof params.payload.uuid === "string"
                ? params.payload.uuid
                : randomUUID(),
          },
          ...(params.options?.isCompaction ? { is_compaction: true } : {}),
          ...(params.options?.agentId ? { agent_id: params.options.agentId } : {}),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`startup internal event POST failed: ${response.status}`);
  }
}

async function registerStartupSessionIngress(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly conversationId: string;
}): Promise<void> {
  const baseUrl = params.env.SESSION_INGRESS_URL?.trim();
  if (!baseUrl) {
    return;
  }

  const [
    sessionIngressAuthMod,
    sessionStorageMod,
  ] = await Promise.all([
    import("./_deps/session-ingress-auth.js"),
    import("./_deps/session-storage.js"),
  ]);
  const authHeaders = sessionIngressAuthMod.getSessionIngressAuthHeaders();

  sessionStorageMod.setRemoteIngressUrl(
    buildSessionIngressLogUrl(baseUrl, params.conversationId),
  );

  if (resolveTransportMode(params.env) !== "sse") {
    return;
  }

  if (Object.keys(authHeaders).length === 0) {
    return;
  }

  const sessionBaseUrl = buildCodeSessionBaseUrl(baseUrl, params.conversationId);
  sessionStorageMod.setInternalEventReader(
    () =>
      fetchStartupInternalEvents({
        sessionBaseUrl,
        headers: authHeaders,
      }),
    () =>
      fetchStartupInternalEvents({
        sessionBaseUrl,
        headers: authHeaders,
        subagents: true,
      }),
  );

  const workerEpoch = parseWorkerEpoch(params.env);
  if (workerEpoch === null) {
    return;
  }

  sessionStorageMod.setInternalEventWriter((eventType, payload, options) =>
    writeStartupInternalEvent({
      sessionBaseUrl,
      headers: authHeaders,
      workerEpoch,
      eventType,
      payload,
      options,
    }),
  );
}

const TRANSCRIPT_BOOT_EVENT_TYPES = new Set<string>([
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "user_message",
  "agent_message",
  "agent_message_delta",
  "tool_call_started",
  "tool_call_completed",
  "tool_progress",
  "exec_command_begin",
  "exec_command_end",
  "context_compacted",
  "warning",
  "error",
  "stream_error",
  "deprecation_notice",
  "plan_started",
  "plan_delta",
  "plan_item_completed",
  "plan_exited",
]);

type BootstrapTranscriptEvent = {
  readonly id?: string;
  readonly seq?: number;
  readonly type: string;
  readonly payload: unknown;
};

function transcriptEventsFromRollout(
  items: ReadonlyArray<RolloutItem>,
): BootstrapTranscriptEvent[] {
  const out: BootstrapTranscriptEvent[] = [];
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const type = item.payload.msg.type;
    if (!TRANSCRIPT_BOOT_EVENT_TYPES.has(type)) continue;
    out.push({
      id: item.payload.id,
      seq: item.payload.seq,
      type,
      payload: item.payload.msg.payload,
    });
  }
  return out;
}

function transcriptMessagesFrom(
  events: ReadonlyArray<BootstrapTranscriptEvent>,
): EventMsg[] {
  return events.map(
    (event) =>
      ({
        type: event.type,
        payload: event.payload,
      }) as EventMsg,
  );
}

/**
 * Structural `Config` shape for the live local-runtime session. Most fields
 * are still deferred to later tranches that own the corresponding subsystems
 * (see per-field comments). Used as the `Session.config` snapshot source.
 */
function buildDeferredConfig(
  cwd: string,
  model: string,
  config: AgenCConfig,
): Config {
  const modelReasoningEffort =
    config.reasoning_effort === "minimal"
      ? "low"
      : config.reasoning_effort;
  return {
    model,
    ...(config.review_model !== undefined
      ? { reviewModel: config.review_model }
      : {}),
    ...(config.model_verbosity !== undefined
      ? { modelVerbosity: config.model_verbosity }
      : {}),
    ...(modelReasoningEffort !== undefined
      ? { modelReasoningEffort }
      : {}),
    ...(config.reasoning_summary !== undefined
      ? { modelReasoningSummary: config.reasoning_summary }
      : {}),
    ...(config.service_tier !== undefined
      ? { serviceTier: config.service_tier }
      : {}),
    ...(config.personality !== undefined
      ? { personality: config.personality }
      : {}),
    ...(config.approvals_reviewer !== undefined
      ? { approvalsReviewer: config.approvals_reviewer }
      : {}),
    cwd,
    /**
     * T10: real feature-flag source. Today both flags are hard-false so the
     * session does not accidentally believe it is running in a ChatGPT-auth
     * or legacy-Landlock context before feature-flag wiring lands.
     */
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
    /** T9: `multiAgentV2` hints (subagent usage hints + metadata visibility). */
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    /**
     * T11 deferred: `permissions.allowLoginShell`, `shellEnvironmentPolicy`,
     * and `windowsSandboxPrivateDesktop` are sandbox/exec-policy knobs. The
     * real values come from the config/profile loader (T10) + sandbox policy
     * resolver (T11). Conservative defaults here keep the shell tool from
     * picking up login-shell semantics before explicit config arrives.
     */
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    /** T-future: ghost-snapshot state machine (AgenC runtime workspace restore). */
    ghostSnapshot: { enabled: false },
    /** T9: real `agentRoles` list from role layer (`agents/role.ts`). */
    agentRoles: [],
  };
}

function mapApprovalPolicy(
  raw: AgenCConfig["approval_policy"] | undefined,
): SessionConfiguration["approvalPolicy"]["value"] {
  switch (raw) {
    case "never":
      return "never";
    case "on-failure":
      return "on_failure";
    case "on-request":
      return "on_request";
    case "untrusted":
      return "untrusted";
    default:
      return "on_request";
  }
}

function mapSandboxPolicy(
  raw: AgenCConfig["sandbox_mode"] | undefined,
): SessionConfiguration["sandboxPolicy"]["value"] {
  switch (raw) {
    case "read-only":
      return "read_only";
    case "danger-full-access":
      return "danger_full_access";
    case "workspace-write":
      return "workspace_write";
    default:
      return "workspace_write";
  }
}

export function sessionConfigurationFromAgenCConfig(params: {
  readonly config: AgenCConfig;
  readonly workspaceRoot: string;
  readonly model: string;
  readonly provider?: string;
}): SessionConfiguration {
  const approval = mapApprovalPolicy(params.config.approval_policy);
  const sandbox = mapSandboxPolicy(params.config.sandbox_mode);
  const base: SessionConfiguration = {
    cwd: params.workspaceRoot,
    approvalPolicy: { value: approval },
    sandboxPolicy: { value: sandbox },
    fileSystemSandboxPolicy: {
      allowWrite: sandbox === "workspace_write" ? [params.workspaceRoot] : [],
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
    ...(params.provider
      ? {
        provider: {
          slug: params.provider,
        } as unknown as SessionConfiguration["provider"],
      }
      : {}),
    collaborationMode: { model: params.model },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...(params.config.review_model !== undefined
      ? { reviewModel: params.config.review_model }
      : {}),
    ...(params.config.approvals_reviewer !== undefined
      ? { approvalsReviewer: params.config.approvals_reviewer }
      : {}),
    ...(params.config.model_verbosity !== undefined
      ? { modelVerbosity: params.config.model_verbosity }
      : {}),
    ...(params.config.personality !== undefined
      ? { personality: params.config.personality }
      : {}),
    ...(params.config.reasoning_summary !== undefined
      ? { modelReasoningSummary: params.config.reasoning_summary }
      : {}),
    ...(params.config.service_tier !== undefined
      ? { serviceTier: params.config.service_tier }
      : {}),
    ...(params.config.compact_prompt !== undefined
      ? { compactPrompt: params.config.compact_prompt }
      : {}),
  };
}

export interface BootstrapLocalRuntimeSessionOptions {
  readonly apiKey?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly conversationId?: string;
  readonly toolRegistryOptions?: Omit<BuildToolRegistryOptions, "workspaceRoot">;
}

export interface LocalRuntimeBootstrap {
  readonly agencHome: string;
  readonly configStore: ConfigStore;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly resolvedProvider: string;
  readonly model: string;
  readonly registry: ToolRegistry;
  readonly provider: LLMProvider;
  readonly config: Config;
  readonly modelInfo: ModelInfo;
  readonly initialState: SessionState;
  readonly mcpManager: MCPManager;
  readonly session: Session;
  readonly rolloutStore: RolloutStore;
  readonly sidecarManager: SidecarManager;
  readonly ctx: TurnContext;
  readonly memoryDir: string;
  readonly memoryMdPath: string;
  readonly shutdown: () => Promise<void>;
}

export async function bootstrapLocalRuntimeSession(
  options: BootstrapLocalRuntimeSessionOptions,
): Promise<LocalRuntimeBootstrap> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const agencHome = resolveAgencHomeFromEnv(env);
  const transcriptConfigHome = resolveClaudeConfigHomeDir({
    configDirEnv: env.CLAUDE_CONFIG_DIR,
    homeDir: env.HOME,
  });
  const legacyProcessConfigHome = getClaudeConfigHomeDir();
  const configStore = new ConfigStore({
    home: agencHome,
    env,
  });
  await configStore.reload();
  const startup = resolveStartupSelection({
    config: configStore.current(),
    env,
    argv,
  });
  const cli = readStartupCliFlags(argv);

  const workspaceRoot =
    resolveWorkspaceFromEnv(env) ?? options.cwd ?? process.cwd();
  const permissionInit = await initializeToolPermissionContext({
    env: {
      home: agencHome,
      cwd: workspaceRoot,
      configStore,
    },
    ...(cli.permissionMode ? { permissionMode: cli.permissionMode } : {}),
    ...(cli.allowDangerouslySkipPermissions
      ? { allowDangerouslySkipPermissions: true }
      : {}),
  });
  const autoModeEnabled = isAutoModeGateEnabled();
  const toolPermissionContext = {
    ...permissionInit.toolPermissionContext,
    isAutoModeAvailable: autoModeEnabled,
    ...(permissionInit.toolPermissionContext.mode === "auto" && !autoModeEnabled
      ? { mode: "default" as const, autoModeActive: false }
      : {}),
  };
  const permissionModeRegistry = new PermissionModeRegistry(
    toolPermissionContext,
  );
  const toolApprovals = new RuntimeApprovalStore<unknown>();
  const networkApproval = new RuntimeNetworkApprovalService();
  const resolvedProvider = startup.provider;
  const model = startup.model;
  const providerSettings = resolveProviderSettings(
    resolvedProvider,
    startup.config,
    env,
  );
  const mcpManager = createSessionMcpManagerFromConfig(
    configStore.current(),
    env,
  );
  const unifiedExecManager = new UnifiedExecProcessManager({
    cwd: workspaceRoot,
    maxTimeoutMs: 300_000,
  });
  const codeModeService = createCodeModeService({ env });
  let sessionRef: Session | null = null;
  const emitProviderWarning = (warning: {
    cause: string;
    message: string;
  }): void => {
    if (sessionRef === null) return;
    sessionRef.emit({
      id: sessionRef.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: warning,
      },
    });
  };
  const handleCapabilityDrift = (warning: {
    message: string;
    status?: number;
  }): void => {
    markCapabilityDrift({
      provider: resolvedProvider,
      model,
      overrides: providerSettings?.capabilityOverrides,
    });
    emitProviderWarning({
      cause: "capability_drift_detected",
      message:
        warning.status !== undefined
          ? `${resolvedProvider}/${model} rejected a capability the registry claimed it supported (HTTP ${warning.status}): ${warning.message}`
          : `${resolvedProvider}/${model} rejected a capability the registry claimed it supported: ${warning.message}`,
    });
  };

  const registry = buildBootstrapToolRegistry({
    workspaceRoot,
    agencHome,
    mcpManager,
    getSession: () => sessionRef,
    emitWarning: emitProviderWarning,
    toolRegistryOptions: {
      ...(options.toolRegistryOptions ?? {}),
      unifiedExecManager,
      codeModeService,
    },
  });
  const provider: LLMProvider = createProvider(
    resolvedProvider as ProviderName,
    {
      apiKey: options.apiKey ?? startup.apiKey,
      ...(providerSettings?.baseURL ? { baseURL: providerSettings.baseURL } : {}),
      model,
      tools: registry.toLLMTools(),
      extra: {
        emitWarning: emitProviderWarning,
        onCapabilityDrift: handleCapabilityDrift,
      },
    },
  );
  const capabilityEntry = resolveProviderCapabilityEntry({
    provider: resolvedProvider,
    model,
    overrides: providerSettings?.capabilityOverrides,
  });
  if (shouldProbeCapabilityEntry(capabilityEntry)) {
    queueMicrotask(() => {
      void provider
        .healthCheck()
        .then((healthy) => {
          if (!healthy) return;
          markCapabilityVerified({
            provider: resolvedProvider,
            model,
          });
        })
        .catch(() => {
          // Best-effort T13 capability revalidation probe.
        });
    });
  }
  const conversationId =
    options.conversationId ?? `conv-${Date.now().toString(36)}`;
  const config = buildDeferredConfig(workspaceRoot, model, startup.config);
  const modelsManager = new StaticModelsManager({
    config: startup.config,
    fallbackProvider: resolvedProvider,
  });
  // Register the live (model, ModelsManager) pair so sync helpers like
  // `getUpgradeMessage` (post-compact stdout breadcrumb, status hints)
  // can propose same-family larger-context-window models without
  // having to await a fresh catalog lookup.
  setContextWindowUpgradeContext({ currentModel: model, modelsManager });
  const modelInfo = await modelsManager.getModelInfo(model);
  const baseSessionConfiguration = sessionConfigurationFromAgenCConfig({
    config: startup.config,
    workspaceRoot,
    model,
    provider: resolvedProvider,
  });
  const sessionConfiguration = cli.allowDangerouslySkipPermissions
    ? ({
        ...baseSessionConfiguration,
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "danger_full_access" },
        fileSystemSandboxPolicy: {
          allowWrite: [],
          denyWrite: [],
          allowRead: [],
          denyRead: [],
        },
      } satisfies SessionConfiguration)
    : baseSessionConfiguration;
  let initialState: SessionState = {
    sessionConfiguration: {
      ...sessionConfiguration,
      permissionContext: {
        mode: toolPermissionContext.mode,
      },
    } as SessionConfiguration,
    history: [],
    ...(options.conversationId !== undefined
      ? { pendingSessionStartSource: "resume" as const }
      : {}),
  };
  let initialTranscriptEvents: readonly BootstrapTranscriptEvent[] = [];
  let initialMessages: ReadonlyArray<EventMsg> = [];

  const sessionProjectRootMarkers = startup.config.project_root_markers;
  const memoryDir = join(agencHome, "memory");
  const memoryMdPath = join(memoryDir, "MEMORY.md");
  let sidecarManager: SidecarManager | null = null;
  let turnStateAccumulator: TurnStateAccumulator | null = null;
  let shutdownStarted = false;
  // Lifecycle slots filled by the bootstrapSession hooks. The shutdown
  // closure closes over these `let` bindings so it is safe to call at
  // any point in the bootstrap lifecycle, including partial-failure
  // paths where onBeforeSessionConfigured aborts before the session or
  // agent control plane is fully wired.
  let sessionForShutdown: Session | null = null;
  let agentControlForShutdown: AgentControl | null = null;
  let rolloutStoreForReturn: RolloutStore | null = null;
  let ctxForReturn: TurnContext | null = null;
  const bootstrapServices: BootstrapSessionServicesHandle =
    buildBootstrapSessionServices({
      provider,
      providerName: resolvedProvider,
      ...(options.apiKey ?? startup.apiKey
        ? { apiKey: options.apiKey ?? startup.apiKey }
        : {}),
      registry,
      mcpManager: createSessionMcpService(mcpManager, { env }),
      unifiedExecManager,
      permissionModeRegistry,
      configStore,
      toolApprovals,
      networkApproval,
      modelsManager,
      agencHome,
      workspaceRoot,
      env,
      conversationId,
      model,
      sessionConfiguration,
      codeModeService,
    });

  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    turnStateAccumulator?.detach();
    if (sessionForShutdown !== null) {
      clearCurrentRuntimeSession(sessionForShutdown);
    }
    if (sidecarManager !== null) {
      await sidecarManager.stop().catch(() => {
        /* best effort */
      });
    }
    if (sessionForShutdown !== null && agentControlForShutdown !== null) {
      await shutdownSessionLifecycle({
        session: sessionForShutdown,
        agentControl: agentControlForShutdown,
        mcpManager,
      }).catch(() => {
        /* best effort */
      });
    }
    bootstrapServices.shutdown();
  };

  try {
    // Construct the session through `bootstrapSession` so shell
    // discovery, SessionConfigured emit, startup prewarm, and
    // resume-history recording all flow through the shared entry
    // point. The bin-specific orchestration (rollout mount, history
    // reconstruction, sidecar register, buildTurnContext, sidecar
    // start, MCP start) is threaded in via `onBeforeSessionConfigured`
    // / `onAfterSessionConfigured`. The bin path intentionally does
    // NOT pass `mcp` to `bootstrapSession` because upstream AgenC runtime
    // starts the live MCP connection manager AFTER SessionConfigured
    // (session.rs:856-908); the `onAfterSessionConfigured` hook does
    // that work instead.
    const session = await bootstrapSession({
      conversationId,
      initialState,
      features: config.features,
      services: bootstrapServices.services,
      jsRepl: { id: `repl-${conversationId}` },
      initialTranscriptEvents,
      // Lazy payload — `rolloutPath`, `initialMessages`, and
      // `historyEntryCount` are populated inside the before-hook when
      // the rollout store mounts and resume-history reconstruction
      // updates `initialState`.
      sessionConfigured: (): BootstrapSessionConfiguredPayload => ({
        sessionId: conversationId,
        model,
        modelProviderId: resolvedProvider,
        cwd: workspaceRoot,
        historyLogId: 0,
        historyEntryCount: initialState.history.length,
        initialMessages,
        ...(rolloutStoreForReturn !== null
          ? { rolloutPath: rolloutStoreForReturn.rolloutPath }
          : {}),
      }),
      onBeforeSessionConfigured: async (s) => {
        sessionRef = s;
        sessionForShutdown = s;
        bootstrapServices.bindSession(s);
        const agentRegistry = new AgentRegistry();
        const agentControl = new AgentControl({
          session: s,
          registry: agentRegistry,
        });
        agentControl.registerSessionRoot(conversationId);
        bindSessionAgentControl(s, {
          control: agentControl,
          registry: agentRegistry,
        });
        agentControlForShutdown = agentControl;

        setCurrentRuntimeSession(s);
        await registerStartupSessionIngress({
          env,
          conversationId,
        });

        // Context-collapse runtime state is process-global. Clear it
        // on every bootstrap, then restore persisted commit/snapshot
        // metadata for explicit resume sessions before the first live
        // query can run.
        restoreFromEntries([], undefined);
        if (options.conversationId !== undefined) {
          try {
            const transcriptLog = await loadPersistedContextCollapseState({
              configHomes: Array.from(
                new Set([transcriptConfigHome, legacyProcessConfigHome]),
              ),
              workspaceRoot,
              conversationId,
              projectRootMarkers: sessionProjectRootMarkers,
            });
            if (transcriptLog !== null) {
              restoreFromEntries(
                transcriptLog.contextCollapseCommits ?? [],
                transcriptLog.contextCollapseSnapshot,
              );
            }
          } catch (err) {
            if (
              !(
                err &&
                typeof err === "object" &&
                "code" in err &&
                err.code === "ENOENT"
              )
            ) {
              s.emit({
                id: s.nextInternalSubId(),
                msg: {
                  type: "warning",
                  payload: {
                    cause: "context_collapse_restore_failed",
                    message: err instanceof Error ? err.message : String(err),
                  },
                },
              });
            }
          }
        }

        const rolloutStore = new RolloutStore({
          cwd: workspaceRoot,
          sessionId: conversationId,
          agencVersion: "0.2.0",
          ...(options.conversationId !== undefined ? { resume: true } : {}),
          ...(sessionProjectRootMarkers !== undefined
            ? { projectRootMarkers: sessionProjectRootMarkers }
            : {}),
        });
        rolloutStore.open({
          sessionId: conversationId,
          timestamp: new Date().toISOString(),
          cwd: workspaceRoot,
          originator: "agenc-cli",
          agencVersion: "0.2.0",
          model,
          modelProvider: resolvedProvider,
        });
        s.mountRolloutStore(rolloutStore);
        rolloutStoreForReturn = rolloutStore;
        bootstrapServices.bindRolloutStore({
          session: s,
          rolloutStore,
          resume: options.conversationId !== undefined,
          threadMetadata: {
            agentPath: "/root",
            sessionSource: "cli_main",
            approvalPolicy: sessionConfiguration.approvalPolicy.value,
            sandboxPolicy: sessionConfiguration.sandboxPolicy.value,
          },
        });

        try {
          const existingItems = rolloutStore.readAll();
          if (existingItems.length > 0) {
            const indexSnapshot = readIndexSnapshot(
              join(
                getProjectDir(workspaceRoot, sessionProjectRootMarkers),
                "sessions",
                conversationId,
                "index.json",
              ),
            );
            const reconstruction = reconstructFromRollout(existingItems, {
              ...(indexSnapshot ? { indexSnapshot } : {}),
            });
            initialState = {
              ...initialState,
              history: reconstruction.history,
              ...(reconstruction.previousTurnSettings !== undefined
                ? { previousTurnSettings: reconstruction.previousTurnSettings }
                : {}),
              ...(reconstruction.referenceContextItem !== undefined
                ? { referenceContextItem: reconstruction.referenceContextItem }
                : {}),
            };
            await s.state.swap(initialState);
            initialTranscriptEvents = transcriptEventsFromRollout([
              ...existingItems,
              ...reconstruction.synthesizedEvents,
            ]);
            initialMessages = transcriptMessagesFrom(initialTranscriptEvents);
            s.setInitialTranscriptEvents(initialTranscriptEvents);
            if (reconstruction.synthesizedEvents.length > 0) {
              for (const synth of reconstruction.synthesizedEvents) {
                if (synth.type === "event_msg") {
                  s.emit(synth.payload);
                } else {
                  rolloutStore.appendRollout(synth);
                }
              }
            }
            // Port of AgenC runtime `Session::record_initial_history` resume
            // branch (session/mod.rs:1150-1236): restore persisted
            // agent task, emit a model-change warning when the
            // rollout's last turn ran on a different model, and seed
            // token-usage from the last persisted token_count event
            // so resume UIs show cumulative usage immediately. This
            // runs unconditionally on resume — each sub-step is a
            // no-op when its input is absent.
            //
            // Note: `bootstrapSession` also runs
            // `recordInitialHistoryOnResume` when `opts.resume` is
            // set. The bin path does NOT pass `opts.resume` because
            // the resume items are only knowable after the rollout
            // store is mounted (which happens inside this hook), so
            // the record call is made here directly.
            await recordInitialHistoryOnResume(s, existingItems, {
              ...(reconstruction.previousTurnSettings?.model !== undefined
                ? { previousModel: reconstruction.previousTurnSettings.model }
                : {}),
              currentModel: model,
            });
          }
        } catch (err) {
          s.emit({
            id: s.nextInternalSubId(),
            msg: {
              type: "warning",
              payload: {
                cause: "orphan_recovery_failed",
                message: err instanceof Error ? err.message : String(err),
              },
            },
          });
        }

        const projectDir = getProjectDir(
          workspaceRoot,
          sessionProjectRootMarkers,
        );
        sidecarManager = new SidecarManager({
          onDiagnostic: (diagnostic) => {
            s.emit({
              id: s.nextInternalSubId(),
              msg: {
                type: diagnostic.level,
                payload: {
                  cause: diagnostic.cause,
                  message: diagnostic.message,
                },
              },
            } as Parameters<typeof s.emit>[0]);
          },
        });

        const fileHistory = new FileHistory({
          projectDir,
          onDiagnostic: (diagnostic) =>
            sidecarManager?.recordDiagnostic({
              sidecar: "file-history",
              level: "warning",
              cause: diagnostic.cause,
              message: diagnostic.message,
              at: Date.now(),
            }),
        });
        sidecarManager.register(new FileHistorySidecar({ fileHistory }));
        sidecarManager.register(
          new ErrorLogSidecar({
            projectDir,
            sessionId: conversationId,
          }),
        );

        const costSidecar = new CostSidecar({
          budgetTracker: s.budgetTracker,
          projectDir,
          sessionId: conversationId,
          onDiagnostic: (diagnostic) =>
            sidecarManager?.recordDiagnostic({
              sidecar: "cost",
              level: diagnostic.level,
              cause: diagnostic.cause,
              message: diagnostic.message,
              at: Date.now(),
            }),
        });
        await costSidecar.loadFromDisk();
        sidecarManager.register(costSidecar);

        const extractMemoriesFn = buildExtractMemoriesViaSubagent({
          session: () => (shutdownStarted ? null : s),
          memoryDir,
        });
        turnStateAccumulator = new TurnStateAccumulator();
        turnStateAccumulator.subscribe(s.eventLog);
        const getTurnState = (): MemoryTurnState | null =>
          turnStateAccumulator?.snapshot() ?? null;
        sidecarManager.register(
          registerAutoSaveSidecar({
            session: { memoryDir, memoryMdPath },
            extractor: extractMemoriesFn,
            getTurnState,
            getMemoryMode: () => getSessionMemoryMode(s),
            emitWarning: (message: string) => {
              if (shutdownStarted) return;
              s.emit({
                id: s.nextInternalSubId(),
                msg: {
                  type: "warning",
                  payload: {
                    cause: "memory_write_contention",
                    message,
                  },
                },
              });
            },
          }),
        );

        ctxForReturn = buildTurnContext({
          conversationId,
          subId: s.nextInternalSubId(),
          config,
          modelInfo,
          provider,
          sessionConfiguration: initialState.sessionConfiguration,
        });
      },
      onAfterSessionConfigured: async (s) => {
        // Persist the SessionConfigured event into the initial
        // transcript so TUIs that render from
        // `session.getInitialTranscriptEvents()` see the event in the
        // same position it was emitted.
        const rolloutPath = rolloutStoreForReturn?.rolloutPath;
        s.setInitialTranscriptEvents([
          ...initialTranscriptEvents,
          {
            type: "session_configured",
            payload: {
              sessionId: conversationId,
              model,
              modelProviderId: resolvedProvider,
              cwd: workspaceRoot,
              historyLogId: 0,
              historyEntryCount: initialState.history.length,
              initialMessages,
              ...(rolloutPath !== undefined ? { rolloutPath } : {}),
            },
          },
        ]);

        // Start sidecars AFTER session_configured so they cannot emit
        // earlier events. Mirrors AgenC runtime `session.rs:750-751`: "Start
        // the watcher after SessionConfigured so it cannot emit
        // earlier events."
        if (sidecarManager !== null) {
          await sidecarManager.start(s.eventLog);
        }

        // Start the MCP connection manager AFTER session_configured
        // has been emitted + persisted to rollout. Mirrors AgenC runtime
        // ordering at
        // `AgenC runtime-rs/core/src/session/session.rs:717-748, 766` where
        // the SessionConfiguredEvent is dispatched before
        // McpConnectionManager::new.
        await s.startMcpManager(mcpManager, {
          signal: s.services.mcpStartupCancellationToken.signal,
        });
      },
    });

    sessionRef = session;
    sessionForShutdown = session;

    if (rolloutStoreForReturn === null || ctxForReturn === null) {
      // This is unreachable — `onBeforeSessionConfigured` always
      // assigns both slots before returning. The guard exists so
      // TypeScript narrows the final return statement.
      throw new Error(
        "bootstrap invariant: rollout store / turn context not initialized",
      );
    }

    return {
      agencHome,
      configStore,
      workspaceRoot,
      conversationId,
      resolvedProvider,
      model,
      registry,
      provider,
      config,
      modelInfo,
      initialState,
      mcpManager,
      session,
      rolloutStore: rolloutStoreForReturn,
      sidecarManager: sidecarManager!,
      ctx: ctxForReturn,
      memoryDir,
      memoryMdPath,
      shutdown,
    };
  } catch (err) {
    await shutdown();
    if (err instanceof SessionLockedError || err instanceof SchemaMismatchError) {
      throw err;
    }
    throw err;
  }
}
