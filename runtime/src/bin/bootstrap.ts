import { VERSION } from "../version.js";
import { randomUUID } from "node:crypto";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  createProvider,
  resolveBuiltInProviderSlug,
  type ProviderName,
} from "../llm/provider.js";
import { isFreeSubscriptionManagedModel } from "../commands/subscription-managed-models.js";
import type { LLMProvider } from "../llm/types.js";
import { StaticModelsManager } from "../llm/models-manager.js";
import { createManagedFeatures } from "../llm/registry/features.js";
import {
  markCapabilityDrift,
  markCapabilityVerified,
  resolveProviderCapabilityEntry,
  shouldProbeCapabilityEntry,
} from "../llm/capabilities.js";
import { MCPManager } from "../mcp-client/manager.js";
import {
  snapshotMcpRequestEnvironment,
  snapshotMcpRequestEnvironmentForAuthority,
} from "../mcp-client/environment.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { isAutoModeGateEnabled } from "../permissions/classifier.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import { NetworkApprovalService as RuntimeNetworkApprovalService } from "../permissions/network-approval.js";
import { initializeToolPermissionContext } from "../permissions/settings.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import { buildTurnContext, type TurnContext } from "../session/turn-context.js";
import { Session, type SessionState } from "../session/session.js";
import {
  createSessionMcpManager,
  createSessionMcpService,
} from "../session/mcp-startup.js";
import type {
  Config,
  ModelInfo,
  SessionConfiguration,
} from "../session/turn-context.js";
import {
  applySessionExecutionAuthority,
  executionAuthorityForPermissionContext,
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionConfigurationFromAgenCConfig,
  sessionExecutionAuthorityFromAgenCConfig,
  type SessionExecutionAuthority,
} from "../session/configuration.js";
import {
  SchemaMismatchError,
  SessionLockedError,
  getProjectDir,
  hasSupportedFileIdentity,
  readIndexSnapshot,
  resolveCanonicalSessionCwd,
  type ResumeRolloutDescriptorLease,
} from "../session/session-store.js";
import { RolloutStore } from "../session/rollout-store.js";
import { recordInitialHistoryOnResume } from "../session/agent-task-lifecycle.js";
import { copyPlanForResume } from "../planning/plan-files.js";
import {
  bootstrapSession,
  type BootstrapSessionConfiguredPayload,
} from "../session/bootstrap.js";
import { SidecarManager, type Sidecar } from "../session/sidecar.js";
import { FileHistory, FileHistorySidecar } from "../session/file-history.js";
import { ErrorLogSidecar } from "../session/error-log.js";
import { CostSidecar } from "../session/cost.js";
import { bindActiveCostSidecar } from "../cost/tracker.js";
import {
  SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS,
  shutdownSessionLifecycle,
} from "../session/lifecycle.js";
import type { EventMsg } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";
import type { RunResumeReason } from "../contracts/run-contracts.js";
import { AgentControl } from "../agents/control.js";
import { AgentRoleCatalog } from "../agents/role-catalog.js";
import { ThreadManager } from "../agents/thread-manager.js";
import { ConversationThreadManager } from "../conversation/thread-manager.js";
import { AgentRegistry } from "../agents/registry.js";
import { createAgentRoleWorkspace } from "../agents/role.js";
import { loadFreshAgentDefinitions } from "../tools/AgentTool/loadAgentsDir.js";
import {
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { usesLocalToolProfile } from "../llm/wire/capability-gating.js";
import { assembleBaseInstructionsForModel } from "../prompts/system-prompt.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";
import {
  UnifiedExecProcessManager,
  type UnifiedExecSandboxAuthorityQuiesceToken,
} from "../unified-exec/process-manager.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import {
  disposeSandboxExecutionBroker,
  registerSandboxExecutionLifecycleParticipant,
} from "../sandbox/execution-lifecycle.js";
import { createCodeModeService } from "../tools/code-mode/service.js";
import {
  clearCurrentRuntimeSession,
  enterCurrentRuntimeSessionScope,
  setCurrentRuntimeSession,
} from "./_deps/current-session.js";
import { resolveTransportMode } from "../transport/fallback-ladder.js";
import { ConfigStore } from "../config/store.js";
import {
  resolveAgencHome as resolveAgencHomeFromEnv,
  resolveWorkspace as resolveWorkspaceFromEnv,
} from "../config/env.js";
import {
  resolveCommandExecutionAuthority,
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../session/runtime-options.js";
import {
  assertHostedAgencSubscriptionAuthority,
  MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
  requireProviderRuntimeCredential,
  resolveProviderRuntimeAuthority,
  snapshotProviderEnvironment,
  type ProviderEnvironment,
} from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import { isGrokComposerModel } from "../llm/providers/grok/acp-adapter.js";
import { runWithStartupProviderSelection } from "../utils/model/providers.js";
import type { AgenCConfig } from "../config/schema.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { resolveAuthManagedKeysEnabled } from "../auth/selection.js";
import { bindSessionAgentControl } from "./delegate-tool.js";
import {
  readStartupCliFlags,
  resolveCanonicalStartupSelection,
  resolvedStartupProfileName,
  startupConfigLayerOptions,
  type StartupCliFlags,
} from "./startup-selection.js";
import { resolveProjectTrustStateSync } from "../permissions/trust/project-trust.js";
import { findSuitableShell } from "../utils/Shell.js";
import { subprocessEnv } from "../utils/subprocessEnv.js";
import { scrubEnvForChildProcess } from "../unified-exec/scrub-env.js";
export type { StartupCliFlags, StartupSelection } from "./startup-selection.js";
import {
  buildBootstrapSessionServices,
  type BootstrapSessionServicesHandle,
} from "./bootstrap-services.js";
import { fetchStartupInternalEvents } from "./startup-internal-events.js";
import { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import { getProxyFetchOptions } from "../utils/proxy.js";
import {
  CsvAgentJobsRepositoryAuthority,
  type CsvAgentJobsRepositoryProvider,
} from "../app-server/csv-agent-jobs-authority.js";
import {
  resolveAdmissionConcurrencyLimits,
  resolveExecutionAdmissionBudgetPolicy,
} from "../budget/admission-config.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildSessionIngressLogUrl(baseUrl: string, sessionId: string): string {
  return `${trimTrailingSlash(baseUrl)}/v1/session_ingress/session/${sessionId}`;
}

function buildCodeSessionBaseUrl(baseUrl: string, sessionId: string): string {
  const infraSessionId = sessionId.startsWith("session_")
    ? "cse_" + sessionId.slice("session_".length)
    : sessionId;
  return `${trimTrailingSlash(baseUrl)}/v1/code/sessions/${infraSessionId}`;
}

interface ResolvedAuthModelSelection {
  readonly provider: ProviderName;
  readonly model: string;
  readonly profileProvider: ProviderName;
  readonly profileModel: string;
}

function isHostedAgencProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "agenc";
}

function firstNonEmptyString(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function resolveAuthSubscriptionTier(
  authBackend: AuthBackend | undefined,
  sessionId: string,
): Promise<AuthSubscriptionTier> {
  if (authBackend === undefined) return "free";
  return authBackend.getSubscriptionTier({ sessionId });
}

async function resolveAuthModelSelection(params: {
  readonly authBackend: AuthBackend | undefined;
  readonly provider: ProviderName;
  readonly model: string;
  readonly sessionId: string;
  readonly subscriptionTier: AuthSubscriptionTier;
}): Promise<ResolvedAuthModelSelection> {
  if (
    params.authBackend === undefined ||
    !isHostedAgencProvider(params.provider)
  ) {
    return {
      provider: params.provider,
      model: params.model,
      profileProvider: params.provider,
      profileModel: params.model,
    };
  }
  assertHostedAgencSubscriptionAuthority({
    provider: params.provider,
    authBackend: params.authBackend,
    subscriptionTier: params.subscriptionTier,
  });
  const inferred = await params.authBackend.inferAgencModel({
    provider: params.provider,
    requestedModel: params.model,
    sessionId: params.sessionId,
    subscriptionTier: params.subscriptionTier,
  });
  const inferredProvider = resolveBuiltInProviderSlug(inferred.provider);
  const inferredModel = firstNonEmptyString(inferred.model);
  if (inferredModel === undefined) {
    throw new Error("AuthBackend model inference returned an empty model");
  }
  return {
    provider: params.provider,
    model: params.model,
    profileProvider:
      inferredProvider !== undefined && inferredProvider !== "agenc"
        ? inferredProvider
        : params.provider,
    profileModel: inferredModel,
  };
}

function parseWorkerEpoch(env: NodeJS.ProcessEnv): number | null {
  const raw = env.AGENC_WORKER_EPOCH;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

async function writeStartupInternalEvent(params: {
  readonly sessionBaseUrl: string;
  readonly headers: Record<string, string>;
  readonly environment: ProviderEnvironment;
  readonly workerEpoch: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly options?: {
    readonly isCompaction?: boolean;
    readonly agentId?: string;
  };
}): Promise<void> {
  const response = await fetch(
    `${params.sessionBaseUrl}/worker/internal-events`,
    {
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
            ...(params.options?.agentId
              ? { agent_id: params.options.agentId }
              : {}),
          },
        ],
      }),
      ...getProxyFetchOptions({ environment: params.environment }),
    },
  );

  if (!response.ok) {
    throw new Error(`startup internal event POST failed: ${response.status}`);
  }
}

async function registerStartupSessionIngress(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly requestEnvironment: ProviderEnvironment;
  readonly conversationId: string;
}): Promise<void> {
  const baseUrl = params.env.SESSION_INGRESS_URL?.trim();
  if (!baseUrl) {
    return;
  }

  const [sessionIngressAuthMod, sessionStorageMod] = await Promise.all([
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

  const sessionBaseUrl = buildCodeSessionBaseUrl(
    baseUrl,
    params.conversationId,
  );
  sessionStorageMod.setInternalEventReader(
    () =>
      fetchStartupInternalEvents({
        sessionBaseUrl,
        headers: authHeaders,
        environment: params.requestEnvironment,
      }),
    () =>
      fetchStartupInternalEvents({
        sessionBaseUrl,
        headers: authHeaders,
        environment: params.requestEnvironment,
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
      environment: params.requestEnvironment,
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
  "token_count",
  "agent_message",
  "agent_message_delta",
  "agent_thinking",
  "assistant_thinking_block_start",
  "assistant_thinking_delta",
  "assistant_thinking_block_stop",
  "tool_input_block_start",
  "tool_input_delta",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "tool_call_started",
  "tool_call_completed",
  "tool_progress",
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
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
 * Map operator `max_turns` (schema / TOML) onto turn-loop `maxTurns`.
 * Exported so tests can prove the mapping without booting a full session.
 */
export function maxTurnsFromAgenCConfig(
  config: Pick<AgenCConfig, "max_turns">,
): number | undefined {
  if (
    typeof config.max_turns === "number" &&
    Number.isFinite(config.max_turns) &&
    config.max_turns > 0
  ) {
    return config.max_turns;
  }
  return undefined;
}

/** Map the canonical per-session cost cap onto the live turn configuration. */
export function maxBudgetUsdFromAgenCConfig(
  config: Pick<AgenCConfig, "max_budget_usd">,
): number | undefined {
  if (
    typeof config.max_budget_usd === "number" &&
    Number.isFinite(config.max_budget_usd) &&
    config.max_budget_usd > 0
  ) {
    return config.max_budget_usd;
  }
  return undefined;
}

/**
 * Structural `Config` shape for the live local-runtime session. The fields
 * below are the runtime-owned config snapshot consumed by the active shell.
 */
function buildDeferredConfig(
  cwd: string,
  model: string,
  config: AgenCConfig,
  agentDefinitions: readonly {
    readonly agentType: string;
    readonly whenToUse: string;
  }[],
  sandboxStatus?: ReturnType<SandboxExecutionBroker["status"]>,
): Config {
  const modelReasoningEffort = config.reasoning_effort;
  const maxTurns = maxTurnsFromAgenCConfig(config);
  const maxBudgetUsd = maxBudgetUsdFromAgenCConfig(config);
  return {
    model,
    ...(config.model_verbosity !== undefined
      ? { modelVerbosity: config.model_verbosity }
      : {}),
    ...(modelReasoningEffort !== undefined ? { modelReasoningEffort } : {}),
    ...(config.reasoning_summary !== undefined
      ? { modelReasoningSummary: config.reasoning_summary }
      : {}),
    ...(config.service_tier !== undefined
      ? { serviceTier: config.service_tier }
      : {}),
    ...(config.personality !== undefined
      ? { personality: config.personality }
      : {}),
    ...(config.autonomous_mode !== undefined
      ? { autonomousMode: config.autonomous_mode }
      : {}),
    ...(config.coordinator_mode !== undefined
      ? { coordinatorMode: config.coordinator_mode }
      : {}),
    // Snake config key → camel turn Config (todo-105). Unset = no iteration cap.
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(config.durableTurns !== undefined
      ? { durableTurns: config.durableTurns }
      : {}),
    ...(config.approvals_reviewer !== undefined
      ? { approvalsReviewer: config.approvals_reviewer }
      : {}),
    ...(config.agent_max_threads !== undefined
      ? { agent_max_threads: config.agent_max_threads }
      : {}),
    ...(config.agent_max_depth !== undefined
      ? { agent_max_depth: config.agent_max_depth }
      : {}),
    cwd,
    ...(sandboxStatus?.helperPath !== undefined
      ? { agencLinuxSandboxExe: sandboxStatus.helperPath }
      : {}),
    ...(sandboxStatus?.kind === "unavailable" &&
    sandboxStatus.reason !== undefined
      ? { sandboxUnavailableReason: sandboxStatus.reason }
      : {}),
    features: createManagedFeatures(),
    /** T9: `multiAgentV2` hints (subagent usage hints + metadata visibility). */
    multiAgentV2: {
      minWaitTimeoutMs: 10_000,
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    /**
     * Shell-policy defaults. Conservative values keep the shell tool from
     * picking up login-shell semantics unless explicit config enables them.
     */
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    /** T-future: ghost-snapshot state machine (agenc runtime workspace restore). */
    ghostSnapshot: { enabled: false },
    /** T9: exact session-owned executable agent catalog. */
    agentRoles: agentDefinitions.map((definition) => ({
      name: definition.agentType,
      description: definition.whenToUse,
    })),
  };
}

function createMemoryAutoSaveSidecar(): Sidecar {
  return {
    name: "memory-auto-save",
    onEvent: () => {
      // Memory extraction is not wired yet, but bootstrap must preserve the
      // sidecar registration point for consumers that inspect live services.
    },
  };
}

export interface BootstrapLocalRuntimeSessionOptions {
  readonly apiKey?: string;
  readonly authBackend?: AuthBackend;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Immutable operator policy supplied by a daemon/client boundary. */
  readonly runtimeOptions?: AgentRuntimeOptions;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly conversationId?: string;
  readonly resumeConversation?: boolean;
  /** Exact canonical JSONL selected by the trusted resume resolver. */
  readonly resumeRolloutPath?: string;
  readonly resumeRolloutLease?: ResumeRolloutDescriptorLease;
  /** Daemon-observed cwd inode identity for cold-resume swap defense. */
  readonly resumeCwdIdentity?: { readonly dev: string; readonly ino: string };
  readonly resumeCwdFd?: number;
  /** Explicitly continue a cleanly terminal canonical run under a new epoch. */
  readonly reopenTerminalConversation?: boolean;
  /** Explicitly resume a daemon-suspended run in its existing epoch. */
  readonly resumeSuspendedConversation?: boolean;
  /** Internal suspension disposition; never inferred from caller prose. */
  readonly suspendedResumeReason?: RunResumeReason;
  readonly toolRegistryOptions?: Omit<
    BuildToolRegistryOptions,
    "workspaceRoot"
  >;
  /** Production daemon entrypoints require a healthy boundary before startup. */
  readonly requireSandboxReadyAtStartup?: boolean;
  /** Shared daemon authority. Omit only for an independently owned session. */
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  /** Shared daemon authority. Omit only for an independently owned session. */
  readonly csvAgentJobsRepositories?: CsvAgentJobsRepositoryProvider;
  /**
   * Treat this session as unattended work for execution-admission budget
   * policy without enabling autonomous keepalive ticks. Daemon-owned
   * background sessions set this explicitly; interactive sessions inherit
   * the ordinary `--autonomous`/config mode.
   */
  readonly executionAdmissionAutonomous?: boolean;
  /**
   * Delay configured SessionStart commands until the first non-Editor submit.
   * Daemon agents use this when their atomic first turn carries an Editor
   * read-only/proposal-only policy.
   */
  readonly deferSessionStartHooks?: boolean;
  /**
   * Delay configured MCP processes, durable cron/job resumption, and startup
   * prewarm until the first non-Editor submit.
   */
  readonly deferAgentStartupSideEffects?: boolean;
  /** Stable calendar-budget identity; daemon agents default to their run id. */
  readonly executionAdmissionBudgetIdentity?: string;
}

export interface LocalRuntimeBootstrap {
  readonly agencHome: string;
  readonly configStore: ConfigStore;
  /** Configured least-privilege policy captured before mode overrides. */
  readonly configuredExecutionAuthority: SessionExecutionAuthority;
  /** Stage a configured baseline for the registry publication transaction. */
  readonly prepareConfiguredExecutionAuthority: (
    config: AgenCConfig,
  ) => PreparedConfiguredExecutionAuthority;
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
  readonly authSubscriptionTier: AuthSubscriptionTier;
  readonly memoryDir: string;
  readonly memoryMdPath: string;
  readonly shutdown: () => Promise<void>;
  readonly autonomousModeEnabled: boolean;
}

export interface PreparedConfiguredExecutionAuthority {
  readonly authority: SessionExecutionAuthority;
  commit(): void;
  rollback(): void;
}

async function waitForPartialMcpDisposal(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `partial MCP disposal exceeded ${SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS}ms`,
          ),
        ),
      SESSION_LIFECYCLE_SHUTDOWN_BUDGET_MS,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parsePositiveFileIdentity(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`cold-resume workspace ${label} identity is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`cold-resume workspace ${label} identity is invalid`);
  }
  return parsed;
}

function assertPinnedResumeCwd(
  options: BootstrapLocalRuntimeSessionOptions,
  workspaceRoot: string,
): void {
  if (
    (options.resumeCwdIdentity === undefined) !==
    (options.resumeCwdFd === undefined)
  ) {
    throw new Error(
      "cold-resume workspace identity and descriptor must be provided together",
    );
  }
  if (
    options.resumeCwdIdentity === undefined ||
    options.resumeCwdFd === undefined
  ) {
    return;
  }
  const expectedDev = parsePositiveFileIdentity(
    options.resumeCwdIdentity.dev,
    "device",
  );
  const expectedIno = parsePositiveFileIdentity(
    options.resumeCwdIdentity.ino,
    "inode",
  );
  if (!hasSupportedFileIdentity({ dev: expectedDev, ino: expectedIno })) {
    throw new Error("cold-resume workspace file identity is unsupported");
  }
  const opened = fstatSync(options.resumeCwdFd, { bigint: true });
  const observed = lstatSync(workspaceRoot, { bigint: true });
  if (
    !opened.isDirectory() ||
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    !hasSupportedFileIdentity(opened) ||
    !hasSupportedFileIdentity(observed) ||
    opened.dev !== expectedDev ||
    opened.ino !== expectedIno ||
    observed.dev !== expectedDev ||
    observed.ino !== expectedIno ||
    realpathSync(workspaceRoot) !== workspaceRoot
  ) {
    throw new Error(
      "cold-resume workspace identity changed after authorization",
    );
  }
}

function snapshotGrokAcpChildEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const childEnvironment = scrubEnvForChildProcess(environment);
  delete childEnvironment.AGENC_GROK_CLI;
  delete childEnvironment.AGENC_GROK_ACP_PERMISSIONS;
  return Object.freeze(childEnvironment);
}

export async function bootstrapLocalRuntimeSession(
  options: BootstrapLocalRuntimeSessionOptions,
): Promise<LocalRuntimeBootstrap> {
  const env = { ...(options.env ?? process.env) };
  const providerEnvironment = snapshotProviderEnvironment(env);
  const mcpRequestEnvironment = snapshotMcpRequestEnvironment(env);
  const argv = options.argv ?? process.argv;
  const cli = readStartupCliFlags(argv);
  const parsedRuntimeOptions =
    options.runtimeOptions ??
    resolveAgentRuntimeOptions(env, {
      simpleMode: cli.simpleMode === true,
      dangerouslyBypassApprovalsAndSandbox:
        cli.dangerouslyBypassApprovalsAndSandbox === true,
    });
  const commandShellPath = await findSuitableShell(parsedRuntimeOptions, env);
  const commandExecutionAuthority = resolveCommandExecutionAuthority(
    parsedRuntimeOptions,
    commandShellPath,
    subprocessEnv(env),
  );
  const runtimeOptions = Object.freeze({
    ...parsedRuntimeOptions,
    posixShellPath: commandExecutionAuthority.path,
  });
  return runWithAgentRuntimeOptions(runtimeOptions, () =>
    bootstrapLocalRuntimeSessionScoped({
      ...options,
      env,
      providerEnvironment,
      mcpRequestEnvironment,
      cli,
      runtimeOptions,
      commandExecutionAuthority,
    })
  );
}

async function bootstrapLocalRuntimeSessionScoped(
  options: BootstrapLocalRuntimeSessionOptions & {
    readonly env: NodeJS.ProcessEnv;
    readonly providerEnvironment: ReturnType<typeof snapshotProviderEnvironment>;
    readonly mcpRequestEnvironment: ReturnType<typeof snapshotMcpRequestEnvironment>;
    readonly cli: StartupCliFlags;
    readonly runtimeOptions: AgentRuntimeOptions;
    readonly commandExecutionAuthority: ReturnType<
      typeof resolveCommandExecutionAuthority
    >;
  },
): Promise<LocalRuntimeBootstrap> {
  const env = options.env ?? process.env;
  const providerEnvironment = options.providerEnvironment;
  const mcpRequestEnvironment = options.mcpRequestEnvironment;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const agencHome = resolveAgencHomeFromEnv(env);
  // The explicit per-session cwd must beat AGENC_WORKSPACE: in the daemon,
  // `env` is the process env frozen at daemon start, and a stale
  // AGENC_WORKSPACE from the first launch shell would pin every later
  // session to that folder (audit finding #2). Matches the
  // precedence already used by project-trust resolution.
  const requestedWorkspaceRoot =
    options.cwd ?? resolveWorkspaceFromEnv(env) ?? process.cwd();
  const canonicalWorkspace = resolveCanonicalSessionCwd(requestedWorkspaceRoot);
  const workspaceRoot =
    canonicalWorkspace.kind === "ok"
      ? canonicalWorkspace.cwd
      : requestedWorkspaceRoot;
  assertPinnedResumeCwd(options, workspaceRoot);
  const profileName = resolvedStartupProfileName(options.cli, env);
  const configStore = new ConfigStore({
    home: agencHome,
    cwd: workspaceRoot,
    env,
    retainUntrustedProjectCommandHooks:
      options.runtimeOptions.allowUntrustedHooks,
    ...startupConfigLayerOptions({
      cli: options.cli,
      cwd: workspaceRoot,
    }),
  });
  await configStore.reload();
  const startup = resolveCanonicalStartupSelection({
    config: configStore.current(),
    ...(profileName !== undefined ? { profileName } : {}),
  });
  const cli = options.cli;
  const runtimeOptions = options.runtimeOptions;
  const sessionMcpRequestEnvironment =
    snapshotMcpRequestEnvironmentForAuthority(mcpRequestEnvironment, {
      agencHome: configStore.homeContext.path,
      pluginStorageRoot: runtimeOptions.pluginStorageRoot,
    });
  const sessionTempRoot = runtimeOptions.sessionTempRoot;
  const autonomousModeEnabled =
    cli.autonomousMode === true || startup.config.autonomous_mode === true;
  const executionAdmissionAutonomous =
    options.executionAdmissionAutonomous ?? autonomousModeEnabled;
  const conversationId =
    options.conversationId ?? `conv-${Date.now().toString(36)}`;
  const resumeConversation =
    options.conversationId !== undefined &&
    options.resumeConversation !== false;
  if (options.reopenTerminalConversation === true && !resumeConversation) {
    throw new Error(
      "terminal conversation reopen requires an explicit conversation id",
    );
  }
  if (options.resumeSuspendedConversation === true && !resumeConversation) {
    throw new Error(
      "suspended conversation resume requires an explicit conversation id",
    );
  }
  if (
    options.reopenTerminalConversation === true &&
    options.resumeSuspendedConversation === true
  ) {
    throw new Error(
      "terminal conversation reopen and suspended resume are mutually exclusive",
    );
  }

  const projectTrust = resolveProjectTrustStateSync({
    agencHome,
    env,
    cwd: workspaceRoot,
    projectRootMarkers: startup.config.project_root_markers,
  });
  const executionProjectTrust = (
    config: AgenCConfig,
    cwd: string,
  ) => resolveProjectTrustStateSync({
    agencHome,
    env,
    cwd,
    projectRootMarkers: config.project_root_markers,
  });
  let configuredExecutionConfig = startup.config;
  let configuredExecutionAuthorityCwd = workspaceRoot;
  let configuredExecutionAuthorityProjectTrust = projectTrust;
  let configuredExecutionAuthority =
    sessionExecutionAuthorityFromAgenCConfig({
      config: configuredExecutionConfig,
      workspaceRoot: configuredExecutionAuthorityCwd,
      projectTrust,
    });
  const currentConfiguredExecutionAuthority = (): SessionExecutionAuthority => {
    const currentCwd = sandboxExecutionBroker.cwd;
    const currentProjectTrust = executionProjectTrust(
      configuredExecutionConfig,
      currentCwd,
    );
    if (
      configuredExecutionAuthorityCwd === currentCwd &&
      configuredExecutionAuthorityProjectTrust === currentProjectTrust
    ) {
      return configuredExecutionAuthority;
    }
    configuredExecutionAuthority = sessionExecutionAuthorityFromAgenCConfig({
      config: configuredExecutionConfig,
      workspaceRoot: currentCwd,
      projectTrust: currentProjectTrust,
    });
    configuredExecutionAuthorityCwd = currentCwd;
    configuredExecutionAuthorityProjectTrust = currentProjectTrust;
    return configuredExecutionAuthority;
  };
  const prepareConfiguredExecutionAuthority = (
    canonicalConfig: AgenCConfig,
  ): PreparedConfiguredExecutionAuthority => {
    const previousConfig = configuredExecutionConfig;
    const previous = currentConfiguredExecutionAuthority();
    const previousProjectTrust = configuredExecutionAuthorityProjectTrust;
    const preparedCwd = sandboxExecutionBroker.cwd;
    const preparedProjectTrust = executionProjectTrust(
      canonicalConfig,
      preparedCwd,
    );
    const authority = sessionExecutionAuthorityFromAgenCConfig({
      config: canonicalConfig,
      workspaceRoot: preparedCwd,
      projectTrust: preparedProjectTrust,
    });
    let committed = false;
    return Object.freeze({
      authority,
      commit: () => {
        if (configuredExecutionConfig !== previousConfig && !committed) {
          throw new Error(
            "configured execution authority changed before staged commit",
          );
        }
        if (sandboxExecutionBroker.cwd !== preparedCwd && !committed) {
          throw new Error(
            "configured execution authority cwd changed before staged commit",
          );
        }
        if (
          executionProjectTrust(canonicalConfig, preparedCwd) !==
            preparedProjectTrust &&
          !committed
        ) {
          throw new Error(
            "configured execution authority trust changed before staged commit",
          );
        }
        configuredExecutionConfig = canonicalConfig;
        configuredExecutionAuthority = authority;
        configuredExecutionAuthorityCwd = preparedCwd;
        configuredExecutionAuthorityProjectTrust = preparedProjectTrust;
        committed = true;
      },
      rollback: () => {
        if (!committed) return;
        if (configuredExecutionConfig !== canonicalConfig) {
          throw new Error(
            "configured execution authority changed before staged rollback",
          );
        }
        configuredExecutionConfig = previousConfig;
        const currentCwd = sandboxExecutionBroker.cwd;
        const currentProjectTrust = executionProjectTrust(
          previousConfig,
          currentCwd,
        );
        configuredExecutionAuthority =
          currentCwd === preparedCwd &&
            currentProjectTrust === previousProjectTrust
            ? previous
            : sessionExecutionAuthorityFromAgenCConfig({
                config: previousConfig,
                workspaceRoot: currentCwd,
                projectTrust: currentProjectTrust,
              });
        configuredExecutionAuthorityCwd = currentCwd;
        configuredExecutionAuthorityProjectTrust = currentProjectTrust;
        committed = false;
      },
    });
  };
  const permissionInit = await initializeToolPermissionContext({
    env: {
      home: agencHome,
      cwd: workspaceRoot,
      configStore,
    },
    providerEnvironment,
    ...(cli.permissionMode ? { permissionMode: cli.permissionMode } : {}),
    ...(runtimeOptions.dangerouslyBypassApprovalsAndSandbox
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    projectTrust,
  });
  const autoModeEnabled =
    permissionInit.toolPermissionContext.isAutoModeAvailable === true &&
    isAutoModeGateEnabled(providerEnvironment);
  let toolPermissionContext: ToolPermissionContext = {
    ...permissionInit.toolPermissionContext,
    isAutoModeAvailable: autoModeEnabled,
    ...(permissionInit.toolPermissionContext.mode === "auto" && !autoModeEnabled
      ? { mode: "default" as const, autoModeActive: false }
      : {}),
  };
  const initialSandboxExecutionAuthority =
    sandboxExecutionBrokerAuthorityFromSessionAuthority(
      executionAuthorityForPermissionContext(
        configuredExecutionAuthority,
        toolPermissionContext,
        runtimeOptions.dangerouslyBypassApprovalsAndSandbox,
      ),
      workspaceRoot,
    );
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    mode: initialSandboxExecutionAuthority.mode,
    cwd: workspaceRoot,
    env,
    sessionTempRoot,
    ...(initialSandboxExecutionAuthority.permissionProfile !== undefined
      ? {
          permissionProfile:
            initialSandboxExecutionAuthority.permissionProfile,
        }
      : {}),
    windowsSandboxLevel:
      initialSandboxExecutionAuthority.windowsSandboxLevel,
    allowGpu: initialSandboxExecutionAuthority.allowGpu,
  });
  if (options.requireSandboxReadyAtStartup === true) {
    sandboxExecutionBroker.assertReady("startup");
  }
  const permissionModeRegistry = new PermissionModeRegistry(
    toolPermissionContext,
  );
  const toolApprovals = new RuntimeApprovalStore<unknown>();
  const networkApproval = new RuntimeNetworkApprovalService();
  const authSubscriptionTier = await resolveAuthSubscriptionTier(
    options.authBackend,
    conversationId,
  );
  const localByokAuthBackend = new LocalAuthBackend({ agencHome, env });
  const modelSelection = await resolveAuthModelSelection({
    authBackend: options.authBackend,
    provider: startup.provider,
    model: startup.model,
    sessionId: conversationId,
    subscriptionTier: authSubscriptionTier,
  });
  const resolvedProvider = modelSelection.provider;
  const providerModel = modelSelection.model;
  return runWithStartupProviderSelection({
    provider: resolvedProvider,
    model: providerModel,
    environment: env,
  }, async () => {
  const profileProvider = modelSelection.profileProvider;
  const model = modelSelection.profileModel;
  const initialTransportRequest = resolveProviderRuntimeRequest({
    provider: resolvedProvider,
    model: providerModel,
    config: startup.config,
    environment: providerEnvironment,
    credentialHome: configStore.homeContext,
    executionAdmissionRequired: true,
  });
  const providerSettings = profileProvider === resolvedProvider
    ? initialTransportRequest.settings
    : resolveProviderRuntimeRequest({
        provider: profileProvider,
        model,
        config: startup.config,
        environment: providerEnvironment,
      }).settings;
  const selectedBaseURL = initialTransportRequest.requested.baseURL;
  const mcpManager = createSessionMcpManager([], {
    environment: sessionMcpRequestEnvironment,
    sandboxExecutionBroker,
  });
  const commandExecutionAuthority = options.commandExecutionAuthority;
  const grokAcpChildEnvironment = snapshotGrokAcpChildEnvironment(
    commandExecutionAuthority.childEnvironment,
  );
  const unifiedExecManager = new UnifiedExecProcessManager({
    cwd: workspaceRoot,
    baseEnv: env,
    shellPath: commandExecutionAuthority.path,
    commandWrapperArgv: commandExecutionAuthority.commandWrapperArgv,
  });
  const unifiedExecLifecycleParticipantName = "unified-exec-manager";
  let unifiedExecQuiesceToken:
    | UnifiedExecSandboxAuthorityQuiesceToken
    | undefined;
  registerSandboxExecutionLifecycleParticipant(sandboxExecutionBroker, {
    name: unifiedExecLifecycleParticipantName,
    quiesce: async () => {
      const token = unifiedExecManager.beginSandboxAuthorityQuiesce();
      unifiedExecQuiesceToken = token;
      await unifiedExecManager.finishSandboxAuthorityQuiesce(token);
    },
    resume: async () => {
      sandboxExecutionBroker.assertLifecycleParticipantResumePermit(
        unifiedExecLifecycleParticipantName,
      );
      const token = unifiedExecQuiesceToken;
      if (token === undefined) {
        throw new Error("unified exec lifecycle resume has no quiesce token");
      }
      unifiedExecManager.resumeSandboxAuthorityAfterQuiesce(token);
      unifiedExecQuiesceToken = undefined;
    },
    dispose: async () => {
      const token = unifiedExecManager.beginSandboxAuthorityQuiesce();
      unifiedExecQuiesceToken = token;
      await unifiedExecManager.finishSandboxAuthorityQuiesce(token);
    },
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
  const emitProviderDiagnostic = (_diagnostic: {
    cause: string;
    message: string;
  }): void => {
    // Keep provider request-shape diagnostics out of warning/error streams.
  };
  const { isCoordinatorModeEnabled, LIVE_COORDINATOR_ALLOWED_TOOLS } =
    await import("../coordinator/coordinatorMode.js");
  const coordinatorModeEnabled = isCoordinatorModeEnabled(
    startup.config.coordinator_mode,
  );
  const roleWorkspace = createAgentRoleWorkspace(workspaceRoot);
  const agentDefinitions = await loadFreshAgentDefinitions(
    roleWorkspace.cwd,
    runtimeOptions.pluginStorageRoot,
  );
  const roleCatalog = new AgentRoleCatalog(roleWorkspace, agentDefinitions);
  const ownedCsvAgentJobsRepositories =
    options.csvAgentJobsRepositories === undefined
      ? new CsvAgentJobsRepositoryAuthority({ agencHome })
      : null;
  const csvAgentJobsRepositories =
    options.csvAgentJobsRepositories ?? ownedCsvAgentJobsRepositories!;
  const baseToolsConfig =
    options.toolRegistryOptions?.toolsConfig ?? startup.config.tools_config;
  const registry = buildBootstrapToolRegistry({
    workspaceRoot,
    agencHome,
    environment: providerEnvironment,
    mcpManager,
    getSession: () => sessionRef,
    roleCatalog,
    csvAgentJobsRepositories,
    emitWarning: emitProviderWarning,
    toolRegistryOptions: {
      ...(options.toolRegistryOptions ?? {}),
      unifiedExecManager,
      sandboxExecutionBroker,
      codeModeService,
      ...(startup.config.browser !== undefined
        ? { browserConfig: startup.config.browser }
        : {}),
      // Coordinator mode restricts the LIVE surface to orchestration +
      // user-interaction tools: the coordinator directs workers, it
      // does not edit files or run commands itself.
      toolsConfig: coordinatorModeEnabled
        ? {
            ...(baseToolsConfig ?? {}),
            enabled_tools: [...LIVE_COORDINATOR_ALLOWED_TOOLS],
          }
        : baseToolsConfig,
      // G1/G3 Hermes-style catalog gates: pass session provider + host so
      // XSearch / ImagineImage are not advertised to Claude/GPT/OpenRouter.
      ...(startup.config.providers?.grok !== undefined
        ? { grokCapabilities: startup.config.providers.grok }
        : {}),
      sessionProvider: resolvedProvider,
      ...(selectedBaseURL !== undefined
        ? { sessionBaseURL: selectedBaseURL }
        : {}),
    },
  });
  const resolveProviderPreparationRequest = async (selection: {
    readonly provider: string;
    readonly model: string;
  }) => {
    const provider = resolveBuiltInProviderSlug(selection.provider);
    if (provider === undefined) {
      throw new Error(`unknown provider "${selection.provider}"`);
    }
    const currentConfig = configStore.current();
    const settingsRequest = resolveProviderRuntimeRequest({
      provider,
      model: selection.model,
      config: currentConfig,
      environment: providerEnvironment,
      credentialHome: configStore.homeContext,
      executionAdmissionRequired: true,
    });
    const runtimeRequest = resolveProviderRuntimeRequest({
      provider,
      model: selection.model,
      config: currentConfig,
      environment: providerEnvironment,
      credentialHome: configStore.homeContext,
      tools: registry.toLLMTools(),
      executionAdmissionRequired: true,
      baseExtra: {
        ...(provider === "grok" && isGrokComposerModel(selection.model)
          ? {
              grokAcp: {
                environment: grokAcpChildEnvironment,
              },
            }
          : {}),
        emitWarning: emitProviderWarning,
        emitDiagnostic: emitProviderDiagnostic,
        onCapabilityDrift: (warning: {
          message: string;
          status?: number;
        }): void => {
          markCapabilityDrift({
            provider,
            model: selection.model,
            overrides: settingsRequest.settings?.capabilityOverrides,
          });
          emitProviderWarning({
            cause: "capability_drift_detected",
            message:
              warning.status !== undefined
                ? `${provider}/${selection.model} rejected a capability the registry claimed it supported (HTTP ${warning.status}): ${warning.message}`
                : `${provider}/${selection.model} rejected a capability the registry claimed it supported: ${warning.message}`,
          });
        },
        fetchImpl,
        sandboxExecutionBroker,
      },
    });
    const explicitApiKey =
      provider === resolvedProvider
        ? firstNonEmptyString(options.apiKey)
        : undefined;
    return {
      requested: {
        ...runtimeRequest.requested,
        ...(explicitApiKey !== undefined ? { apiKey: explicitApiKey } : {}),
      },
      runtime: {
        managedKeysEnabled: resolveAuthManagedKeysEnabled(currentConfig),
        freeManagedCredential:
          authSubscriptionTier === "free" &&
          isFreeSubscriptionManagedModel(provider, selection.model),
        applyManagedDefaultOutputCap:
          provider === "openrouter" &&
          runtimeRequest.settings?.maxOutputTokens === undefined,
      },
    };
  };
  const initialPreparation = await resolveProviderPreparationRequest({
    provider: resolvedProvider,
    model: providerModel,
  });
  const initialAuthority = await resolveProviderRuntimeAuthority(
    resolvedProvider,
    initialPreparation.requested,
    providerEnvironment,
    {
      readSavedApiKey: (provider) =>
        localByokAuthBackend.readByokKey(provider),
      ...(options.authBackend !== undefined
        ? { authBackend: options.authBackend }
        : {}),
      sessionId: conversationId,
      subscriptionTier: authSubscriptionTier,
      ...initialPreparation.runtime,
    },
  );
  requireProviderRuntimeCredential(resolvedProvider, initialAuthority);
  const hasManagedCredential = initialAuthority.managedCredential;
  const provider: LLMProvider = createProvider(
    resolvedProvider,
    initialAuthority.factoryOptions,
  );
  const capabilityEntry = resolveProviderCapabilityEntry({
    provider: profileProvider,
    model,
    overrides: providerSettings?.capabilityOverrides,
  });
  const providerHealthCheck = provider.healthCheck;
  if (
    !hasManagedCredential &&
    shouldProbeCapabilityEntry(capabilityEntry) &&
    typeof providerHealthCheck === "function"
  ) {
    queueMicrotask(() => {
      void providerHealthCheck
        .call(provider)
        .then((healthy) => {
          if (!healthy) return;
          markCapabilityVerified({
            provider: profileProvider,
            model,
          });
        })
        .catch(() => {
          // Best-effort T13 capability revalidation probe.
        });
    });
  }
  const config = buildDeferredConfig(
    workspaceRoot,
    model,
    {
      ...startup.config,
      autonomous_mode: autonomousModeEnabled,
      coordinator_mode: coordinatorModeEnabled,
    },
    agentDefinitions.activeAgents,
    sandboxExecutionBroker.status(),
  );
  const modelsManager = new StaticModelsManager({
    config: startup.config,
    fallbackProvider: profileProvider,
    metadata: {
      fetchImpl,
      env,
      onWarn: (message) =>
        emitProviderWarning({
          cause: "model_token_limit_config",
          message,
        }),
    },
  });
  const rawModelInfo = await modelsManager.getModelInfo(model);
  const modelInfo =
    hasManagedCredential &&
    initialPreparation.runtime.applyManagedDefaultOutputCap
      ? {
          ...rawModelInfo,
          maxOutputTokens: MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
          maxOutputTokensUpperLimit:
            rawModelInfo.maxOutputTokensUpperLimit !== undefined
              ? Math.min(
                  rawModelInfo.maxOutputTokensUpperLimit,
                  MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
                )
              : MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
          maxOutputTokensCappedDefault: true,
        }
      : rawModelInfo;
  const configuredSessionConfiguration = {
    ...sessionConfigurationFromAgenCConfig({
      config: startup.config,
      workspaceRoot,
      model,
      provider: resolvedProvider,
      projectTrust,
    }),
  } satisfies SessionConfiguration;
  const authorizedSessionConfiguration = applySessionExecutionAuthority(
    configuredSessionConfiguration,
    executionAuthorityForPermissionContext(
      configuredExecutionAuthority,
      toolPermissionContext,
      runtimeOptions.dangerouslyBypassApprovalsAndSandbox,
    ),
  );
  const promptContext = buildTurnContext({
    conversationId,
    subId: "bootstrap-system-prompt",
    config: { ...config, model: providerModel },
    modelInfo: { ...modelInfo, slug: providerModel },
    provider,
    sessionConfiguration: authorizedSessionConfiguration,
    permissionMode: toolPermissionContext.mode,
  });
  const baseInstructions = await assembleBaseInstructionsForModel({
    session: {
      services: {
        runtimeOptions,
        sandboxExecutionBroker,
      },
    },
    ctx: promptContext,
    registry,
    provider: resolvedProvider,
    permissionContext: toolPermissionContext,
    profile: coordinatorModeEnabled
      ? "coordinator"
      : usesLocalToolProfile(resolvedProvider)
        ? "compact"
        : "standard",
  });
  const sessionConfiguration = {
    ...authorizedSessionConfiguration,
    baseInstructions,
  } satisfies SessionConfiguration;
  let initialState: SessionState = {
    sessionConfiguration,
    history: [],
    ...(resumeConversation
      ? { pendingSessionStartSource: "resume" as const }
      : {}),
  };
  let initialTranscriptEvents: readonly BootstrapTranscriptEvent[] = [];
  let initialMessages: ReadonlyArray<EventMsg> = [];

  const sessionProjectRootMarkers = startup.config.project_root_markers;
  const ownedExecutionAdmissionKernel =
    options.executionAdmissionKernel === undefined
      ? new ExecutionAdmissionKernel({
          agencHome,
          limits: resolveAdmissionConcurrencyLimits(env, {
            sessionLimit: startup.config.agent_max_threads,
          }),
        })
      : null;
  const executionAdmissionKernel =
    options.executionAdmissionKernel ?? ownedExecutionAdmissionKernel!;
  const executionAdmission = executionAdmissionKernel.bindClient({
    cwd: workspaceRoot,
    ...(options.executionAdmissionBudgetIdentity !== undefined
      ? { budgetIdentity: options.executionAdmissionBudgetIdentity }
      : options.executionAdmissionAutonomous !== undefined
        ? { budgetIdentity: conversationId }
        : {}),
    ...(sessionProjectRootMarkers !== undefined
      ? { projectRootMarkers: sessionProjectRootMarkers }
      : {}),
    scope: {
      runId: conversationId,
      sessionId: conversationId,
      autonomous: executionAdmissionAutonomous,
    },
    budget: resolveExecutionAdmissionBudgetPolicy({
      budget: startup.config.budget,
      agentBudget: startup.config.agent?.budget,
      autonomous: executionAdmissionAutonomous,
    }),
  });
  const memoryDir = join(agencHome, "memory");
  const memoryMdPath = join(memoryDir, "MEMORY.md");
  let sidecarManager: SidecarManager | null = null;
  let clearActiveCostSidecar: (() => void) | null = null;
  let shutdownTask: Promise<void> | null = null;
  let shutdownComplete = false;
  let shutdownPrepared = false;
  let bootstrapServicesStopped = false;
  // Lifecycle slots filled by the bootstrapSession hooks. The shutdown
  // closure closes over these `let` bindings so it is safe to call at
  // any point in the bootstrap lifecycle, including partial-failure
  // paths where onBeforeSessionConfigured aborts before the session or
  // agent control plane is fully wired.
  let sessionForShutdown: Session | null = null;
  let agentControlForShutdown: AgentControl | null = null;
  let rolloutStoreForReturn: RolloutStore | null = null;
  let ctxForReturn: TurnContext | null = null;
  const mcpService = createSessionMcpService(mcpManager, {
    authority: configStore,
    environment: sessionMcpRequestEnvironment,
    pluginStorageRoot: options.runtimeOptions.pluginStorageRoot,
  });
  const bootstrapServices: BootstrapSessionServicesHandle =
    buildBootstrapSessionServices({
      provider,
      providerName: resolvedProvider,
      ...(options.authBackend !== undefined
        ? { authBackend: options.authBackend }
        : {}),
      authSubscriptionTier,
      registry,
      mcpManager: mcpService,
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
      readSavedApiKey: (provider) =>
        localByokAuthBackend.readByokKey(provider),
      resolveProviderPreparationRequest,
      sessionConfiguration,
      runtimeOptions,
      commandExecutionAuthority,
      codeModeService,
      sandboxExecutionBroker,
      executionAdmission,
      admissionRequired: true,
    });

  const shutdown = (): Promise<void> => {
    if (shutdownComplete) return Promise.resolve();
    if (shutdownTask !== null) return shutdownTask;
    // Close startup admission synchronously. The task body intentionally
    // begins on a microtask, and sidecar stop may await; neither may leave a
    // window where a late submit can activate MCP/cron/job startup.
    sessionForShutdown?.beginShutdown();
    let partialMcpDisposeTask: Promise<void> | undefined;
    if (sessionForShutdown === null) {
      try {
        partialMcpDisposeTask = mcpService.dispose?.();
        void partialMcpDisposeTask?.catch(() => undefined);
      } catch (error) {
        partialMcpDisposeTask = Promise.reject(error);
        void partialMcpDisposeTask.catch(() => undefined);
      }
    }

    const task = Promise.resolve().then(async (): Promise<void> => {
      const errors: unknown[] = [];
      if (!shutdownPrepared) {
        shutdownPrepared = true;
        if (sessionForShutdown !== null) {
          clearCurrentRuntimeSession(sessionForShutdown);
        }
        if (sidecarManager !== null) {
          await sidecarManager.stop().catch(() => {
            /* best effort */
          });
        }
        clearActiveCostSidecar?.();
        clearActiveCostSidecar = null;
        try {
          const { shutdownCsvJobRecoverySupervisor } =
            await import("./model-facing-tools.js");
          await shutdownCsvJobRecoverySupervisor({
            workspaceRoot,
            csvAgentJobsRepositories,
          });
        } catch (error) {
          errors.push(error);
        }
        if (sessionForShutdown !== null) {
          await shutdownSessionLifecycle({
            session: sessionForShutdown,
            ...(agentControlForShutdown !== null
              ? { agentControl: agentControlForShutdown }
              : {}),
            mcpManager,
          }).catch(() => {
            /* best effort */
          });
        }
      }
      if (!bootstrapServicesStopped) {
        try {
          await bootstrapServices.shutdown();
          bootstrapServicesStopped = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (partialMcpDisposeTask !== undefined) {
        try {
          await waitForPartialMcpDisposal(partialMcpDisposeTask);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        // The ordinary MCP stop is fail-soft. Its broker participant retries
        // retained cleanup in strict mode before root shutdown can succeed.
        await disposeSandboxExecutionBroker(sandboxExecutionBroker);
      } catch (error) {
        errors.push(error);
      }
      if (ownedExecutionAdmissionKernel !== null) {
        try {
          ownedExecutionAdmissionKernel.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (ownedCsvAgentJobsRepositories !== null) {
        try {
          await ownedCsvAgentJobsRepositories.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "local runtime shutdown failed");
      }
      shutdownComplete = true;
    });
    shutdownTask = task;
    void task.then(
      () => {
        if (shutdownTask === task) shutdownTask = null;
      },
      () => {
        if (shutdownTask === task) shutdownTask = null;
      },
    );
    return task;
  };

  try {
    // Construct the session through `bootstrapSession` so shell
    // discovery, SessionConfigured emit, startup prewarm, and
    // resume-history recording all flow through the shared entry
    // point. The bin-specific orchestration (rollout mount, history
    // reconstruction, sidecar register, buildTurnContext, sidecar
    // start, MCP start) is threaded in via `onBeforeSessionConfigured`
    // / `onAfterSessionConfigured`. The bin path intentionally does
    // NOT pass `mcp` to `bootstrapSession` because upstream agenc runtime
    // starts the live MCP connection manager AFTER SessionConfigured
    // (session.rs:856-908); the `onAfterSessionConfigured` hook does
    // that work instead.
    const session = await bootstrapSession({
      conversationId,
      roleWorkspace,
      agentDefinitions,
      initialState,
      features: config.features,
      services: bootstrapServices.services,
      mcpManagerOwnership: "owned",
      jsRepl: { id: `repl-${conversationId}` },
      config,
      modelInfo,
      initialTranscriptEvents,
      enablePrewarm: false,
      ...(options.deferSessionStartHooks === true
        ? { deferSessionStartHooks: true }
        : {}),
      ...(options.deferAgentStartupSideEffects === true
        ? { deferOrdinaryStartup: true }
        : {}),
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
        const agentRegistry = new AgentRegistry({
          ...(startup.config.agent_max_threads !== undefined
            ? { maxThreads: startup.config.agent_max_threads }
            : {}),
        });
        const agentControl = new AgentControl({
          session: s,
          registry: agentRegistry,
          roleCatalog,
        });
        const threadManager = new ThreadManager({
          control: agentControl,
          registry: agentRegistry,
        });
        const conversationThreadManager = new ConversationThreadManager({
          threadManager,
        });
        // `bootstrapSession` runs the canonical startup prewarm after
        // SessionConfigured; registration only claims the root thread here.
        await conversationThreadManager.registerConversationRootSession(s, {
          prewarm: false,
        });
        agentControl.bindThreadManager(conversationThreadManager);
        agentControl.registerSessionRoot(conversationId);
        bindSessionAgentControl(s, {
          control: agentControl,
          registry: agentRegistry,
        });
        (
          s.services as {
            threadManager?: ThreadManager;
            conversationThreadManager?: ConversationThreadManager;
          }
        ).threadManager = conversationThreadManager;
        (
          s.services as {
            conversationThreadManager?: ConversationThreadManager;
          }
        ).conversationThreadManager = conversationThreadManager;
        agentControlForShutdown = agentControl;

        setCurrentRuntimeSession(s);
        // From here on the bootstrap tail resolves the ambient session;
        // in a multi-session daemon the module fallback refuses to guess,
        // so this async chain gets the session bound explicitly.
        enterCurrentRuntimeSessionScope(s);
        await registerStartupSessionIngress({
          env,
          requestEnvironment: providerEnvironment,
          conversationId,
        });

        // Reprove the daemon-held directory handle immediately before the
        // canonical rollout descriptor is claimed and any resumed writer is
        // activated.
        assertPinnedResumeCwd(options, workspaceRoot);
        const rolloutStore = new RolloutStore({
          cwd: workspaceRoot,
          sessionId: conversationId,
          agencVersion: VERSION,
          agencHome,
          sessionTempRoot,
          ...(resumeConversation ? { resume: true } : {}),
          ...(options.resumeRolloutPath !== undefined
            ? { resumeRolloutPath: options.resumeRolloutPath }
            : {}),
          ...(options.resumeRolloutLease !== undefined
            ? { resumeRolloutLease: options.resumeRolloutLease }
            : {}),
          ...(options.reopenTerminalConversation === true
            ? { reopenTerminalRun: true }
            : {}),
          ...(options.resumeSuspendedConversation === true
            ? {
                resumeSuspendedRun: true,
                suspendedResumeReason:
                  options.suspendedResumeReason ?? "explicit_continue",
              }
            : {}),
          ...(sessionProjectRootMarkers !== undefined
            ? { projectRootMarkers: sessionProjectRootMarkers }
            : {}),
        });
        rolloutStore.open({
          sessionId: conversationId,
          timestamp: new Date().toISOString(),
          cwd: workspaceRoot,
          originator: "agenc-cli",
          source: "interactive-root",
          agencVersion: VERSION,
          model,
          modelProvider: resolvedProvider,
        });
        s.mountRolloutStore(rolloutStore);
        rolloutStoreForReturn = rolloutStore;
        bootstrapServices.bindRolloutStore({
          session: s,
          rolloutStore,
          resume: resumeConversation,
          threadMetadata: {
            agentPath: "/root",
            sessionSource: "cli_main",
            approvalPolicy: sessionConfiguration.approvalPolicy.value,
            sandboxPolicy: sessionConfiguration.sandboxPolicy.value,
          },
        });

        // Resume must restore the canonical rollout coordinates before the
        // SQLite admission journal subscribes and catches up decisions that
        // landed while this Session was detached. Binding earlier either has
        // no store to persist into or allocates catch-up events from sequence
        // one, colliding with resumed history. These three boundaries are
        // intentionally fail-closed; continuing without the admission
        // projection would make later execution evidence incomplete.
        const existingItems = rolloutStore.readAll();
        s.eventLog.seedCanonicalHistory(
          existingItems.flatMap((item) =>
            item.type === "event_msg" ? [item.payload] : [],
          ),
        );
        bootstrapServices.bindSession(s);

        try {
          if (existingItems.length > 0) {
            const indexSnapshot = readIndexSnapshot(
              join(
                getProjectDir(
                  workspaceRoot,
                  sessionProjectRootMarkers,
                  agencHome,
                ),
                "sessions",
                conversationId,
                "index.json",
              ),
            );
            const replay =
              await conversationThreadManager.replayRolloutIntoSession(
                s,
                existingItems,
                {
                  emitSynthesized: true,
                  appendSynthesizedRollout: (item) =>
                    rolloutStore.appendRollout(item),
                  ...(indexSnapshot ? { indexSnapshot } : {}),
                },
              );
            const reconstruction = replay.reconstruction;
            initialState = replay.appliedState;
            initialTranscriptEvents = transcriptEventsFromRollout([
              ...existingItems,
              ...reconstruction.synthesizedEvents,
            ]);
            initialMessages = transcriptMessagesFrom(initialTranscriptEvents);
            s.setInitialTranscriptEvents(initialTranscriptEvents);
            copyPlanForResume(
              { sessionId: conversationId, agencHome },
              { sessionId: conversationId, agencHome },
              { messages: existingItems },
            );
            // Port of agenc runtime `Session::record_initial_history` resume
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
          agencHome,
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
        s.attachFileHistory(fileHistory);

        sidecarManager.register(
          new ErrorLogSidecar({
            projectDir,
            sessionId: conversationId,
          }),
        );

        const costSidecar = new CostSidecar({
          defaultModel: model,
          defaultProvider: resolvedProvider,
          exitSummary: {
            shouldPrint: () => process.env.AGENC_DISABLE_COST_SUMMARY !== "1",
          },
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
        (s.services as { costSidecar?: CostSidecar }).costSidecar = costSidecar;
        clearActiveCostSidecar?.();
        clearActiveCostSidecar = bindActiveCostSidecar(costSidecar);
        sidecarManager.register(costSidecar);
        sidecarManager.register(createMemoryAutoSaveSidecar());

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
        // earlier events. Mirrors agenc runtime `session.rs:750-751`: "Start
        // the watcher after SessionConfigured so it cannot emit
        // earlier events."
        if (sidecarManager !== null) {
          await sidecarManager.start(s.eventLog);
        }

        const activateAgentStartupSideEffects = async (): Promise<void> => {
          const startupSignal = s.services.mcpStartupCancellationToken.signal;
          const startupWasCancelled = (): boolean =>
            s.abortController.signal.aborted ||
            s.services.mcpStartupCancellationToken.isCancelled();
          const assertStartupActive = (): void => {
            if (startupWasCancelled()) {
              throw new Error("session startup was cancelled");
            }
          };

          // Start the MCP connection manager AFTER session_configured
          // has been emitted + persisted to rollout. For an Editor-first
          // daemon session this additionally waits for ordinary Agent
          // authority, because configured stdio servers are processes.
          assertStartupActive();
          await s.startMcpManager(mcpManager, {
            signal: startupSignal,
          });
          assertStartupActive();

          // Re-arm persisted cron jobs across restarts only once ordinary
          // Agent authority is active. These tasks are awaited so shutdown
          // can drain the retained startup promise before child teardown.
          const rearmPersistedCron = async (): Promise<void> => {
            assertStartupActive();
            try {
              const { readCronTasks } = await import("../utils/cronTasks.js");
              assertStartupActive();
              const persisted = await readCronTasks(workspaceRoot);
              assertStartupActive();
              if (persisted.length > 0) {
                const { startCronSchedulerRunner } =
                  await import("./model-facing-tools.js");
                assertStartupActive();
                await startCronSchedulerRunner({
                  conversationId: s.conversationId,
                  workspaceRoot,
                  signal: startupSignal,
                });
              }
            } catch {
              /* cron re-arm is best-effort; tools re-arm on next CronCreate */
            }
            assertStartupActive();
          };

          // Likewise, interrupted CSV jobs belong to the Agent surface, not
          // to a read-only/proposal-only Editor request.
          const resumeInterruptedJobs = async (): Promise<void> => {
            assertStartupActive();
            try {
              const { resumeInterruptedAgentJobs } =
                await import("./model-facing-tools.js");
              assertStartupActive();
              await resumeInterruptedAgentJobs({
                session: s,
                workspaceRoot,
                csvAgentJobsRepositories,
                signal: startupSignal,
              });
            } catch {
              /* resume is best-effort; jobs stay visible in the DB */
            }
            assertStartupActive();
          };
          // Keep the two recovery paths ordered. Besides making startup
          // deterministic, this leaves a cancellation checkpoint between
          // persisted cron I/O and job recovery, so shutdown cannot start a
          // new recovery branch after closing admission.
          await rearmPersistedCron();
          assertStartupActive();
          await resumeInterruptedJobs();
          assertStartupActive();

          // An Editor-first request itself warms the selected provider. Do
          // not run the redundant provider/task-registration prewarm later
          // immediately before a real Agent request.
          if (options.deferAgentStartupSideEffects !== true) {
            const activeConversationManager = (
              s.services as {
                conversationThreadManager?: ConversationThreadManager;
              }
            ).conversationThreadManager;
            if (activeConversationManager === undefined) {
              throw new Error(
                "bootstrap invariant: conversation thread manager not initialized",
              );
            }
            assertStartupActive();
            await activeConversationManager.runStartupPrewarm(s);
            assertStartupActive();
          }
        };

        if (options.deferAgentStartupSideEffects === true) {
          s.appendDeferredOrdinarySubmitHook(activateAgentStartupSideEffects);
        } else {
          await activateAgentStartupSideEffects();
        }
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
      get configuredExecutionAuthority() {
        return currentConfiguredExecutionAuthority();
      },
      prepareConfiguredExecutionAuthority,
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
      authSubscriptionTier,
      memoryDir,
      memoryMdPath,
      shutdown,
      autonomousModeEnabled,
    };
  } catch (err) {
    try {
      await shutdown();
    } catch (shutdownError) {
      throw new AggregateError(
        [err, shutdownError],
        "local runtime bootstrap failed and cleanup was incomplete",
        { cause: err },
      );
    }
    if (
      err instanceof SessionLockedError ||
      err instanceof SchemaMismatchError
    ) {
      throw err;
    }
    throw err;
  }
  });
}
