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
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { isAutoModeGateEnabled } from "../permissions/classifier.js";
import { ApprovalStore as RuntimeApprovalStore } from "../permissions/approval-cache.js";
import {
  NetworkApprovalService as RuntimeNetworkApprovalService,
} from "../permissions/network-approval.js";
import { initializeToolPermissionContext } from "../permissions/settings.js";
import type { ReviewDecision } from "../permissions/review-decision.js";
import { buildTurnContext, type TurnContext } from "../session/turn-context.js";
import { Session, type SessionServices, type SessionState } from "../session/session.js";
import {
  createMcpStartupCancellationToken,
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
  runStartupPrewarm,
  emitSessionConfigured as emitSessionConfiguredEvent,
} from "../session/bootstrap.js";
import { discoverDefaultUserShellAsync } from "../utils/shell-discovery.js";
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
  type UnifiedExecProcessManagerLike,
} from "../unified-exec/index.js";
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
 * Build the `SessionServices` container for a live local-runtime session.
 *
 * This is NOT a placeholder in the sense of "fake container that should be
 * swapped in test": it is the canonical live-session wiring. However, several
 * subsystem slots are still structural stubs until their owning tranche lands.
 * Every stub is labelled below with the tranche owner per
 * `docs/plan/feature-matrix.md` and `docs/plan/runtime-owner-manifest.md`.
 *
 * Real wiring today:
 *  - `provider` / `registry` / `configStore` / `permissionModeRegistry` — live
 *  - `toolApprovals` / `networkApproval` — live (permissions T11)
 *  - `mcpManager` — live facade over the real `MCPManager` (T9)
 *  - `agentControl` — rebound post-construction by `bindSessionAgentControl`
 *    (bootstrap caller wires the real `AgentControl` + `AgentRegistry` pair
 *    directly below this function's call site)
 *
 * Deferred structural stubs (each documented inline with its tranche owner):
 *  - `mcpConnectionManager` (T9 — codex `McpConnectionManager`)
 *  - `mcpStartupCancellationToken` (T9)
 *  - `analyticsEventsClient` (T-future — telemetry)
 *  - `hooks` (T4 compact hooks, T7 stop hooks, T10 lifecycle hooks)
 *  - `rollout` (T5 — `RolloutRecorder`; session attaches a live
 *    `RolloutStore` separately via `session.mountRolloutStore(...)`)
 *  - `userShell` (T7)
 *  - `agentIdentityManager` (T9)
 *  - `shellSnapshotTx` (T9)
 *  - `execPolicy` (T11)
 *  - `authManager` (provider auth mode metadata)
 *  - `sessionTelemetry` (T6)
 *  - `modelsManager` (live provider/model catalog)
 *  - `skillsManager` / `pluginsManager` / `skillsWatcher` (T10)
 *  - `threadStore` (T6)
 *  - `modelClient` (deferred codex ModelClient facade)
 *  - `codeModeService` (T-future)
 *
 * Every deferred stub here must stay structurally valid (no field reads
 * throw) until its tranche replaces it with the real implementation.
 */
function buildDeferredServices(
  provider: LLMProvider,
  registry: ToolRegistry,
  mcpManager: SessionServices["mcpManager"],
  unifiedExecManager: UnifiedExecProcessManagerLike,
  permissionModeRegistry: PermissionModeRegistry,
  configStore: ConfigStore,
  toolApprovals: RuntimeApprovalStore<unknown>,
  networkApproval: RuntimeNetworkApprovalService,
  modelsManager: SessionServices["modelsManager"],
  skillsOptions: {
    readonly agencHome: string;
    readonly workspaceRoot: string;
    readonly env: NodeJS.ProcessEnv;
  },
): SessionServices {
  const noopAsync = async () => {
    /* deferred structural stub — replaced when the owning tranche lands */
  };
  const skillsServices = createLocalSkillsServices(skillsOptions);
  return {
    /** T9: real `McpConnectionManager` (codex-rs mcp_connection_manager). */
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    /** T9: startup cancellation token for MCP server-list refresh races. */
    mcpStartupCancellationToken: createMcpStartupCancellationToken(),
    unifiedExecManager,
    /** T-future: analytics/telemetry client. */
    analyticsEventsClient: { emit: noopAsync },
    /**
     * Hooks registry. Codex `Hooks` covers three distinct lifecycle surfaces:
     *   - pre/post compact hooks — T4 (`llm/compact/`)
     *   - stop / stop-failure hooks — T7 (`phases/stop-hooks.ts`, read via
     *     `hooks.stopHooks` / `hooks.stopFailureHooks` handler arrays)
     *   - session-start hooks — T10 (prompts/memory startup wiring)
     *
     * The `stopHooks` / `stopFailureHooks` keys read by `phases/stop-hooks.ts`
     * are intentionally omitted here so the phase's `hooks?.stopHooks ?? []`
     * fallback returns an empty list. When a consumer wires configured stop
     * handlers, they will replace this slot with the real shape.
     */
    hooks: {
      startupWarnings: () => [],
      executePreCompact: noopAsync,
      executePostCompact: noopAsync,
      executeStop: noopAsync,
      executeStopFailure: noopAsync,
    },
    /**
     * T5: `RolloutRecorder`. AgenC mounts a live `RolloutStore` post-
     * construction via `session.mountRolloutStore(...)`; this slot stays
     * undefined until a dedicated recorder lands that matches codex's
     * `Mutex<rollout_recorder>` shape.
     */
    rollout: undefined,
    /** T7: `UserShell` (deriveExecArgs for shell tool). */
    userShell: {
      path: process.env.SHELL ?? "/bin/sh",
      deriveExecArgs: (input: string) => ["-c", input],
    },
    /** T9: `AgentIdentityManager` (subagent identity registration). */
    agentIdentityManager: { ensureRegistered: noopAsync },
    /** T9: `ShellSnapshotTx` (BehaviorSubject broadcasting shell env snapshots). */
    shellSnapshotTx: {
      value: null,
      isClosed: false,
      next: () => {},
      subscribe: () => () => {},
      changes: async function* () {
        // empty
      },
      complete: () => {},
    } as unknown as SessionServices["shellSnapshotTx"],
    showRawAgentReasoning: false,
    /** T11: `ExecPolicyManager` (exec-policy DSL evaluator). */
    execPolicy: { current: () => null },
    /** Provider auth mode metadata; adapters own concrete OAuth refresh. */
    authManager: { mode: "bearer_key" },
    /** T6: `SessionTelemetry` (per-turn timing + retry classification). */
    sessionTelemetry: {},
    /**
     * Live `ModelsManager` (per-model capability registry + online refresh).
     * Its fallback `effectiveContextWindowPercent: 100` value intentionally
     * matches codex's "no reduction" meaning for unknown models.
     */
    modelsManager,
    /** T11 live: per-session approval cache backed by `RuntimeApprovalStore`. */
    toolApprovals: {
      hasApproval: (key: string) => toolApprovals.get(key) !== undefined,
      approve: (key: string) => {
        toolApprovals.set(key, { kind: "approved_for_session" });
      },
      clear: () => {
        toolApprovals.clear();
      },
      withCachedApproval: ({ keys, fetchDecision }) =>
        toolApprovals.withCachedApproval({
          keys,
          fetchDecision: () => fetchDecision() as Promise<ReviewDecision>,
        }),
    },
    guardianRejections: new Map(),
    /** T10: local `SKILL.md` discovery for user/project/plugin roots. */
    skillsManager: skillsServices.skillsManager,
    /** T10: local plugin skill-root discovery. */
    pluginsManager: skillsServices.pluginsManager,
    /** T9 live facade — `createSessionMcpService(...)` wraps the real `MCPManager`. */
    mcpManager,
    /** T10: cache invalidation hook; a real fs watcher can replace this later. */
    skillsWatcher: skillsServices.skillsWatcher,
    /**
     * T9 live: the real `AgentControl` + `AgentRegistry` pair is bound into
     * this slot by `bindSessionAgentControl(session, ...)` in the caller,
     * immediately after `new Session(...)`. This deferred stub is therefore
     * only live during the short window between Session construction and
     * the binding call. See `session.ts::SessionServices.agentControl` for
     * the single-bind-site invariant that keeps this slot effectively
     * immutable after bootstrap.
     */
    agentControl: {
      maxThreads: 0,
      spawnAgent: async () => null,
      shutdownAgentTree: noopAsync,
    },
    /** T11 live: network-approval service backed by `RuntimeNetworkApprovalService`. */
    networkApproval: {
      enabled: () => true,
      clearSessionHosts: () => {
        networkApproval.clearSessionHosts();
      },
      requestNetworkApproval: (opts: unknown) =>
        networkApproval.requestNetworkApproval(
          opts as Parameters<typeof networkApproval.requestNetworkApproval>[0],
        ),
      requestDeferredApproval: (opts: unknown) =>
        networkApproval.requestDeferredApproval(
          opts as Parameters<typeof networkApproval.requestDeferredApproval>[0],
        ),
    },
    /** T6: `LocalThreadStore` (thread-name persistence). */
    threadStore: {
      threadName: async () => undefined,
      setThreadName: noopAsync,
    },
    /** Deferred codex `ModelClient`; provider dispatch uses `services.provider`. */
    modelClient: { setWindowGeneration: () => {} },
    /** T-future: `CodeModeService` (codex JS-REPL tool surface). */
    codeModeService: { enabled: () => false },
    provider,
    registry,
    permissionModeRegistry,
    configStore,
  };
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
    /** T-future: ghost-snapshot state machine (codex workspace restore). */
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

  // Discover the real user shell up-front so `Session.services.userShell`
  // holds a live `UserShell` (zsh/bash/sh) instead of the `/bin/sh`
  // interface stub `buildDeferredServices` returns. Matches upstream
  // codex `core/src/session/session.rs:585-605` where
  // `shell::default_user_shell()` feeds `SessionServices.user_shell`.
  const discoveredShell = await discoverDefaultUserShellAsync({ env });
  const session = new Session({
    conversationId,
    initialState,
    features: config.features,
    services: {
      ...buildDeferredServices(
        provider,
        registry,
        createSessionMcpService(mcpManager, { env }),
        unifiedExecManager,
        permissionModeRegistry,
        configStore,
        toolApprovals,
        networkApproval,
        modelsManager,
        { agencHome, workspaceRoot, env },
      ),
      userShell: discoveredShell,
    },
    jsRepl: { id: `repl-${conversationId}` },
    initialTranscriptEvents,
  });
  sessionRef = session;
  const agentRegistry = new AgentRegistry();
  const agentControl = new AgentControl({
    session,
    registry: agentRegistry,
  });
  agentControl.registerSessionRoot(conversationId);
  bindSessionAgentControl(session, {
    control: agentControl,
    registry: agentRegistry,
  });
  // Intentionally defer `session.startMcpManager(mcpManager)` — per codex
  // `codex-rs/core/src/session/session.rs:717-748, 766`, SessionConfigured
  // must be emitted BEFORE the MCP connection manager is constructed
  // ("Dispatch the SessionConfiguredEvent first and then report any
  // errors"). The call is moved below, after the session_configured emit.

  const sessionProjectRootMarkers = startup.config.project_root_markers;
  const memoryDir = join(agencHome, "memory");
  const memoryMdPath = join(memoryDir, "MEMORY.md");
  let sidecarManager: SidecarManager | null = null;
  let turnStateAccumulator: TurnStateAccumulator | null = null;
  let shutdownStarted = false;

  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    turnStateAccumulator?.detach();
    clearCurrentRuntimeSession(session);
    if (sidecarManager !== null) {
      await sidecarManager.stop().catch(() => {
        /* best effort */
      });
    }
    await shutdownSessionLifecycle({
      session,
      agentControl,
      mcpManager,
    }).catch(() => {
      /* best effort */
    });
  };

  try {
    setCurrentRuntimeSession(session);
    await registerStartupSessionIngress({
      env,
      conversationId,
    });

    // Context-collapse runtime state is process-global. Clear it on every
    // bootstrap, then restore persisted commit/snapshot metadata for
    // explicit resume sessions before the first live query can run.
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
          session.emit({
            id: session.nextInternalSubId(),
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
    session.mountRolloutStore(rolloutStore);

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
        await session.state.swap(initialState);
        initialTranscriptEvents = transcriptEventsFromRollout([
          ...existingItems,
          ...reconstruction.synthesizedEvents,
        ]);
        initialMessages = transcriptMessagesFrom(initialTranscriptEvents);
        session.setInitialTranscriptEvents(initialTranscriptEvents);
        if (reconstruction.synthesizedEvents.length > 0) {
          for (const synth of reconstruction.synthesizedEvents) {
            if (synth.type === "event_msg") {
              session.emit(synth.payload);
            } else {
              rolloutStore.appendRollout(synth);
            }
          }
        }
        // Port of codex `Session::record_initial_history` resume
        // branch (session/mod.rs:1150-1236): restore persisted agent
        // task, emit a model-change warning when the rollout's last
        // turn ran on a different model, and seed token-usage from
        // the last persisted token_count event so resume UIs show
        // cumulative usage immediately. This runs unconditionally
        // on resume — each sub-step is a no-op when its input is
        // absent.
        await recordInitialHistoryOnResume(session, existingItems, {
          ...(reconstruction.previousTurnSettings?.model !== undefined
            ? { previousModel: reconstruction.previousTurnSettings.model }
            : {}),
          currentModel: model,
        });
      }
    } catch (err) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "orphan_recovery_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }

    const projectDir = getProjectDir(workspaceRoot, sessionProjectRootMarkers);
    sidecarManager = new SidecarManager({
      onDiagnostic: (diagnostic) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: diagnostic.level,
            payload: {
              cause: diagnostic.cause,
              message: diagnostic.message,
            },
          },
        } as Parameters<typeof session.emit>[0]);
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
      budgetTracker: session.budgetTracker,
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
      session: () => (shutdownStarted ? null : session),
      memoryDir,
    });
    turnStateAccumulator = new TurnStateAccumulator();
    turnStateAccumulator.subscribe(session.eventLog);
    const getTurnState = (): MemoryTurnState | null =>
      turnStateAccumulator?.snapshot() ?? null;
    sidecarManager.register(
      registerAutoSaveSidecar({
        session: { memoryDir, memoryMdPath },
        extractor: extractMemoriesFn,
        getTurnState,
        emitWarning: (message: string) => {
          if (shutdownStarted) return;
          session.emit({
            id: session.nextInternalSubId(),
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

    const ctx = buildTurnContext({
      conversationId,
      subId: session.nextInternalSubId(),
      config,
      modelInfo,
      provider,
      sessionConfiguration: initialState.sessionConfiguration,
    });

    const sessionConfiguredPayload = {
      sessionId: conversationId,
      model,
      modelProviderId: resolvedProvider,
      cwd: workspaceRoot,
      historyLogId: 0,
      historyEntryCount: initialState.history.length,
      initialMessages,
      rolloutPath: rolloutStore.rolloutPath,
    };
    // `emitSessionConfiguredEvent` is the shared helper shared with
    // `session/bootstrap.ts::bootstrapSession`; routing the bin path
    // through it keeps the emit shape identical whether the caller
    // uses the full `bootstrapSession` entry or this staged bin flow.
    emitSessionConfiguredEvent(session, sessionConfiguredPayload);
    session.setInitialTranscriptEvents([
      ...initialTranscriptEvents,
      {
        type: "session_configured",
        payload: sessionConfiguredPayload,
      },
    ]);

    // Start sidecars AFTER session_configured so they cannot emit earlier
    // events. Mirrors codex `session.rs:750-751`: "Start the watcher after
    // SessionConfigured so it cannot emit earlier events."
    await sidecarManager.start(session.eventLog);

    // Start the MCP connection manager AFTER session_configured has been
    // emitted + persisted to rollout. Mirrors codex ordering at
    // `codex-rs/core/src/session/session.rs:717-748, 766` where the
    // SessionConfiguredEvent is dispatched before McpConnectionManager::new.
    await session.startMcpManager(mcpManager, {
      signal: session.services.mcpStartupCancellationToken.signal,
    });

    // Startup prewarm: pre-build the default TurnContext and best-
    // effort register the agent task so the first submit does not
    // pay that cost. Mirrors codex
    // `session/session.rs:931-932` (`schedule_startup_prewarm`) and
    // the `maybePrewarmAgentTaskRegistration` helper in
    // `session/agent-task-lifecycle.ts`. Errors are swallowed inside
    // the helper.
    await runStartupPrewarm(session, {
      signal: session.services.mcpStartupCancellationToken.signal,
    });

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
      rolloutStore,
      sidecarManager,
      ctx,
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
