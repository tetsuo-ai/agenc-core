import {
  buildEffectiveSystemPrompt,
  getSystemContext,
  getSystemPrompt,
  getUserContext,
  type SystemPrompt,
} from "./_deps/system-prompt.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Message } from "./_deps/types-message.js";
import type { CacheSafeParams } from "./_deps/forked-agent.js";
import type { Session } from "./session.js";
import {
  toTurnContextItem,
  type TurnContext,
  type TurnContextItem,
} from "./turn-context.js";

// Inlined stub: openclaude `Tool` type is gone post-gut.
type Tool = any;
import type { AgentId } from "./_deps/types-ids.js";
import type { EffortValue } from "./_deps/effort.js";

export interface CompactRuntimeAppState {
  toolPermissionContext: {
    additionalWorkingDirectories: ReadonlyMap<string, unknown>;
    mode?: string;
  };
  agentDefinitions: {
    activeAgents: unknown[];
  };
  tasks: Record<string, unknown>;
  effortValue?: EffortValue;
}

export interface CompactRuntimeOptions {
  tools: Tool[];
  mainLoopModel: string;
  mcpClients: readonly unknown[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  verbose?: boolean;
  querySource?: string;
  agentDefinitions: {
    activeAgents: unknown[];
  };
  isNonInteractiveSession?: boolean;
  cwd?: string;
}

export interface CompactRuntimeContext {
  abortController: AbortController;
  agentId?: AgentId;
  sessionId?: string;
  options: CompactRuntimeOptions;
  getAppState: () => CompactRuntimeAppState;
  referenceContextItem?: TurnContextItem;
  readFileState: Map<string, unknown>;
  loadedNestedMemoryPaths?: Set<string>;
  setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  setResponseLength?: (updater: (length: number) => number) => void;
  onCompactProgress?: (event: unknown) => void;
  setSDKStatus?: (status: "compacting" | null) => void;
  addNotification?: (notification: unknown) => void;
  emitWarning?: (warning: { cause: string; message: string }) => void;
  queryTracking?: {
    chainId?: string;
    depth?: number;
  };
  clearProviderResponseId?: () => void;
  /**
   * T5-owned rollout surface. `rolloutPath` is the authoritative path to
   * the current session's rollout JSONL (used to stamp compact summary
   * references). `store.reAppendSessionMetadata` is the authorized seam
   * for the I-12/I-49 metadata-at-EOF re-append after a compact boundary
   * (see docs/plan/feature-matrix.md:39 and runtime-owner-manifest.md:239-244).
   */
  rolloutStore?: {
    readonly rolloutPath?: string;
    getCompactionIndexSnapshot?: () => unknown;
    getToolResultBytesIndexSnapshot?: () => ReadonlyMap<string, number>;
    getToolCallTurnIdSnapshot?: () => ReadonlyMap<string, string>;
    store?: {
      readonly rolloutPath?: string;
      reAppendSessionMetadata?: () => void;
    };
  };
  session?: {
    rolloutStore?: CompactRuntimeContext["rolloutStore"];
  };
  cwd?: string;
}

export type ManualCompactContext = CompactRuntimeContext & {
  messages: Message[];
};

type SessionConfigurationSnapshot = {
  cwd?: string;
  collaborationMode?: {
    model?: string;
  };
};

type SessionCompactRuntimeSurface = {
  readFileState?: Map<string, unknown>;
  loadedNestedMemoryPaths?: Set<string>;
  mcpClients?: readonly unknown[];
  agentDefinitions?: {
    activeAgents?: unknown[];
  };
  tasks?: Record<string, unknown>;
  queryTracking?: {
    chainId?: string;
    depth?: number;
  };
  setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  setResponseLength?: (updater: (length: number) => number) => void;
  onCompactProgress?: (event: unknown) => void;
  setSDKStatus?: (status: "compacting" | null) => void;
  addNotification?: (notification: unknown) => void;
  emitWarning?: (warning: { cause: string; message: string }) => void;
};

function readSessionConfiguration(
  session: Session,
): SessionConfigurationSnapshot | undefined {
  if (
    "sessionConfiguration" in session &&
    session.sessionConfiguration !== undefined
  ) {
    return session.sessionConfiguration as SessionConfigurationSnapshot;
  }
  const snapshot = session.state.unsafePeek() as {
    sessionConfiguration?: SessionConfigurationSnapshot;
  };
  return snapshot.sessionConfiguration;
}

function readMainLoopModel(
  session: Session,
  turnContext?: TurnContext,
): string {
  if (turnContext?.modelInfo?.slug) {
    return turnContext.modelInfo.slug;
  }
  return (
    readSessionConfiguration(session)?.collaborationMode?.model ?? "unknown"
  );
}

function readCwd(session: Session, turnContext?: TurnContext): string | undefined {
  return turnContext?.cwd ?? readSessionConfiguration(session)?.cwd;
}

function readSessionCompactRuntimeSurface(
  session: Session,
): SessionCompactRuntimeSurface {
  const snapshot = session.state.unsafePeek() as unknown as Record<string, unknown>;
  const direct = session as unknown as Record<string, unknown>;
  const read = <T>(key: keyof SessionCompactRuntimeSurface): T | undefined => {
    const directValue = direct[key];
    if (directValue !== undefined) {
      return directValue as T;
    }
    const snapshotValue = snapshot?.[key];
    if (snapshotValue !== undefined) {
      return snapshotValue as T;
    }
    return undefined;
  };
  return {
    readFileState: read<Map<string, unknown>>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions: read<{ activeAgents?: unknown[] }>("agentDefinitions"),
    tasks: read<Record<string, unknown>>("tasks"),
    queryTracking: read<{ chainId?: string; depth?: number }>("queryTracking"),
    setStreamMode: read<
      (mode: "requesting" | "responding" | null) => void
    >("setStreamMode"),
    setResponseLength: read<(updater: (length: number) => number) => void>(
      "setResponseLength",
    ),
    onCompactProgress: read<(event: unknown) => void>("onCompactProgress"),
    setSDKStatus: read<(status: "compacting" | null) => void>("setSDKStatus"),
    addNotification: read<(notification: unknown) => void>("addNotification"),
    emitWarning: read<(warning: { cause: string; message: string }) => void>(
      "emitWarning",
    ),
  };
}

function normalizeAgentDefinitions(
  value: SessionCompactRuntimeSurface["agentDefinitions"],
): { activeAgents: unknown[] } {
  return {
    activeAgents: Array.isArray(value?.activeAgents) ? [...value.activeAgents] : [],
  };
}

function buildAppState(
  session: Session,
  turnContext?: TurnContext,
  surface?: SessionCompactRuntimeSurface,
): CompactRuntimeAppState {
  const registry =
    session.permissionModeRegistry ??
    (session.services as {
      permissionModeRegistry?: {
        current?: () => ReturnType<typeof createEmptyToolPermissionContext>;
      };
    }).permissionModeRegistry;
  const toolPermissionContext =
    registry?.current?.() ?? createEmptyToolPermissionContext();
  return {
    toolPermissionContext,
    tasks: surface?.tasks ?? {},
    agentDefinitions: normalizeAgentDefinitions(surface?.agentDefinitions),
    effortValue:
      turnContext?.reasoningEffort &&
      turnContext.reasoningEffort !== "none"
        ? turnContext.reasoningEffort
        : undefined,
  };
}

export function createSessionBackedCompactContext(
  session: Session,
  opts: {
    querySource: string;
    turnContext?: TurnContext;
    cwd?: string;
    isNonInteractiveSession: boolean;
    verbose?: boolean;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
  },
): CompactRuntimeContext {
  const surface = readSessionCompactRuntimeSurface(session);
  const getAppState = () => buildAppState(session, opts.turnContext, surface);
  const cwd = opts.cwd ?? readCwd(session, opts.turnContext);
  const readFileState = surface.readFileState ?? new Map<string, unknown>();
  const loadedNestedMemoryPaths =
    surface.loadedNestedMemoryPaths ?? new Set<string>();
  return {
    abortController: session.abortController ?? new AbortController(),
    agentId: undefined,
    sessionId: session.conversationId,
    options: {
      tools: session.services.registry?.toLLMTools?.() ?? [],
      mainLoopModel: readMainLoopModel(session, opts.turnContext),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      customSystemPrompt: opts.customSystemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      verbose: opts.verbose ?? false,
      querySource: opts.querySource,
      agentDefinitions: normalizeAgentDefinitions(surface.agentDefinitions),
      isNonInteractiveSession: opts.isNonInteractiveSession,
      ...(cwd ? { cwd } : {}),
    },
    getAppState,
    ...(opts.turnContext
      ? { referenceContextItem: toTurnContextItem(opts.turnContext) }
      : {}),
    readFileState,
    loadedNestedMemoryPaths,
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
    queryTracking: surface.queryTracking,
    clearProviderResponseId: () => session.clearProviderResponseId(),
    rolloutStore: session.rolloutStore ?? undefined,
    session: session.rolloutStore
      ? { rolloutStore: session.rolloutStore }
      : undefined,
    ...(cwd ? { cwd } : {}),
  };
}

export async function buildCompactCacheSafeParams(
  context: CompactRuntimeContext,
  forkContextMessages: Message[],
): Promise<CacheSafeParams> {
  const appState = context.getAppState();
  const defaultSystemPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    Array.from(context.options.mcpClients),
  );
  const systemPrompt: SystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context as never,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  });
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ]);
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context as never,
    forkContextMessages,
  };
}
