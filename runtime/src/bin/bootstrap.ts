import { join } from "node:path";

import { createProvider, type ProviderName } from "../llm/provider.js";
import type { LLMProvider } from "../llm/types.js";
import { MCPManager } from "../mcp-client/manager.js";
import {
  registerAutoSaveSidecar,
  type ExtractMemoriesFn,
  type MemoryCandidate,
  type TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { buildTurnContext, type TurnContext } from "../session/turn-context.js";
import { Session, type SessionServices, type SessionState } from "../session/session.js";
import {
  createSessionMcpManagerFromEnv,
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
import { SidecarManager } from "../session/sidecar.js";
import { FileHistory, FileHistorySidecar } from "../session/file-history.js";
import { ErrorLogSidecar } from "../session/error-log.js";
import { CostSidecar } from "../session/cost.js";
import { shutdownSessionLifecycle } from "../session/lifecycle.js";
import type { Event, EventMsg } from "../session/event-log.js";
import type { RolloutItem } from "../session/rollout-item.js";
import {
  buildToolRegistry,
  type BuildToolRegistryOptions,
} from "../tool-registry.js";
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from "../utils/currentRuntimeSession.js";
import {
  ConfigStore,
  resolveAgencHome as resolveAgencHomeFromEnv,
  resolveModelDisambiguated,
  resolveWorkspace as resolveWorkspaceFromEnv,
  AmbiguousModelError,
  UnknownModelError,
  type AgenCConfig,
} from "../config/index.js";

export const DEFAULT_MODEL = "grok-4-fast";

export const PROVIDER_MODEL_CATALOG: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    grok: Object.freeze([
      "grok-4-fast",
      "grok-4",
      "grok-3",
      "grok-2",
      "grok-2-mini",
      "grok-beta",
      "grok-code-fast-1",
    ]) as readonly string[],
  });

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

function buildPlaceholderServices(
  provider: LLMProvider,
  registry: ReturnType<typeof buildToolRegistry>,
  mcpManager: SessionServices["mcpManager"],
): SessionServices {
  const noopAsync = async () => {
    /* placeholder */
  };
  return {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    unifiedExecManager: { maxTimeoutMs: 0 },
    analyticsEventsClient: { emit: noopAsync },
    hooks: {
      startupWarnings: () => [],
      executePreCompact: noopAsync,
      executePostCompact: noopAsync,
      executeStop: noopAsync,
      executeStopFailure: noopAsync,
    },
    rollout: undefined,
    userShell: {
      path: process.env.SHELL ?? "/bin/sh",
      deriveExecArgs: (input: string) => ["-c", input],
    },
    agentIdentityManager: { ensureRegistered: noopAsync },
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
    execPolicy: { current: () => null },
    authManager: { mode: "bearer_key" },
    sessionTelemetry: {},
    modelsManager: {
      getModelInfo: async (slug: string) => ({
        slug,
        effectiveContextWindowPercent: 1,
        supportedReasoningLevels: [],
        defaultReasoningSummary: "auto",
        truncationPolicy: "off",
        usedFallbackModelMetadata: false,
      }),
      tryListModels: () => undefined,
      listModels: async () => [],
    },
    toolApprovals: {
      hasApproval: () => false,
      approve: () => {},
    },
    guardianRejections: new Map(),
    skillsManager: {
      skillsForConfig: async () => ({ invokedSkills: [] }),
    },
    pluginsManager: {
      pluginsForConfig: async () => ({ effectiveSkillRoots: () => null }),
    },
    mcpManager,
    skillsWatcher: { start: () => {} },
    agentControl: {
      maxThreads: 0,
      spawnAgent: async () => null,
      shutdownAgentTree: noopAsync,
    },
    networkApproval: { enabled: () => false },
    threadStore: {
      threadName: async () => undefined,
      setThreadName: noopAsync,
    },
    modelClient: { setWindowGeneration: () => {} },
    codeModeService: { enabled: () => false },
    provider,
    registry,
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
  };
}

function buildMinimalConfig(cwd: string, model: string): Config {
  return {
    model,
    cwd,
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
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

function buildMinimalModelInfo(slug: string): ModelInfo {
  return {
    slug,
    effectiveContextWindowPercent: 1,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
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
        } as SessionConfiguration["provider"],
      }
      : {}),
    collaborationMode: { model: params.model },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...(params.config.personality !== undefined
      ? { personality: params.config.personality }
      : {}),
    ...(params.config.reasoning_summary !== undefined
      ? { modelReasoningSummary: params.config.reasoning_summary }
      : {}),
    ...(params.config.compact_prompt !== undefined
      ? { compactPrompt: params.config.compact_prompt }
      : {}),
  };
}

export function resolveModelOrExit(
  slug: string,
  catalog: Readonly<Record<string, readonly string[]>> = PROVIDER_MODEL_CATALOG,
  exit: (code: number) => never = ((code: number) => {
    process.exit(code);
  }) as (code: number) => never,
  errSink: (line: string) => void = (line) => process.stderr.write(line),
): { provider: string; model: string } {
  try {
    return resolveModelDisambiguated(slug, catalog);
  } catch (err) {
    if (err instanceof AmbiguousModelError) {
      const candidates = err.candidates
        .map((c) => `${c.provider}:${c.model}`)
        .join(", ");
      errSink(
        `agenc: ambiguous model '${slug}' — matches ${err.candidates.length} providers. ` +
          `Use 'provider:model' form. Candidates: ${candidates}\n`,
      );
      exit(1);
    }
    if (err instanceof UnknownModelError) {
      errSink(`agenc: ${err.message}\n`);
      exit(1);
    }
    throw err;
  }
  throw new Error("resolveModelOrExit: unreachable");
}

export const EXTRACT_MEMORIES_TIMEOUT_MS = 30_000;

function buildExtractPrompt(transcript: string): string {
  return [
    "You are extracting durable memories from the current session. Input: the last N assistant+user messages. Output: JSON array of candidates with shape:",
    "[ { \"name\": \"<slug>\", \"description\": \"<one-line>\", \"type\": \"user\"|\"feedback\"|\"project\"|\"reference\", \"body\": \"<the memory content>\" } ]",
    "Only extract non-ephemeral, user-specific, durable facts. Skip code patterns, ephemeral state, PR/commit references. Output ONLY valid JSON, no prose.",
    "",
    "--- TRANSCRIPT ---",
    transcript,
  ].join("\n");
}

const EXTRACT_MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

export function parseExtractedMemoryCandidates(
  raw: string,
  memoryDir: string,
): readonly MemoryCandidate[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("extractor response was not a JSON array");
  }
  const out: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    const type =
      typeof rec.type === "string" && EXTRACT_MEMORY_TYPES.has(rec.type)
        ? (rec.type as "user" | "feedback" | "project" | "reference")
        : undefined;
    const body = typeof rec.body === "string" ? rec.body : "";
    if (name === "" || type === undefined || body.length === 0) continue;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length === 0) continue;
    out.push({
      filePath: join(memoryDir, `${slug}.md`),
      frontmatter: {
        name,
        description,
        type,
        extra: {},
      },
      body,
    });
  }
  return out;
}

export function buildExtractMemoriesViaSubagent(params: {
  readonly session: () => Session | null;
  readonly memoryDir: string;
  readonly delegateFn?: typeof import("../agents/delegate.js").delegate;
  readonly timeoutMs?: number;
}): ExtractMemoriesFn {
  return async (transcript: string): Promise<readonly MemoryCandidate[]> => {
    const session = params.session();
    if (session === null) return [];
    const timeoutMs = params.timeoutMs ?? EXTRACT_MEMORIES_TIMEOUT_MS;

    const emitWarning = (cause: string, message: string): void => {
      try {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: { cause, message },
          },
        });
      } catch {
        /* best effort */
      }
    };

    let rawFinal: string;
    try {
      const delegateFn =
        params.delegateFn ??
        (await import("../agents/delegate.js")).delegate;
      const { control, registry } = (
        await import("./delegate-tool.js")
      ).ensureAgentControl(session);

      const deadline = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `memory_extract_timeout: extraction did not finish within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ).unref?.();
      });

      const dispatch = delegateFn({
        parent: session,
        parentPath: "/root",
        control,
        registry,
        taskPrompt: buildExtractPrompt(transcript),
        role: "explorer",
      });

      const outcome = await Promise.race([dispatch, deadline]);
      if (outcome.kind !== "sync_completed") {
        emitWarning(
          "memory_extract_failed",
          outcome.kind === "rejected"
            ? `delegate rejected: ${outcome.reason}`
            : `unexpected delegate outcome: ${outcome.kind}`,
        );
        return [];
      }
      rawFinal = outcome.result.finalMessage ?? "";
      if (rawFinal.trim().length === 0) {
        emitWarning(
          "memory_extract_parse_failed",
          "extractor returned an empty final message",
        );
        return [];
      }
    } catch (err) {
      emitWarning(
        "memory_extract_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    try {
      return parseExtractedMemoryCandidates(rawFinal, params.memoryDir);
    } catch (err) {
      emitWarning(
        "memory_extract_parse_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  };
}

export class TurnStateAccumulator {
  private tokensConsumed = 0;
  private toolCallsIssued = 0;
  private currentTurnHadTools = false;
  private lastTurnHadNoTools = false;
  private unsubscribe: (() => void) | null = null;

  subscribe(log: { subscribe: (fn: (e: Event) => void) => () => void }): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = log.subscribe((event) => this.onEvent(event));
  }

  detach(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  onEvent(event: Event): void {
    switch (event.msg.type) {
      case "turn_started": {
        this.currentTurnHadTools = false;
        return;
      }
      case "tool_call_started": {
        this.currentTurnHadTools = true;
        return;
      }
      case "tool_call_completed": {
        this.toolCallsIssued += 1;
        this.currentTurnHadTools = true;
        return;
      }
      case "token_count": {
        const delta = event.msg.payload.totalTokens ?? 0;
        if (delta > 0) this.tokensConsumed += delta;
        return;
      }
      case "turn_complete": {
        this.lastTurnHadNoTools = !this.currentTurnHadTools;
        return;
      }
      default:
        return;
    }
  }

  snapshot(): MemoryTurnState {
    return {
      tokensConsumed: this.tokensConsumed,
      toolCallsIssued: this.toolCallsIssued,
      lastTurnHadNoTools: this.lastTurnHadNoTools,
    };
  }

  reset(): void {
    this.tokensConsumed = 0;
    this.toolCallsIssued = 0;
    this.currentTurnHadTools = false;
    this.lastTurnHadNoTools = false;
  }
}

export interface BootstrapLocalRuntimeSessionOptions {
  readonly apiKey: string;
  readonly env?: NodeJS.ProcessEnv;
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
  readonly registry: ReturnType<typeof buildToolRegistry>;
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
  const agencHome = resolveAgencHomeFromEnv(env);
  const configStore = new ConfigStore({
    home: agencHome,
    env,
  });
  await configStore.reload();

  const workspaceRoot =
    resolveWorkspaceFromEnv(env) ?? options.cwd ?? process.cwd();
  const rawModel = configStore.current().model ?? DEFAULT_MODEL;
  const { provider: resolvedProvider, model } = resolveModelOrExit(rawModel);
  const mcpManager = createSessionMcpManagerFromEnv(env);

  const registry = buildToolRegistry({
    workspaceRoot,
    ...(options.toolRegistryOptions ?? {}),
  });
  const provider: LLMProvider = createProvider(
    resolvedProvider as ProviderName,
    {
      apiKey: options.apiKey,
      model,
      tools: registry.toLLMTools(),
    },
  );
  const conversationId =
    options.conversationId ?? `conv-${Date.now().toString(36)}`;
  const config = buildMinimalConfig(workspaceRoot, model);
  const modelInfo = buildMinimalModelInfo(model);
  let initialState: SessionState = {
    sessionConfiguration: sessionConfigurationFromAgenCConfig({
      config: configStore.current(),
      workspaceRoot,
      model,
      provider: resolvedProvider,
    }),
    history: [],
    ...(options.conversationId !== undefined
      ? { pendingSessionStartSource: "resume" as const }
      : {}),
  };
  let initialTranscriptEvents: readonly BootstrapTranscriptEvent[] = [];
  let initialMessages: ReadonlyArray<EventMsg> = [];
  const session = new Session({
    conversationId,
    initialState,
    features: config.features,
    services: buildPlaceholderServices(
      provider,
      registry,
      createSessionMcpService(mcpManager),
    ),
    jsRepl: { id: `repl-${conversationId}` },
    initialTranscriptEvents,
  });
  await session.startMcpManager(mcpManager);

  const sessionProjectRootMarkers = configStore.current().project_root_markers;
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
    await shutdownSessionLifecycle({ session, mcpManager }).catch(() => {
      /* best effort */
    });
  };

  try {
    setCurrentRuntimeSession(session);

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

    await sidecarManager.start(session.eventLog);

    const ctx = buildTurnContext({
      conversationId,
      subId: session.nextInternalSubId(),
      config,
      modelInfo,
      provider,
      sessionConfiguration: initialState.sessionConfiguration,
    });

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "session_configured",
        payload: {
          sessionId: conversationId,
          model,
          modelProviderId: resolvedProvider,
          cwd: workspaceRoot,
          historyLogId: 0,
          historyEntryCount: initialState.history.length,
          initialMessages,
          rolloutPath: rolloutStore.rolloutPath,
        },
      },
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
