import { VERSION } from "../version.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createProvider,
  normalizeManagedGatewayModel,
  normalizeProviderName,
  type ProviderName,
} from "../llm/provider.js";
import { resolveXaiCapabilityExtra } from "../llm/xai-capability-config.js";
import { isFreeSubscriptionManagedModel } from "../commands/subscription-managed-models.js";
import type { LLMProvider } from "../llm/types.js";
import { StaticModelsManager } from "../llm/models-manager.js";
import { createManagedFeatures } from "../llm/registry/features.js";
import { setContextWindowUpgradeContext } from "../llm/context-window-upgrade.js";
import { setActiveConfigModel } from "../bootstrap/state.js";
import {
  markCapabilityDrift,
  markCapabilityVerified,
  resolveProviderCapabilityEntry,
  shouldProbeCapabilityEntry,
} from "../llm/capabilities.js";
import { MCPManager } from "../mcp-client/manager.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { isAutoModeGateEnabled } from "../permissions/classifier.js";
import { resolveApprovalPolicy } from "../permissions/approval-policy.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import {
  NetworkApprovalService as RuntimeNetworkApprovalService,
} from "../permissions/network-approval.js";
import { initializeToolPermissionContext } from "../permissions/settings.js";
import { buildTurnContext, type TurnContext } from "../session/turn-context.js";
import { Session, type SessionState } from "../session/session.js";
import {
  createSessionMcpManagerFromSources,
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
import { shutdownSessionLifecycle } from "../session/lifecycle.js";
import type { EventMsg } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";
import { AgentControl } from "../agents/control.js";
import { ThreadManager } from "../agents/thread-manager.js";
import { ConversationThreadManager } from "../conversation/thread-manager.js";
import { AgentRegistry } from "../agents/registry.js";
import { listAgentRoles } from "../agents/role.js";
import {
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { getSystemPrompt } from "../constants/prompts.js";
import type { Tools as PromptTools } from "../tools/Tool.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";
import { UnifiedExecProcessManager } from "../unified-exec/process-manager.js";
import { createCodeModeService } from "../tools/code-mode/service.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "./_deps/current-session.js";
import { resolveTransportMode } from "../transport/fallback-ladder.js";
import type { ProviderFallbackLadderOptions } from "../llm/api/fallback-ladder.js";
import { ConfigStore } from "../config/store.js";
import { resolveAgencHome as resolveAgencHomeFromEnv, resolveWorkspace as resolveWorkspaceFromEnv } from "../config/env.js";
import { resolveProviderSettings } from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import { runStartupConfigMigrations } from "../state/migrations/config-migrations.js";
import { maybeMigratePersonality } from "../personality/migration.js";
import type { ResolvedProviderSettings } from "../config/resolve-provider.js";
import type {
  AuthBackend,
  AuthSubscriptionTier,
} from "../auth/backend.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { selectByokPrecedenceApiKey } from "../auth/byok-precedence.js";
import { resolveAuthManagedKeysEnabled } from "../auth/selection.js";
import { bindSessionAgentControl } from "./delegate-tool.js";
import {
  readStartupCliFlags,
  resolveStartupSelection,
} from "./startup-selection.js";
import { resolveProjectTrustStateSync } from "../permissions/trust/project-trust.js";
export {
  PROVIDER_MODEL_CATALOG,
  resolveModelOrThrow,
} from "./startup-selection.js";
export type {
  StartupCliFlags,
  StartupSelection,
} from "./startup-selection.js";
import {
  buildBootstrapSessionServices,
  type BootstrapSessionServicesHandle,
} from "./bootstrap-services.js";
import { fetchStartupInternalEvents } from "./startup-internal-events.js";

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

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

interface AuthBackendWithLocalByokKeys extends AuthBackend {
  readByokKey(
    provider: string,
  ): string | undefined | Promise<string | undefined>;
}

function canReadLocalByokKeys(
  authBackend: AuthBackend | undefined,
): authBackend is AuthBackendWithLocalByokKeys {
  return (
    authBackend !== undefined &&
    typeof (authBackend as { readByokKey?: unknown }).readByokKey === "function"
  );
}

async function readAuthBackendByokKey(
  authBackend: AuthBackend | undefined,
  provider: ProviderName,
): Promise<string | undefined> {
  if (!canReadLocalByokKeys(authBackend)) return undefined;
  const apiKey = await authBackend.readByokKey(provider);
  return typeof apiKey === "string" && apiKey.trim().length > 0
    ? apiKey.trim()
    : undefined;
}

async function resolveAuthSubscriptionTier(
  authBackend: AuthBackend | undefined,
  sessionId: string,
): Promise<AuthSubscriptionTier> {
  if (authBackend === undefined) return "free";
  return authBackend.getSubscriptionTier({ sessionId });
}

function isRemoteAuthBackend(
  authBackend: AuthBackend | undefined,
): boolean {
  return authBackend?.kind === "remote";
}

function isSubscriptionEntitled(tier: AuthSubscriptionTier): boolean {
  return tier === "pro" || tier === "team" || tier === "enterprise";
}

function providerHasLiveManagedSubscriptionRoute(provider: ProviderName): boolean {
  return provider === "openrouter";
}

function allowsFreeManagedProviderKey(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly subscriptionTier: AuthSubscriptionTier;
}): boolean {
  return (
    params.subscriptionTier === "free" &&
    isFreeSubscriptionManagedModel(params.provider, params.model)
  );
}

const MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

async function buildBaseInstructionsForModel(params: {
  readonly registry: ToolRegistry;
  readonly model: string;
  readonly coordinatorMode?: boolean;
}): Promise<string> {
  if (params.coordinatorMode === true) {
    const { getLiveCoordinatorSystemPrompt } = await import(
      "../coordinator/coordinatorMode.js"
    );
    return getLiveCoordinatorSystemPrompt();
  }
  const sections = await getSystemPrompt(
    params.registry.tools as unknown as PromptTools,
    params.model,
  );
  return sections.join("\n\n");
}

function enforceRemoteSubscriptionGate(params: {
  readonly authBackend: AuthBackend | undefined;
  readonly subscriptionTier: AuthSubscriptionTier;
  readonly provider: ProviderName;
  readonly model: string;
  readonly providerSettings: ResolvedProviderSettings | undefined;
  readonly byokApiKey: string | undefined;
  readonly managedKeysEnabled: boolean;
}): void {
  if (!isRemoteAuthBackend(params.authBackend)) return;
  if (
    isSubscriptionEntitled(params.subscriptionTier) ||
    allowsFreeManagedProviderKey({
      provider: params.provider,
      model: params.model,
      subscriptionTier: params.subscriptionTier,
    })
  ) return;
  if (requiresAuthModelInference(params.provider, params.model)) {
    throw new Error(
      "Hosted AgenC model routing requires an active AgenC subscription",
    );
  }
  if (
    params.managedKeysEnabled &&
    params.byokApiKey === undefined &&
    providerApiKeyEnvHint(params.provider, params.providerSettings) !== undefined
  ) {
    throw new Error(
      "Managed provider keys require an active AgenC subscription; configure BYOK provider credentials instead",
    );
  }
}

function requiresAuthModelInference(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  return (
    normalizedProvider === "agenc" ||
    normalizedModel === "agenc" ||
    normalizedModel.startsWith("agenc:")
  );
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
    !requiresAuthModelInference(params.provider, params.model)
  ) {
    return {
      provider: params.provider,
      model: params.model,
      profileProvider: params.provider,
      profileModel: params.model,
    };
  }
  const inferred = await params.authBackend.inferAgencModel({
    provider: params.provider,
    requestedModel: params.model,
    sessionId: params.sessionId,
    subscriptionTier: params.subscriptionTier,
  });
  const inferredProvider = normalizeProviderName(inferred.provider);
  const inferredModel = firstNonEmptyString(inferred.model);
  if (inferredModel === undefined) {
    throw new Error("AuthBackend model inference returned an empty model");
  }
  if (isHostedAgencProvider(params.provider)) {
    return {
      provider: params.provider,
      model: params.model,
      profileProvider:
        inferredProvider !== null && inferredProvider !== "agenc"
          ? inferredProvider
          : params.provider,
      profileModel: inferredModel,
    };
  }
  return {
    provider:
      inferredProvider !== null && inferredProvider !== "agenc"
        ? inferredProvider
        : params.provider,
    model: inferredModel,
    profileProvider:
      inferredProvider !== null && inferredProvider !== "agenc"
        ? inferredProvider
        : params.provider,
    profileModel: inferredModel,
  };
}

async function vendProviderKeyOrUndefined(params: {
  readonly authBackend: AuthBackend | undefined;
  readonly provider: ProviderName;
  readonly sessionId: string;
}): Promise<ManagedProviderKeyResult> {
  if (params.authBackend === undefined) return { attempted: false };
  if (!providerHasLiveManagedSubscriptionRoute(params.provider)) {
    return { attempted: false, disabled: true };
  }
  try {
    const key = await params.authBackend.vendKey(
      params.provider,
      params.sessionId,
    );
    const apiKey = key.apiKey.trim();
    const baseURL = key.baseUrl?.trim();
    return apiKey.length > 0
      ? {
        attempted: true,
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      }
      : { attempted: true };
  } catch {
    return { attempted: true };
  }
}

interface ManagedProviderKeyResult {
  readonly attempted: boolean;
  readonly disabled?: boolean;
  readonly apiKey?: string;
  readonly baseURL?: string;
}

const PROVIDER_API_KEY_ENV_HINTS: Readonly<Partial<Record<ProviderName, string>>> =
  Object.freeze({
    grok: "XAI_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    gemini: "GEMINI_API_KEY",
  });

function requireProviderApiKeyOrUndefined(params: {
  readonly provider: ProviderName;
  readonly providerSettings: ResolvedProviderSettings | undefined;
  readonly apiKey: string | undefined;
  readonly managedKey: ManagedProviderKeyResult;
}): string | undefined {
  if (params.apiKey !== undefined) return params.apiKey;
  const envHint = providerApiKeyEnvHint(params.provider, params.providerSettings);
  if (envHint === undefined) return undefined;
  const managedKeyHint = !providerHasLiveManagedSubscriptionRoute(params.provider)
    ? "Subscription-managed access is currently live for OpenRouter only."
    : params.managedKey.disabled
    ? "Managed key vending is disabled by auth.managedKeys.enabled."
    : params.managedKey.attempted
      ? "AuthBackend.vendKey() did not return a usable managed key."
      : "No AuthBackend was configured to vend a managed key.";
  throw new Error(
    `${params.provider} provider requires an API key. ${managedKeyHint} Set ${envHint} or configure providers.${params.provider}.api_key_env for BYOK fallback.`,
  );
}

function buildProviderFallbackLadderOptions(params: {
  readonly provider: string;
  readonly model: string;
  readonly settings: ResolvedProviderSettings | undefined;
}): ProviderFallbackLadderOptions | undefined {
  const targets = params.settings?.fallbackTargets;
  if (!targets || targets.length === 0) return undefined;
  return {
    provider: params.provider,
    model: params.model,
    targets,
    ...(params.settings?.fallbackMaxFailures !== undefined
      ? { maxFailures: params.settings.fallbackMaxFailures }
      : {}),
    ...(params.settings?.fallbackStatuses !== undefined &&
    params.settings.fallbackStatuses.length > 0
      ? { statuses: params.settings.fallbackStatuses }
      : {}),
  };
}

function providerApiKeyEnvHint(
  provider: ProviderName,
  providerSettings: ResolvedProviderSettings | undefined,
): string | undefined {
  return providerSettings?.apiKeyEnvVar ?? PROVIDER_API_KEY_ENV_HINTS[provider];
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

/**
 * Structural `Config` shape for the live local-runtime session. The fields
 * below are the runtime-owned config snapshot consumed by the active shell.
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
  const maxTurns = maxTurnsFromAgenCConfig(config);
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
    ...(config.autonomous_mode !== undefined
      ? { autonomousMode: config.autonomous_mode }
      : {}),
    // Snake config key → camel turn Config (todo-105). Unset = no iteration cap.
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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
    features: createManagedFeatures(config),
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
    /** T9: real `agentRoles` list from role layer (`agents/role.ts`). */
    agentRoles: listAgentRoles().map((role) => ({
      name: role.name,
      description: role.config.description ?? "",
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
  readonly projectTrust?: "trusted" | "untrusted";
}): SessionConfiguration {
  const configPolicy = mapApprovalPolicy(params.config.approval_policy);
  const approval = resolveApprovalPolicy({
    configPolicy,
    projectTrust: params.projectTrust === "untrusted" ? "untrusted" : undefined,
  });
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
      enabled: sandbox === "danger_full_access",
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
  readonly authBackend?: AuthBackend;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly conversationId?: string;
  readonly resumeConversation?: boolean;
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
  readonly authSubscriptionTier: AuthSubscriptionTier;
  readonly memoryDir: string;
  readonly memoryMdPath: string;
  readonly shutdown: () => Promise<void>;
  readonly autonomousModeEnabled: boolean;
}

export async function bootstrapLocalRuntimeSession(
  options: BootstrapLocalRuntimeSessionOptions,
): Promise<LocalRuntimeBootstrap> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const agencHome = resolveAgencHomeFromEnv(env);
  const configStore = new ConfigStore({
    home: agencHome,
    env,
  });
  await configStore.reload();
  // The explicit per-session cwd must beat AGENC_WORKSPACE: in the daemon,
  // `env` is the process env frozen at daemon start, and a stale
  // AGENC_WORKSPACE from the first launch shell would pin every later
  // session to that folder (bug-audit-2026-07-11.md #2). Matches the
  // precedence already used by project-trust resolution.
  const workspaceRoot =
    options.cwd ?? resolveWorkspaceFromEnv(env) ?? process.cwd();
  const configMigrations = await runStartupConfigMigrations({
    home: agencHome,
    cwd: workspaceRoot,
    configStore,
  });
  if (configMigrations.wrote) {
    await configStore.reload();
  }
  let startup = resolveStartupSelection({
    config: configStore.current(),
    env,
    argv,
  });
  const personalityMigrationStatus = await maybeMigratePersonality({
    agencHome,
    config: configStore.current(),
    cwd: workspaceRoot,
    defaultModelProviderId: startup.provider,
    ...(startup.profileName !== undefined
      ? { activeProfileName: startup.profileName }
      : {}),
    ...(startup.config.project_root_markers !== undefined
      ? { projectRootMarkers: startup.config.project_root_markers }
      : {}),
  });
  if (personalityMigrationStatus === "Applied") {
    await configStore.reload();
    startup = resolveStartupSelection({
      config: configStore.current(),
      env,
      argv,
    });
  }
  const cli = readStartupCliFlags(argv);
  const autonomousModeEnabled =
    cli.autonomousMode === true || startup.config.autonomous_mode === true;
  const conversationId =
    options.conversationId ?? `conv-${Date.now().toString(36)}`;
  const resumeConversation =
    options.conversationId !== undefined && options.resumeConversation !== false;

  const projectTrust = resolveProjectTrustStateSync({
    agencHome,
    env,
    cwd: workspaceRoot,
    projectRootMarkers: startup.config.project_root_markers,
  });
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
    projectTrust,
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
  const authSubscriptionTier = await resolveAuthSubscriptionTier(
    options.authBackend,
    conversationId,
  );
  const localByokAuthBackend = new LocalAuthBackend({ agencHome, env });
  const managedKeysEnabled = resolveAuthManagedKeysEnabled(startup.config);
  const startupInjectedByokKey = await readAuthBackendByokKey(
    options.authBackend,
    startup.provider,
  );
  const startupLocalByokKey = await readAuthBackendByokKey(
    localByokAuthBackend,
    startup.provider,
  );
  const startupByokApiKey = firstNonEmptyString(
    startup.apiKey,
    startupInjectedByokKey,
    startupLocalByokKey,
  );
  const byokApiKey = selectByokPrecedenceApiKey({
    explicitApiKey: options.apiKey,
    byokApiKey: startupByokApiKey,
    managedKeysEnabled,
  });
  const startupProviderSettings = resolveProviderSettings(
    startup.provider,
    startup.config,
    env,
  );
  enforceRemoteSubscriptionGate({
    authBackend: options.authBackend,
    subscriptionTier: authSubscriptionTier,
    provider: startup.provider,
    model: startup.model,
    providerSettings: startupProviderSettings,
    byokApiKey,
    managedKeysEnabled,
  });
  const modelSelection = await resolveAuthModelSelection({
    authBackend: options.authBackend,
    provider: startup.provider,
    model: startup.model,
    sessionId: conversationId,
    subscriptionTier: authSubscriptionTier,
  });
  const resolvedProvider = modelSelection.provider;
  const providerModel = modelSelection.model;
  const profileProvider = modelSelection.profileProvider;
  const model = modelSelection.profileModel;
  // Publish the config-resolved model so the env-driven model.ts helpers
  // (welcome display, WebSearchTool, useMainLoopModel fallback, …) reflect
  // `agenc config set model` instead of a hardcoded provider default. This is
  // the same selection that seeds the session's collaborationMode.model below.
  setActiveConfigModel({ provider: resolvedProvider, model: providerModel });
  const runtimeProviderSettings = resolveProviderSettings(
    resolvedProvider,
    startup.config,
    env,
  );
  const runtimeAuthBackendByokKey =
    resolvedProvider === startup.provider
      ? startupInjectedByokKey
      : await readAuthBackendByokKey(options.authBackend, resolvedProvider);
  const runtimeLocalByokKey =
    resolvedProvider === startup.provider
      ? startupLocalByokKey
      : await readAuthBackendByokKey(localByokAuthBackend, resolvedProvider);
  const runtimeByokApiKey = firstNonEmptyString(
    startup.apiKey,
    runtimeAuthBackendByokKey,
    runtimeLocalByokKey,
  );
  const runtimeSelectedByokApiKey = selectByokPrecedenceApiKey({
    explicitApiKey: options.apiKey,
    byokApiKey: runtimeByokApiKey,
    managedKeysEnabled,
  });
  const providerSettings =
    profileProvider === resolvedProvider
      ? runtimeProviderSettings
      : resolveProviderSettings(profileProvider, startup.config, env);
  const managedKey =
    runtimeSelectedByokApiKey === undefined &&
    managedKeysEnabled &&
    !isHostedAgencProvider(resolvedProvider)
      ? await vendProviderKeyOrUndefined({
          authBackend: options.authBackend,
          provider: resolvedProvider,
          sessionId: conversationId,
        })
      : { attempted: false, ...(!managedKeysEnabled ? { disabled: true } : {}) };
  const selectedApiKey = requireProviderApiKeyOrUndefined({
    provider: resolvedProvider,
    providerSettings: runtimeProviderSettings,
    apiKey:
      runtimeSelectedByokApiKey ??
      selectByokPrecedenceApiKey({
        explicitApiKey: undefined,
        byokApiKey: undefined,
        managedKeysEnabled,
        managedApiKey: managedKey.apiKey,
      }),
    managedKey,
  });
  const providerFallback = buildProviderFallbackLadderOptions({
    provider: resolvedProvider,
    model: providerModel,
    settings: runtimeProviderSettings,
  });
  const selectedBaseURL = firstNonEmptyString(
    providerSettings?.baseURL,
    managedKey.baseURL,
  );
  const hasManagedCredential =
    managedKey.apiKey !== undefined || managedKey.baseURL !== undefined;
  const selectedProviderModel = managedKey.baseURL !== undefined
    ? normalizeManagedGatewayModel(resolvedProvider, providerModel)
    : providerModel;
  const mcpManager = await createSessionMcpManagerFromSources(
    configStore.current(),
    env,
    {
      cwd: workspaceRoot,
      includeProjectMcpServers: cli.allowDangerouslySkipPermissions,
    },
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
  const emitProviderDiagnostic = (_diagnostic: {
    cause: string;
    message: string;
  }): void => {
    // Keep provider request-shape diagnostics out of warning/error streams.
  };
  const handleCapabilityDrift = (warning: {
    message: string;
    status?: number;
  }): void => {
    markCapabilityDrift({
      provider: profileProvider,
      model,
      overrides: providerSettings?.capabilityOverrides,
    });
    emitProviderWarning({
      cause: "capability_drift_detected",
      message:
        warning.status !== undefined
          ? `${profileProvider}/${model} rejected a capability the registry claimed it supported (HTTP ${warning.status}): ${warning.message}`
          : `${profileProvider}/${model} rejected a capability the registry claimed it supported: ${warning.message}`,
    });
  };

  const { isCoordinatorModeEnabled, LIVE_COORDINATOR_ALLOWED_TOOLS } =
    await import("../coordinator/coordinatorMode.js");
  const coordinatorModeEnabled = isCoordinatorModeEnabled(
    startup.config.coordinator_mode,
  );
  const baseToolsConfig =
    options.toolRegistryOptions?.toolsConfig ?? startup.config.tools_config;
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
      ...(startup.config.llm?.xai !== undefined
        ? { llmXai: startup.config.llm.xai }
        : {}),
      sessionProvider: resolvedProvider,
      ...(selectedBaseURL !== undefined
        ? { sessionBaseURL: selectedBaseURL }
        : {}),
    },
  });
  const xaiCapabilityExtra = resolveXaiCapabilityExtra({
    provider: resolvedProvider,
    baseURL: selectedBaseURL,
    llmXai: startup.config.llm?.xai,
    env: env as Readonly<Record<string, string | undefined>>,
  });
  const provider: LLMProvider = createProvider(
    resolvedProvider as ProviderName,
    {
      apiKey: selectedApiKey,
      ...(selectedBaseURL ? { baseURL: selectedBaseURL } : {}),
      model: selectedProviderModel,
      tools: registry.toLLMTools(),
      extra: {
        emitWarning: emitProviderWarning,
        emitDiagnostic: emitProviderDiagnostic,
        onCapabilityDrift: handleCapabilityDrift,
        ...(options.authBackend !== undefined
          ? {
            authBackend: options.authBackend,
            sessionId: conversationId,
            subscriptionTier: authSubscriptionTier,
          }
          : {}),
        ...(providerSettings?.contextWindowTokens !== undefined
          ? { contextWindowTokens: providerSettings.contextWindowTokens }
          : {}),
        ...(providerSettings?.maxOutputTokens !== undefined
          ? { maxTokens: providerSettings.maxOutputTokens }
          : {}),
        ...(hasManagedCredential &&
        resolvedProvider === "openrouter" &&
        providerSettings?.maxOutputTokens === undefined
          ? { maxTokens: MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS }
          : {}),
        ...(providerFallback !== undefined
          ? { providerFallback }
          : {}),
        ...(hasManagedCredential ? { managedCredential: true } : {}),
        ...(managedKey.baseURL !== undefined ? { managedGateway: true } : {}),
        // Grok-only server-tool profile from [llm.xai]; empty for non-Grok /
        // non-direct-xAI hosts so other providers never get xAI payloads.
        ...xaiCapabilityExtra,
      },
    },
  );
  const capabilityEntry = resolveProviderCapabilityEntry({
    provider: profileProvider,
    model,
    overrides: providerSettings?.capabilityOverrides,
  });
  const providerHealthCheck = provider.healthCheck;
  if (
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
  const config = buildDeferredConfig(workspaceRoot, model, {
    ...startup.config,
    autonomous_mode: autonomousModeEnabled,
  });
  const modelsManager = new StaticModelsManager({
    config: startup.config,
    fallbackProvider: profileProvider,
    metadata: {
      fetchImpl: globalThis.fetch.bind(globalThis),
      env,
      onWarn: (message) =>
        emitProviderWarning({
          cause: "model_token_limit_config",
          message,
        }),
    },
  });
  // Register the live (model, ModelsManager) pair so sync helpers like
  // `getUpgradeMessage` (post-compact stdout breadcrumb, status hints)
  // can propose same-family larger-context-window models without
  // having to await a fresh catalog lookup.
  setContextWindowUpgradeContext({ currentModel: model, modelsManager });
  const rawModelInfo = await modelsManager.getModelInfo(model);
  const modelInfo =
    hasManagedCredential &&
    resolvedProvider === "openrouter" &&
    providerSettings?.maxOutputTokens === undefined
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
  const baseInstructions = await buildBaseInstructionsForModel({
    registry,
    model: selectedProviderModel,
    coordinatorMode: coordinatorModeEnabled,
  });
  const baseSessionConfiguration = {
    ...sessionConfigurationFromAgenCConfig({
      config: startup.config,
      workspaceRoot,
      model,
      provider: resolvedProvider,
      projectTrust,
    }),
    baseInstructions,
  };
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
    ...(resumeConversation
      ? { pendingSessionStartSource: "resume" as const }
      : {}),
  };
  let initialTranscriptEvents: readonly BootstrapTranscriptEvent[] = [];
  let initialMessages: ReadonlyArray<EventMsg> = [];

  const sessionProjectRootMarkers = startup.config.project_root_markers;
  const memoryDir = join(agencHome, "memory");
  const memoryMdPath = join(memoryDir, "MEMORY.md");
  let sidecarManager: SidecarManager | null = null;
  let clearActiveCostSidecar: (() => void) | null = null;
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
      ...(selectedApiKey
        ? { apiKey: selectedApiKey }
        : {}),
      ...(options.authBackend !== undefined
        ? { authBackend: options.authBackend }
        : {}),
      authSubscriptionTier,
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
    if (sessionForShutdown !== null && agentControlForShutdown !== null) {
      await shutdownSessionLifecycle({
        session: sessionForShutdown,
        agentControl: agentControlForShutdown,
        mcpManager,
      }).catch(() => {
        /* best effort */
      });
    }
    await bootstrapServices.shutdown();
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
      initialState,
      features: config.features,
      services: bootstrapServices.services,
      jsRepl: { id: `repl-${conversationId}` },
      config,
      modelInfo,
      initialTranscriptEvents,
      enablePrewarm: false,
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
        await registerStartupSessionIngress({
          env,
          conversationId,
        });

        const rolloutStore = new RolloutStore({
          cwd: workspaceRoot,
          sessionId: conversationId,
          agencVersion: VERSION,
          ...(resumeConversation ? { resume: true } : {}),
          ...(sessionProjectRootMarkers !== undefined
            ? { projectRootMarkers: sessionProjectRootMarkers }
            : {}),
        });
        rolloutStore.open({
          sessionId: conversationId,
          timestamp: new Date().toISOString(),
          cwd: workspaceRoot,
          originator: "agenc-cli",
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

        try {
          const existingItems = rolloutStore.readAll();
          s.eventLog.seedLastSeq(maxRolloutEventSeq(existingItems));
          if (existingItems.length > 0) {
            const indexSnapshot = readIndexSnapshot(
              join(
                getProjectDir(workspaceRoot, sessionProjectRootMarkers),
                "sessions",
                conversationId,
                "index.json",
              ),
            );
            const replay = await conversationThreadManager.replayRolloutIntoSession(
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

        // Re-arm persisted cron jobs across restarts: a durable schedule
        // written by CronCreate must keep firing after the daemon/session
        // restarts, not sit inert until the next CronCreate call.
        void (async () => {
          try {
            const { readCronTasks } = await import("../utils/cronTasks.js");
            const persisted = await readCronTasks(workspaceRoot);
            if (persisted.length > 0) {
              const { startCronSchedulerRunner } = await import(
                "./model-facing-tools.js"
              );
              await startCronSchedulerRunner();
            }
          } catch {
            /* cron re-arm is best-effort; tools re-arm on next CronCreate */
          }
        })();

        // Resume CSV agent jobs orphaned by a daemon restart: rows left
        // `running` in the DB are re-dispatched once a session exists to
        // spawn workers from.
        void (async () => {
          try {
            const { resumeInterruptedAgentJobs } = await import(
              "./model-facing-tools.js"
            );
            await resumeInterruptedAgentJobs({
              session: s,
              workspaceRoot,
            });
          } catch {
            /* resume is best-effort; jobs stay visible in the DB */
          }
        })();
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
        (s.services as { costSidecar?: CostSidecar }).costSidecar =
          costSidecar;
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

        // Start the MCP connection manager AFTER session_configured
        // has been emitted + persisted to rollout. Mirrors agenc runtime
        // ordering at
        // `agenc-rs/core/src/session/session.rs:717-748, 766` where
        // the SessionConfiguredEvent is dispatched before
        // McpConnectionManager::new.
        await s.startMcpManager(mcpManager, {
          signal: s.services.mcpStartupCancellationToken.signal,
        });

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
        await activeConversationManager.runStartupPrewarm(s);
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
      authSubscriptionTier,
      memoryDir,
      memoryMdPath,
      shutdown,
      autonomousModeEnabled,
    };
  } catch (err) {
    await shutdown();
    if (err instanceof SessionLockedError || err instanceof SchemaMismatchError) {
      throw err;
    }
    throw err;
  }
}

function maxRolloutEventSeq(items: readonly RolloutItem[]): number {
  let maxSeq = 0;
  for (const item of items) {
    if (item.type !== "event_msg") continue;
    const seq = (item.payload as { readonly seq?: unknown }).seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  return maxSeq;
}
