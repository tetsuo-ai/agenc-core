import { getSystemPrompt } from "../constants/prompts.js";
import { getSystemContext, getUserContext } from "../context.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Message } from "../types/message.js";
import type { CacheSafeParams } from "../utils/forkedAgent.js";
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from "../utils/systemPrompt.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";

import type { Tool } from "../Tool.js";
import type { AgentId } from "../types/ids.js";
import type { EffortValue } from "../utils/effort.js";

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
  options: CompactRuntimeOptions;
  getAppState: () => CompactRuntimeAppState;
  readFileState: Map<string, unknown>;
  loadedNestedMemoryPaths?: Set<string>;
  setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  setResponseLength?: (updater: (length: number) => number) => void;
  onCompactProgress?: (event: unknown) => void;
  setSDKStatus?: (status: "compacting" | null) => void;
  addNotification?: (notification: unknown) => void;
  queryTracking?: {
    chainId?: string;
    depth?: number;
  };
  rolloutStore?: {
    getCompactionIndexSnapshot?: () => unknown;
    getToolResultBytesIndexSnapshot?: () => ReadonlyMap<string, number>;
    getToolCallTurnIdSnapshot?: () => ReadonlyMap<string, string>;
    store?: {
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

function buildAppState(
  session: Session,
  turnContext?: TurnContext,
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
    tasks: {},
    agentDefinitions: { activeAgents: [] },
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
  const appState = buildAppState(session, opts.turnContext);
  const cwd = opts.cwd ?? readCwd(session, opts.turnContext);
  return {
    abortController: session.abortController ?? new AbortController(),
    agentId: undefined,
    options: {
      tools: session.services.registry?.toLLMTools?.() ?? [],
      mainLoopModel: readMainLoopModel(session, opts.turnContext),
      mcpClients: [],
      customSystemPrompt: opts.customSystemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      verbose: opts.verbose ?? false,
      querySource: opts.querySource,
      agentDefinitions: appState.agentDefinitions,
      isNonInteractiveSession: opts.isNonInteractiveSession,
      ...(cwd ? { cwd } : {}),
    },
    getAppState: () => appState,
    readFileState: new Map<string, unknown>(),
    loadedNestedMemoryPaths: new Set<string>(),
    setStreamMode: () => {},
    setResponseLength: () => {},
    onCompactProgress: () => {},
    setSDKStatus: () => {},
    addNotification: () => {},
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
