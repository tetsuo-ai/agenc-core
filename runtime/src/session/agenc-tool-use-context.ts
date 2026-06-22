import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { LLMProvider, LLMTool } from "../llm/types.js";
import {
  createEmptyToolPermissionContext,
  isPermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from "../utils/fileStateCache.js";
import { asRecord, isRecord } from "../utils/record.js";
import type { Session } from "./session.js";
import { modelContextWindow, type TurnContext } from "./turn-context.js";

export interface AgenCModelContext {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

export interface AgenCToolUseContext {
  readonly abortController: AbortController;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly sessionId: string;
  readonly options: {
    readonly mainLoopModel: string;
    readonly tools: readonly AgenCRuntimeTool[];
    readonly mcpClients: readonly unknown[];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly providerOverride?: {
      readonly model: string;
      readonly baseURL: string;
      readonly apiKey: string;
    };
    readonly querySource?: string;
    readonly agentDefinitions: {
      readonly activeAgents: readonly unknown[];
      readonly allowedAgentTypes?: readonly unknown[];
    };
    readonly isNonInteractiveSession: boolean;
    readonly cwd?: string;
    readonly verbose: boolean;
  };
  readonly getAppState: () => {
    readonly toolPermissionContext: unknown;
    readonly agentDefinitions: {
      readonly activeAgents: readonly unknown[];
      readonly allowedAgentTypes?: readonly unknown[];
    };
    readonly tasks: Record<string, unknown>;
    readonly promptSuggestionEnabled?: unknown;
    readonly pendingWorkerRequest?: unknown;
    readonly pendingSandboxRequest?: unknown;
    readonly elicitation?: unknown;
    readonly [key: string]: unknown;
  };
  readonly setAppState?: (updater: unknown) => void;
  readonly setAppStateForTasks?: (updater: unknown) => void;
  readonly appendSystemMessage?: (message: unknown) => void;
  readonly readFileState: FileStateCache;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly setStreamMode: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength: (updater: (length: number) => number) => void;
  readonly onCompactProgress: (event: unknown) => void;
  readonly setSDKStatus: (status: "compacting" | null) => void;
  readonly addNotification: (notification: unknown) => void;
  readonly emitWarning: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly clearProviderResponseId: () => void;
  readonly rolloutStore?: unknown;
  readonly session?: { readonly rolloutStore?: unknown };
  readonly provider?: LLMProvider;
  readonly cwd?: string;
}

export type AgenCRuntimeTool = LLMTool & {
  readonly name: string;
  readonly description: string;
  readonly inputJSONSchema: Record<string, unknown>;
  readonly isMcp: boolean;
  readonly maxResultSizeChars: number;
};

type AppStateShape = ReturnType<AgenCToolUseContext["getAppState"]>;

type SessionSurface = {
  readonly getAppState?: () => unknown;
  readonly setAppState?: (updater: unknown) => void;
  readonly setAppStateForTasks?: (updater: unknown) => void;
  readonly appendSystemMessage?: (message: unknown) => void;
  readonly readFileState?: FileStateCache;
  readonly loadedNestedMemoryPaths?: Set<string>;
  readonly mcpClients?: readonly unknown[];
  readonly agentDefinitions?: {
    readonly activeAgents?: readonly unknown[];
    readonly allowedAgentTypes?: readonly unknown[];
  };
  readonly tasks?: Record<string, unknown>;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: unknown) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly addNotification?: (notification: unknown) => void;
  readonly emitWarning?: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly isNonInteractiveSession?: boolean;
  readonly verbose?: boolean;
};

function readFunction<T extends (...args: unknown[]) => unknown>(
  value: unknown,
): T | undefined {
  return typeof value === "function" ? (value as T) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toAgenCModelContext(ctx: TurnContext): AgenCModelContext {
  const contextWindowTokens =
    modelContextWindow(ctx) ?? ctx.modelInfo.contextWindow;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    throw new Error(`Missing context window for model ${ctx.modelInfo.slug}`);
  }
  return {
    model: ctx.modelInfo.slug,
    contextWindowTokens,
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}

export function buildAgenCToolUseContext(
  session: Session,
  ctx: TurnContext,
  opts: {
    readonly querySource?: string;
    readonly verbose?: boolean;
    readonly llmTools?: readonly LLMTool[];
  } = {},
): AgenCToolUseContext {
  const model = toAgenCModelContext(ctx);
  const providerOverride = buildProviderOverride(session, model.model);
  const surface = readSessionSurface(session);
  const agentDefinitions = normalizeAgentDefinitions(surface.agentDefinitions);
  const cwd = ctx.cwd;
  const llmTools = opts.llmTools ?? session.services.registry.toLLMTools();
  const setAppState = surface.setAppState;
  const setAppStateForTasks = surface.setAppStateForTasks ?? setAppState;
  const appendSystemMessage =
    surface.appendSystemMessage ?? createSessionSystemMessageAppender(session);

  return {
    abortController: session.abortController ?? new AbortController(),
    agentId: inferAgentId(session, ctx, surface, opts.querySource),
    agentType: surface.agentType,
    sessionId: session.conversationId,
    options: {
      mainLoopModel: model.model,
      tools: toAgenCRuntimeTools(llmTools),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
      ...(opts.querySource !== undefined
        ? { querySource: opts.querySource }
        : {}),
      agentDefinitions,
      isNonInteractiveSession: surface.isNonInteractiveSession ?? false,
      cwd,
      verbose: opts.verbose ?? surface.verbose ?? false,
    },
    getAppState: createAppStateReader(session, surface, agentDefinitions),
    setAppState,
    setAppStateForTasks,
    appendSystemMessage,
    readFileState:
      surface.readFileState ??
      createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    loadedNestedMemoryPaths:
      surface.loadedNestedMemoryPaths ?? new Set<string>(),
    setStreamMode: surface.setStreamMode ?? (() => {}),
    setResponseLength: surface.setResponseLength ?? (() => {}),
    onCompactProgress: surface.onCompactProgress ?? (() => {}),
    setSDKStatus: surface.setSDKStatus ?? (() => {}),
    addNotification: surface.addNotification ?? (() => {}),
    emitWarning:
      surface.emitWarning ??
      ((warning) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: warning,
          },
        });
      }),
    ...(surface.queryTracking !== undefined
      ? { queryTracking: surface.queryTracking }
      : {}),
    clearProviderResponseId: () => session.clearProviderResponseId?.(),
    ...(session.rolloutStore !== undefined
      ? { rolloutStore: session.rolloutStore }
      : {}),
    ...(session.rolloutStore !== undefined
      ? { session: { rolloutStore: session.rolloutStore } }
      : {}),
    provider: session.services.provider,
    cwd,
  };
}

function toAgenCRuntimeTools(tools: readonly LLMTool[]): AgenCRuntimeTool[] {
  return tools.map((tool) => {
    const name = tool.function.name;
    return {
      ...tool,
      name,
      description: tool.function.description,
      inputJSONSchema: tool.function.parameters,
      isMcp: name.startsWith("mcp__"),
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    };
  });
}

function buildProviderOverride(
  session: Session,
  fallbackModel: string,
): AgenCToolUseContext["options"]["providerOverride"] | undefined {
  const provider = session.services.provider;
  if (!provider) return undefined;
  const options = readProviderFactoryOptions(provider);
  const model = firstNonEmpty(options.model, fallbackModel);
  const baseURL = firstNonEmpty(options.baseURL);
  if (!model || !baseURL) return undefined;
  return {
    model,
    baseURL,
    apiKey: options.apiKey ?? "",
  };
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeAgentDefinitions(
  definitions: SessionSurface["agentDefinitions"],
): NonNullable<AppStateShape["agentDefinitions"]> {
  return {
    activeAgents: Array.isArray(definitions?.activeAgents)
      ? [...definitions.activeAgents]
      : [],
    allowedAgentTypes: Array.isArray(definitions?.allowedAgentTypes)
      ? [...definitions.allowedAgentTypes]
      : [],
  };
}

function createFallbackAppState(
  session: Session,
  surface: SessionSurface,
  agentDefinitions: NonNullable<AppStateShape["agentDefinitions"]>,
): AppStateShape {
  return {
    toolPermissionContext:
      readToolPermissionContext(session.permissionModeRegistry?.current?.()) ??
      readToolPermissionContext(
        session.services.permissionModeRegistry?.current?.(),
      ) ??
      createEmptyToolPermissionContext(),
    agentDefinitions,
    tasks: surface.tasks ?? {},
    promptSuggestionEnabled: false,
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    elicitation: { queue: [] },
  };
}

function readToolPermissionContext(value: unknown): ToolPermissionContext | null {
  const record = asRecord(value);
  if (record === null || !isPermissionMode(record.mode)) return null;
  return value as ToolPermissionContext;
}

function normalizeElicitation(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.queue)) return value;
  return { queue: [] };
}

function createAppStateReader(
  session: Session,
  surface: SessionSurface,
  agentDefinitions: NonNullable<AppStateShape["agentDefinitions"]>,
): () => AppStateShape {
  return () => {
    const fallback = createFallbackAppState(session, surface, agentDefinitions);
    const state = surface.getAppState?.();
    if (!isRecord(state)) return fallback;

    return {
      ...state,
      toolPermissionContext:
        readToolPermissionContext(state.toolPermissionContext) ??
        fallback.toolPermissionContext,
      agentDefinitions:
        isRecord(state.agentDefinitions) &&
        Array.isArray(state.agentDefinitions.activeAgents)
          ? normalizeAgentDefinitions(
              state.agentDefinitions as SessionSurface["agentDefinitions"],
            )
          : fallback.agentDefinitions,
      tasks: isRecord(state.tasks)
        ? (state.tasks as Record<string, unknown>)
        : fallback.tasks,
      promptSuggestionEnabled:
        state.promptSuggestionEnabled ?? fallback.promptSuggestionEnabled,
      pendingWorkerRequest:
        state.pendingWorkerRequest ?? fallback.pendingWorkerRequest,
      pendingSandboxRequest:
        state.pendingSandboxRequest ?? fallback.pendingSandboxRequest,
      elicitation: normalizeElicitation(state.elicitation),
    };
  };
}

function readSessionSurface(session: Session): SessionSurface {
  const stateRecord = readStateSnapshot(session);
  const direct = session as unknown as Record<string, unknown>;
  const services = isRecord(direct.services)
    ? (direct.services as Record<string, unknown>)
    : {};
  const bridge = isRecord(direct.appStateBridge)
    ? (direct.appStateBridge as Record<string, unknown>)
    : {};

  const read = <T>(key: keyof SessionSurface): T | undefined => {
    const bridgeValue = bridge[key];
    if (bridgeValue !== undefined) return bridgeValue as T;
    const directValue = direct[key];
    if (directValue !== undefined) return directValue as T;
    const snapshotValue = stateRecord[key];
    if (snapshotValue !== undefined) return snapshotValue as T;
    const serviceValue = services[key];
    if (serviceValue !== undefined) return serviceValue as T;
    return undefined;
  };

  return {
    getAppState: readFunction<() => unknown>(read("getAppState")),
    setAppState: readFunction<(updater: unknown) => void>(read("setAppState")),
    setAppStateForTasks: readFunction<(updater: unknown) => void>(
      read("setAppStateForTasks"),
    ),
    appendSystemMessage: readFunction<(message: unknown) => void>(
      read("appendSystemMessage"),
    ),
    readFileState: read<FileStateCache>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions:
      read<SessionSurface["agentDefinitions"]>("agentDefinitions"),
    tasks: read<Record<string, unknown>>("tasks"),
    agentId: readString(read("agentId")),
    agentType: readString(read("agentType")),
    queryTracking: read<{ readonly chainId?: string; readonly depth?: number }>(
      "queryTracking",
    ),
    setStreamMode:
      read<(mode: "requesting" | "responding" | null) => void>("setStreamMode"),
    setResponseLength:
      read<(updater: (length: number) => number) => void>("setResponseLength"),
    onCompactProgress: read<(event: unknown) => void>("onCompactProgress"),
    setSDKStatus: read<(status: "compacting" | null) => void>("setSDKStatus"),
    addNotification: read<(notification: unknown) => void>("addNotification"),
    emitWarning:
      read<
        (warning: { readonly cause: string; readonly message: string }) => void
      >("emitWarning"),
    isNonInteractiveSession:
      typeof read("isNonInteractiveSession") === "boolean"
        ? read<boolean>("isNonInteractiveSession")
        : undefined,
    verbose:
      typeof read("verbose") === "boolean"
        ? read<boolean>("verbose")
        : undefined,
  };
}

function readStateSnapshot(session: Session): Record<string, unknown> {
  const state = (session as unknown as { readonly state?: unknown }).state;
  if (!isRecord(state)) return {};
  const snapshot =
    typeof state.unsafePeek === "function"
      ? (state.unsafePeek as () => unknown).call(state)
      : undefined;
  return isRecord(snapshot) ? snapshot : {};
}

function createSessionSystemMessageAppender(
  session: Session,
): (message: unknown) => void {
  return (message: unknown): void => {
    const record = isRecord(message) ? message : undefined;
    let text: string | undefined;

    if (
      record?.subtype === "memory_saved" &&
      Array.isArray(record.writtenPaths)
    ) {
      const verb = typeof record.verb === "string" ? record.verb : "Saved";
      const paths = record.writtenPaths.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
      const noun = paths.length === 1 ? "memory" : "memories";
      text = `${verb} ${noun}: ${paths.join(", ")}`;
    } else {
      text =
        (typeof record?.content === "string" && record.content) ||
        (typeof record?.message === "string" && record.message) ||
        (typeof message === "string" && message) ||
        undefined;
    }

    if (!text) return;

    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "agent_message",
        payload: { message: text },
      },
    });
  };
}

function isSubagentTurn(ctx: TurnContext, sessionSource: unknown): boolean {
  if (ctx.depth > 0) return true;
  if (ctx.sessionSource === "cli_subagent") return true;
  if (typeof sessionSource === "string")
    return sessionSource === "cli_subagent";
  if (isRecord(sessionSource)) return sessionSource.kind === "subagent";
  return false;
}

function inferAgentId(
  session: Session,
  ctx: TurnContext,
  surface: SessionSurface,
  querySource?: string,
): string | undefined {
  if (surface.agentId) return surface.agentId;
  if (querySource?.startsWith("agent:")) {
    const [, id] = querySource.split(":", 2);
    return id || session.conversationId;
  }
  if (isSubagentTurn(ctx, session.services.querySource)) {
    return session.conversationId;
  }
  return undefined;
}
