import type { LLMTool } from "../llm/types.js";
import type { LLMProvider } from "../llm/types.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { toAgenCModelContext } from "./model-context.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";

export interface AgenCToolUseContext {
  readonly abortController: AbortController;
  readonly agentId?: string;
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
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly isNonInteractiveSession: boolean;
    readonly cwd?: string;
    readonly verbose: boolean;
  };
  readonly getAppState: () => {
    readonly toolPermissionContext: unknown;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly tasks: Record<string, unknown>;
  };
  readonly readFileState: Map<string, unknown>;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly setStreamMode: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength: (updater: (length: number) => number) => void;
  readonly onCompactProgress: (event: unknown) => void;
  readonly setSDKStatus: (status: "compacting" | null) => void;
  readonly addNotification: (notification: unknown) => void;
  readonly emitWarning: (warning: { readonly cause: string; readonly message: string }) => void;
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

export function buildAgenCToolUseContext(
  session: Session,
  ctx: TurnContext,
  opts: { readonly querySource?: string; readonly verbose?: boolean } = {},
): AgenCToolUseContext {
  const model = toAgenCModelContext(ctx);
  const providerOverride = buildProviderOverride(session, model.model);
  const surface = readSessionSurface(session);
  const agentDefinitions = {
    activeAgents: Array.isArray(surface.agentDefinitions?.activeAgents)
      ? [...surface.agentDefinitions.activeAgents]
      : [],
  };
  const cwd = ctx.cwd;
  return {
    abortController: session.abortController ?? new AbortController(),
    sessionId: session.conversationId,
    options: {
      mainLoopModel: model.model,
      tools: toAgenCRuntimeTools(session.services.registry.toLLMTools()),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
      ...(opts.querySource !== undefined ? { querySource: opts.querySource } : {}),
      agentDefinitions,
      isNonInteractiveSession: false,
      cwd,
      verbose: opts.verbose ?? false,
    },
    getAppState: () => ({
      toolPermissionContext:
        session.permissionModeRegistry?.current?.() ??
        session.services.permissionModeRegistry?.current?.() ??
        createEmptyToolPermissionContext(),
      agentDefinitions,
      tasks: surface.tasks ?? {},
    }),
    readFileState: surface.readFileState ?? new Map<string, unknown>(),
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
    clearProviderResponseId: () => session.clearProviderResponseId(),
    ...(session.rolloutStore !== undefined ? { rolloutStore: session.rolloutStore } : {}),
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

type SessionSurface = {
  readonly readFileState?: Map<string, unknown>;
  readonly loadedNestedMemoryPaths?: Set<string>;
  readonly mcpClients?: readonly unknown[];
  readonly agentDefinitions?: { readonly activeAgents?: readonly unknown[] };
  readonly tasks?: Record<string, unknown>;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: unknown) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly addNotification?: (notification: unknown) => void;
  readonly emitWarning?: (warning: { readonly cause: string; readonly message: string }) => void;
};

function readSessionSurface(session: Session): SessionSurface {
  const snapshot = session.state.unsafePeek() as unknown as Record<string, unknown>;
  const direct = session as unknown as Record<string, unknown>;
  const read = <T>(key: keyof SessionSurface): T | undefined => {
    const directValue = direct[key];
    if (directValue !== undefined) return directValue as T;
    const snapshotValue = snapshot[key];
    if (snapshotValue !== undefined) return snapshotValue as T;
    return undefined;
  };
  return {
    readFileState: read<Map<string, unknown>>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions:
      read<{ readonly activeAgents?: readonly unknown[] }>("agentDefinitions"),
    tasks: read<Record<string, unknown>>("tasks"),
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
      read<(warning: { readonly cause: string; readonly message: string }) => void>(
        "emitWarning",
      ),
  };
}
