import { getSystemPrompt } from "../../constants/prompts.js";
import { getSystemContext, getUserContext } from "../../context.js";
import { createEmptyToolPermissionContext } from "../../permissions/types.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type { Message } from "../../types/message.js";
import type { CacheSafeParams } from "../../utils/forkedAgent.js";
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from "../../utils/systemPrompt.js";
import type { CompactRuntimeAppState, CompactRuntimeContext } from "./context.js";

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
    (session.services as { permissionModeRegistry?: { current?: () => ReturnType<typeof createEmptyToolPermissionContext> } })
      .permissionModeRegistry;
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
