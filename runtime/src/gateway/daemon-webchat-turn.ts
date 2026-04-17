import { WebChatChannel } from "../channels/webchat/plugin.js";
import type {
  ChatExecutor,
  ChatExecutorResult,
  ChatToolRoutingSummary,
} from "../llm/chat-executor.js";
import type { ChatExecutionTraceEvent } from "../llm/chat-executor-types.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { collectAttachments } from "../llm/attachment-injection.js";
import { normalizePromptEnvelope } from "../llm/prompt-envelope.js";
import type {
  LLMProviderTraceEvent,
  StreamProgressCallback,
  ToolHandler,
} from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import { buildChatUsagePayload } from "./chat-usage.js";
import { summarizeLLMFailureForSurface } from "./daemon-llm-failure.js";
import {
  buildSessionInteractiveContext,
  buildRuntimeContractStatusSnapshotForSession,
  buildSessionActiveTaskContext,
  persistSessionInteractiveContext,
  buildSessionStatefulOptions,
  enrichRuntimeContractSnapshotForSession,
  persistSessionActiveTaskContext,
  persistSessionStartContextMessages,
  persistSessionRuntimeContractSnapshot,
  persistSessionRuntimeContractStatusSnapshot,
  persistSessionStatefulContinuation,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  appendTranscriptBatch,
  createTranscriptHistorySnapshotEvent,
  createTranscriptMessageEvent,
  createTranscriptMetadataProjectionEvent,
} from "./session-transcript.js";
import { resolveAtMentionAttachments } from "./at-mention-attachments.js";
import { filterSystemPromptForToolRouting } from "./system-prompt-routing.js";
import {
  buildRuntimeContractSessionTraceId,
  logExecutionTraceEvent,
  logProviderPayloadTraceEvent,
  logTraceErrorEvent,
  logTraceEvent,
  summarizeCallUsageForTrace,
  summarizeHistoryForTrace,
  summarizeInitialRequestShape,
  summarizeRoleCounts,
  summarizeToolArgsForLog,
  summarizeToolFailureForLog,
  summarizeToolResultForTrace,
  summarizeToolRoutingDecisionForTrace,
  summarizeToolRoutingSummaryForTrace,
  summarizeTraceValue,
  truncateToolLogText,
  type ResolvedTraceLoggingConfig,
  type ToolFailureSummary,
} from "./daemon-trace.js";
import type { HookDispatcher } from "./hooks.js";
import type { GatewayMessage } from "./message.js";
import {
  resolveSessionShellProfile,
  SESSION_SHELL_PROFILE_METADATA_KEY,
  type SessionShellProfile,
  type Session,
  type SessionManager,
} from "./session.js";
import { appendShellProfilePromptSection } from "./shell-profile.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import { resolveTurnMaxToolRounds } from "./tool-round-budget.js";
import { buildAssistantDelegatedScopeMetadata } from "../utils/delegated-scope-trust.js";
import type { AgentDefinition } from "./agent-loader.js";
import type { DelegationVerifierService } from "./delegation-runtime.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import type { SubAgentManager } from "./sub-agent.js";
import type { TaskStore } from "../tools/system/task-tracker.js";
import { seedSessionReadState } from "../tools/system/filesystem.js";
import type { ExecutionEnvelope } from "../workflow/execution-envelope.js";
import {
  buildInteractivePromptSnapshot,
  buildInteractiveToolScopeFingerprint,
  type InteractiveContextState,
} from "./interactive-context.js";

interface WebChatTurnSignals {
  signalThinking: (sessionId: string) => void;
  signalIdle: (sessionId: string) => void;
}

interface ExecuteWebChatConversationTurnParams {
  readonly logger: Logger;
  readonly msg: GatewayMessage;
  readonly webChat: WebChatChannel;
  readonly chatExecutor: ChatExecutor;
  readonly sessionMgr: SessionManager;
  readonly getSystemPrompt: () => string;
  readonly sessionToolHandler: ToolHandler;
  readonly sessionStreamCallback: StreamProgressCallback;
  readonly signals: WebChatTurnSignals;
  readonly hooks: HookDispatcher;
  readonly memoryBackend: MemoryBackend;
  readonly sessionTokenBudget: number;
  readonly defaultMaxToolRounds: number;
  readonly contextWindowTokens?: number;
  readonly traceConfig: ResolvedTraceLoggingConfig;
  readonly turnTraceId: string;
  readonly buildToolRoutingDecision: (
    sessionId: string,
    content: string,
    history: Session["history"],
    advertisedToolNames: readonly string[],
  ) => ToolRoutingDecision | undefined;
  readonly resolveAdvertisedToolNames?: (
    sessionId: string,
    shellProfile: SessionShellProfile,
    discoveredToolNames?: readonly string[],
  ) => readonly string[];
  readonly recordToolRoutingOutcome: (
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ) => void;
  readonly getSessionTokenUsage: (sessionId: string) => number;
  readonly onModelInfo?: (result: ChatExecutorResult) => void;
  readonly onSubagentSynthesis?: (result: ChatExecutorResult) => void;
  readonly subAgentManager?: Pick<SubAgentManager, "spawn" | "waitForResult"> | null;
  readonly verifierService?: Pick<
    DelegationVerifierService,
    "resolveVerifierRequirement" | "shouldVerifySubAgentResult"
  > | null;
  readonly workerManager?: PersistentWorkerManager | null;
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly taskStore?: TaskStore | null;
  readonly readTodosForSession?: (
    sessionId: string,
  ) => Promise<
    readonly import("../tools/system/todo-store.js").TodoItem[]
  >;
  readonly maybeStartBackgroundRun?: (params: {
    readonly session: Session;
    readonly objective: string;
    readonly runtimeWorkspaceRoot?: string;
    readonly effectiveHistory: readonly import("../llm/types.js").LLMMessage[];
    readonly executionEnvelope?: ExecutionEnvelope;
  }) => Promise<boolean>;
}

function uniqueToolNames(toolNames: readonly string[]): readonly string[] {
  return Array.from(new Set(toolNames.map((toolName) => toolName.trim()).filter(Boolean)));
}

async function resolveWebChatTurnWorkspaceRoot(params: {
  readonly webChat: WebChatChannel;
  readonly sessionId: string;
  readonly messageWorkspaceRoot: unknown;
}): Promise<string | undefined> {
  const sessionWorkspaceRoot =
    typeof params.webChat.loadSessionWorkspaceRoot === "function"
      ? await params.webChat.loadSessionWorkspaceRoot(params.sessionId)
      : undefined;
  if (
    typeof sessionWorkspaceRoot === "string" &&
    sessionWorkspaceRoot.trim().length > 0
  ) {
    return sessionWorkspaceRoot.trim();
  }
  if (
    typeof params.messageWorkspaceRoot === "string" &&
    params.messageWorkspaceRoot.trim().length > 0
  ) {
    return params.messageWorkspaceRoot.trim();
  }
  return undefined;
}

function buildInteractiveTurnState(params: {
  readonly session: Session;
  readonly runtimeWorkspaceRoot?: string;
  readonly baseSystemPrompt: string;
  readonly readSeeds: readonly import("../tools/system/filesystem.js").SessionReadSeedEntry[];
  readonly advertisedToolNames: readonly string[];
  readonly discoveredToolNames?: readonly string[];
}): InteractiveContextState {
  const existing =
    params.session.metadata["interactiveContextState"] as
      | InteractiveContextState
      | undefined;
  return {
    version: 1,
    readSeeds: params.readSeeds,
    ...(params.runtimeWorkspaceRoot
      ? {
          executionLocation: {
            mode: "local",
            workspaceRoot: params.runtimeWorkspaceRoot,
            workingDirectory: params.runtimeWorkspaceRoot,
          } as const,
        }
      : existing?.executionLocation
        ? { executionLocation: existing.executionLocation }
        : {}),
    cacheSafePromptSnapshot: buildInteractivePromptSnapshot({
      baseSystemPrompt: params.baseSystemPrompt,
      systemContextBlocks: [],
      userContextBlocks: [],
      sessionStartContextMessages:
        existing?.cacheSafePromptSnapshot?.sessionStartContextMessages ?? [],
      toolScopeFingerprint: buildInteractiveToolScopeFingerprint(
        params.advertisedToolNames,
      ),
    }),
    ...(params.advertisedToolNames.length > 0
      ? { defaultAdvertisedToolNames: params.advertisedToolNames }
      : existing?.defaultAdvertisedToolNames
        ? { defaultAdvertisedToolNames: existing.defaultAdvertisedToolNames }
        : {}),
    ...(params.discoveredToolNames && params.discoveredToolNames.length > 0
      ? { discoveredToolNames: params.discoveredToolNames }
      : existing?.discoveredToolNames
        ? { discoveredToolNames: existing.discoveredToolNames }
        : {}),
    ...(existing?.summaryRef ? { summaryRef: existing.summaryRef } : {}),
    ...(existing?.forkCarryover ? { forkCarryover: existing.forkCarryover } : {}),
  };
}

export async function executeWebChatConversationTurn(
  params: ExecuteWebChatConversationTurnParams,
): Promise<ChatExecutorResult | undefined> {
  const {
    logger,
    msg,
    webChat,
    chatExecutor,
    sessionMgr,
    getSystemPrompt,
    sessionToolHandler,
    sessionStreamCallback,
    signals,
    hooks,
    memoryBackend,
    sessionTokenBudget,
    defaultMaxToolRounds,
    contextWindowTokens,
    traceConfig,
    turnTraceId,
    buildToolRoutingDecision,
    resolveAdvertisedToolNames,
    recordToolRoutingOutcome,
    getSessionTokenUsage,
    onModelInfo,
    onSubagentSynthesis,
    taskStore = null,
  } = params;

  try {
    signals.signalThinking(msg.sessionId);

    const session = sessionMgr.getOrCreate({
      channel: "webchat",
      senderId: msg.sessionId,
      scope: "dm",
      workspaceId: "default",
    }, {
      shellProfile:
        msg.metadata?.[SESSION_SHELL_PROFILE_METADATA_KEY],
    });
    const shellProfile = resolveSessionShellProfile(session.metadata);
    const existingInteractiveState =
      session.metadata["interactiveContextState"] as
        | InteractiveContextState
        | undefined;
    const advertisedToolNames =
      resolveAdvertisedToolNames?.(
        msg.sessionId,
        shellProfile,
        existingInteractiveState?.discoveredToolNames,
      ) ?? [];
    const toolRoutingDecision = buildToolRoutingDecision(
      msg.sessionId,
      msg.content,
      session.history,
      advertisedToolNames,
    );
    await appendTranscriptBatch(memoryBackend, msg.sessionId, [
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "user", content: msg.content },
        dedupeKey: `webchat:user:${turnTraceId}`,
      }),
    ]);
    const profileAwareSystemPrompt = appendShellProfilePromptSection({
      systemPrompt: getSystemPrompt(),
      profile: shellProfile,
    });
    const effectiveSystemPrompt = filterSystemPromptForToolRouting({
      systemPrompt: profileAwareSystemPrompt,
      routedToolNames: toolRoutingDecision?.routedToolNames,
    });
    const promptEnvelope = normalizePromptEnvelope({
      baseSystemPrompt: effectiveSystemPrompt,
    });

    if (traceConfig.enabled) {
      const requestTracePayload = {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        historyLength: session.history.length,
        historyRoleCounts: summarizeRoleCounts(session.history),
        systemPromptChars: effectiveSystemPrompt.length,
        ...(traceConfig.includeSystemPrompt
          ? {
              systemPrompt: truncateToolLogText(
                effectiveSystemPrompt,
                traceConfig.maxChars,
              ),
            }
          : {}),
        ...(traceConfig.includeHistory
          ? {
              history: summarizeHistoryForTrace(session.history, traceConfig),
            }
          : {}),
      };
      logTraceEvent(
        logger,
        "webchat.chat.request",
        requestTracePayload,
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            historyLength: session.history.length,
            historyRoleCounts: summarizeRoleCounts(session.history),
            systemPromptChars: effectiveSystemPrompt.length,
            ...(traceConfig.includeSystemPrompt
              ? { systemPrompt: effectiveSystemPrompt }
              : {}),
            ...(traceConfig.includeHistory ? { history: session.history } : {}),
          },
        },
      );
    }
    if (traceConfig.enabled && toolRoutingDecision) {
      logTraceEvent(
        logger,
        "webchat.tool_routing",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          routing: summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
        },
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            routing: toolRoutingDecision,
          },
        },
      );
    }

    const abortController = webChat.createAbortController(msg.sessionId);
    const sessionStateful = buildSessionStatefulOptions(session);
    const sessionActiveTaskContext = buildSessionActiveTaskContext(session);
    const effectiveMaxToolRounds = resolveTurnMaxToolRounds(
      defaultMaxToolRounds,
      toolRoutingDecision,
    );
    const runtimeWorkspaceRoot = await resolveWebChatTurnWorkspaceRoot({
      webChat,
      sessionId: msg.sessionId,
      messageWorkspaceRoot: msg.metadata?.workspaceRoot,
    });
    const effectiveMessage =
      typeof runtimeWorkspaceRoot === "string"
        ? {
            ...msg,
            metadata: {
              ...(msg.metadata ?? {}),
              workspaceRoot: runtimeWorkspaceRoot,
            },
          }
        : msg;
    const atMentionAttachments = await resolveAtMentionAttachments({
      content: effectiveMessage.content,
      workspaceRoot: runtimeWorkspaceRoot,
    });
    seedSessionReadState(msg.sessionId, atMentionAttachments.readSeeds);
    const routedToolNames =
      toolRoutingDecision?.routedToolNames ?? advertisedToolNames;
    const expandedToolNames = uniqueToolNames([
      ...advertisedToolNames,
      ...(toolRoutingDecision?.expandedToolNames ?? []),
    ]);
    const interactiveTurnState = buildInteractiveTurnState({
      session,
      runtimeWorkspaceRoot,
      baseSystemPrompt: effectiveSystemPrompt,
      readSeeds: atMentionAttachments.readSeeds,
      advertisedToolNames,
      discoveredToolNames: existingInteractiveState?.discoveredToolNames,
    });
    persistSessionInteractiveContext(session, interactiveTurnState);
    const sessionInteractiveContext = buildSessionInteractiveContext(session, {
      overrideState: interactiveTurnState,
    });
    const historyBeforeAttachments =
      atMentionAttachments.historyPrelude.length > 0
        ? [...session.history, ...atMentionAttachments.historyPrelude]
        : session.history;
    const todosForAttachment = params.readTodosForSession
      ? await params.readTodosForSession(msg.sessionId)
      : [];
    const runtimeAttachments = collectAttachments({
      history: historyBeforeAttachments,
      activeToolNames: new Set<string>(advertisedToolNames),
      todos: todosForAttachment,
    });
    const effectiveHistory =
      runtimeAttachments.messages.length > 0
        ? [...historyBeforeAttachments, ...runtimeAttachments.messages]
        : historyBeforeAttachments;
    if (
      params.maybeStartBackgroundRun &&
      await params.maybeStartBackgroundRun({
        session,
        objective: effectiveMessage.content,
        runtimeWorkspaceRoot,
        effectiveHistory,
        executionEnvelope: atMentionAttachments.executionEnvelope,
      })
    ) {
      webChat.clearAbortController(msg.sessionId);
      return undefined;
    }

    // Phase E: webchat streaming caller migrated to drain the
    // Phase C generator. onStreamChunk pass-through is handled
    // inside executeChat() — the bridge queue forwards every
    // stream chunk through the supplied callback before yielding
    // the event, so the caller-visible callback behavior is
    // identical to the direct chatExecutor.execute() call.
    const rawResult = await executeChatToLegacyResult(chatExecutor, {
      message: effectiveMessage,
      history: effectiveHistory,
      promptEnvelope,
      sessionId: msg.sessionId,
      runtimeContext:
        typeof runtimeWorkspaceRoot === "string" || sessionActiveTaskContext
          ? {
              ...(typeof runtimeWorkspaceRoot === "string"
                ? { workspaceRoot: runtimeWorkspaceRoot }
                : {}),
              ...(sessionActiveTaskContext
                ? { activeTaskContext: sessionActiveTaskContext }
                : {}),
            }
          : undefined,
      ...(atMentionAttachments.executionEnvelope
        ? {
            requiredToolEvidence: {
              executionEnvelope: atMentionAttachments.executionEnvelope,
            },
          }
        : {}),
      toolHandler: sessionToolHandler,
      onStreamChunk: sessionStreamCallback,
      signal: abortController.signal,
      maxToolRounds: effectiveMaxToolRounds,
      ...(sessionStateful ? { stateful: sessionStateful } : {}),
      ...(sessionInteractiveContext
        ? { interactiveContext: sessionInteractiveContext }
        : {}),
      toolRouting: {
        advertisedToolNames,
        routedToolNames,
        expandedToolNames,
        expandOnMiss: true,
        persistDiscovery: true,
      },
      trace: {
        ...(traceConfig.enabled && traceConfig.includeProviderPayloads
          ? {
              includeProviderPayloads: true,
              onProviderTraceEvent: (event: LLMProviderTraceEvent) => {
                logProviderPayloadTraceEvent({
                  logger,
                  channelName: "webchat",
                  traceId: turnTraceId,
                  sessionId: msg.sessionId,
                  traceConfig,
                  event,
                });
              },
            }
          : {}),
        onExecutionTraceEvent: (event: ChatExecutionTraceEvent) => {
          if (traceConfig.enabled) {
            logExecutionTraceEvent({
              logger,
              channelName: "webchat",
              traceId: turnTraceId,
              sessionId: msg.sessionId,
              traceConfig,
              event,
            });
          }
        },
      },
    });
    const result = await enrichRuntimeContractSnapshotForSession({
      sessionId: msg.sessionId,
      result: rawResult,
      taskStore,
      workerManager: params.workerManager,
    });
    persistSessionRuntimeContractSnapshot(session, result);
    const runtimeContractStatusSnapshot =
      await buildRuntimeContractStatusSnapshotForSession({
        sessionId: msg.sessionId,
        turnTraceId,
        result,
        taskStore,
        workerManager: params.workerManager,
      });
    persistSessionRuntimeContractStatusSnapshot(
      session,
      runtimeContractStatusSnapshot,
    );
    recordToolRoutingOutcome(msg.sessionId, result.toolRoutingSummary);

    if (traceConfig.enabled && runtimeContractStatusSnapshot) {
      logTraceEvent(
        logger,
        "runtime_contract.session.snapshot_updated",
        {
          traceId: buildRuntimeContractSessionTraceId(msg.sessionId),
          sessionId: msg.sessionId,
          lastTurnTraceId: runtimeContractStatusSnapshot.lastTurnTraceId,
          updatedAt: runtimeContractStatusSnapshot.updatedAt,
          completionState: runtimeContractStatusSnapshot.completionState,
          stopReason: runtimeContractStatusSnapshot.stopReason,
          openTaskCount: runtimeContractStatusSnapshot.openTasks.length,
          openWorkerCount: runtimeContractStatusSnapshot.openWorkers.length,
          remainingMilestoneCount:
            runtimeContractStatusSnapshot.remainingMilestones.length,
          omittedTaskCount: runtimeContractStatusSnapshot.omittedTaskCount,
          omittedWorkerCount: runtimeContractStatusSnapshot.omittedWorkerCount,
          omittedMilestoneCount:
            runtimeContractStatusSnapshot.omittedMilestoneCount,
          snapshot: runtimeContractStatusSnapshot,
        },
        traceConfig.maxChars,
      );
    }

    webChat.clearAbortController(msg.sessionId);
    onModelInfo?.(result);

    if (traceConfig.enabled) {
      const responseTracePayload = {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        provider: result.provider,
        model: result.model,
        usedFallback: result.usedFallback,
        durationMs: result.durationMs,
        compacted: result.compacted,
        tokenUsage: result.tokenUsage,
        requestShape: summarizeInitialRequestShape(result.callUsage),
        callUsage: summarizeCallUsageForTrace(result.callUsage),
        plannerSummary: result.plannerSummary,
        economicsSummary: result.economicsSummary,
        toolRoutingDecision:
          summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
        toolRoutingSummary: summarizeToolRoutingSummaryForTrace(
          result.toolRoutingSummary,
        ),
        stopReason: result.stopReason,
        completionState: result.completionState,
        runtimeContractSnapshot: result.runtimeContractSnapshot,
        runtimeContractStatusSnapshot,
        stopReasonDetail: result.stopReasonDetail,
        response: truncateToolLogText(result.content, traceConfig.maxChars),
        toolCalls: result.toolCalls.map((toolCall) => ({
          name: toolCall.name,
          durationMs: toolCall.durationMs,
          isError: toolCall.isError,
          ...(traceConfig.includeToolArgs
            ? {
                args:
                  summarizeToolArgsForLog(toolCall.name, toolCall.args) ??
                  summarizeTraceValue(toolCall.args, traceConfig.maxChars),
              }
            : {}),
          ...(traceConfig.includeToolResults
            ? {
                result: summarizeToolResultForTrace(
                  toolCall.result,
                  traceConfig.maxChars,
                ),
              }
            : {}),
        })),
      };
      logTraceEvent(
        logger,
        "webchat.chat.response",
        responseTracePayload,
        traceConfig.maxChars,
        {
          artifactPayload: {
            traceId: turnTraceId,
            sessionId: msg.sessionId,
            provider: result.provider,
            model: result.model,
            usedFallback: result.usedFallback,
            durationMs: result.durationMs,
            compacted: result.compacted,
            tokenUsage: result.tokenUsage,
            requestShape: summarizeInitialRequestShape(result.callUsage),
            callUsage: result.callUsage,
            plannerSummary: result.plannerSummary,
            economicsSummary: result.economicsSummary,
            toolRoutingDecision,
            toolRoutingSummary: result.toolRoutingSummary,
            stopReason: result.stopReason,
            completionState: result.completionState,
            runtimeContractSnapshot: result.runtimeContractSnapshot,
            runtimeContractStatusSnapshot,
            stopReasonDetail: result.stopReasonDetail,
            response: result.content,
            toolCalls: result.toolCalls.map((toolCall) => ({
              name: toolCall.name,
              durationMs: toolCall.durationMs,
              isError: toolCall.isError,
              ...(traceConfig.includeToolArgs ? { args: toolCall.args } : {}),
              ...(traceConfig.includeToolResults
                ? { result: toolCall.result }
                : {}),
            })),
          },
        },
      );
    }
    if (result.stopReason !== "completed" && result.stopReason !== "tool_calls") {
      const stopReasonDetail =
        result.stopReasonDetail ?? result.content ?? "LLM execution did not complete";
      throw Object.assign(new Error(stopReasonDetail), {
        stopReason: result.stopReason,
        stopReasonDetail,
      });
    }
    persistSessionStatefulContinuation(session, result);
    persistSessionActiveTaskContext(session, result);
    persistSessionStartContextMessages(session, result);
    persistSessionInteractiveContext(session, {
      ...interactiveTurnState,
      discoveredToolNames:
        result.toolDiscoverySummary?.discoveredToolNames ??
        interactiveTurnState.discoveredToolNames,
      cacheSafePromptSnapshot: buildInteractivePromptSnapshot({
        baseSystemPrompt: effectiveSystemPrompt,
        systemContextBlocks: [],
        userContextBlocks: [],
        sessionStartContextMessages:
          result.sessionStartContextMessages ??
          interactiveTurnState.cacheSafePromptSnapshot?.sessionStartContextMessages,
        toolScopeFingerprint: buildInteractiveToolScopeFingerprint(
          advertisedToolNames,
        ),
      }),
    });
    if (result.compacted) {
      await sessionMgr.compact(session.id);
    }

    signals.signalIdle(msg.sessionId);
    sessionMgr.appendMessage(session.id, {
      role: "user",
      content: msg.content,
    });
    sessionMgr.appendMessage(session.id, {
      role: "assistant",
      content: result.content,
    });
    const overflowCompaction =
      typeof sessionMgr.flushPendingCompaction === "function"
        ? await sessionMgr.flushPendingCompaction(session.id)
        : null;
    await appendTranscriptBatch(memoryBackend, msg.sessionId, [
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "assistant", content: result.content },
        dedupeKey: `webchat:assistant:${turnTraceId}`,
      }),
      createTranscriptMetadataProjectionEvent({
        surface: "webchat",
        key: "session.metadata",
        value: session.metadata,
        dedupeKey: `webchat:metadata:${turnTraceId}`,
      }),
      ...(result.compacted || (overflowCompaction?.messagesRemoved ?? 0) > 0
        ? [
            createTranscriptHistorySnapshotEvent({
              surface: "webchat",
              history: session.history,
              reason: "compaction",
              dedupeKey: `webchat:snapshot:${turnTraceId}`,
            }),
          ]
        : []),
    ]);
    await persistWebSessionRuntimeState(memoryBackend, msg.sessionId, session);

    await webChat.send({
      sessionId: msg.sessionId,
      content: result.content || "(no response)",
    });

    webChat.pushToSession(msg.sessionId, {
      type: "chat.usage",
      payload: buildChatUsagePayload({
        sessionId: msg.sessionId,
        totalTokens: getSessionTokenUsage(msg.sessionId),
        sessionTokenBudget,
        compacted: result.compacted ?? false,
        provider: result.provider,
        model: result.model,
        configuredModel: result.configuredModel,
        resolvedModel: result.resolvedModel,
        usedFallback: result.usedFallback,
        contextWindowTokens,
        callUsage: result.callUsage,
        economicsSummary: result.economicsSummary,
      }),
    });

    onSubagentSynthesis?.(result);

    webChat.broadcastEvent("chat.response", {
      sessionId: msg.sessionId,
      completionState: result.completionState,
      stopReason: result.stopReason,
      stopReasonDetail: result.stopReasonDetail,
    });

    const assistantMemoryMetadata = buildAssistantDelegatedScopeMetadata({
      content: result.content,
      toolCalls: result.toolCalls,
    });

    await hooks.dispatch("message:outbound", {
      sessionId: msg.sessionId,
      content: result.content,
      provider: result.provider,
      userMessage: msg.content,
      agentResponse: result.content,
      workspaceId: runtimeWorkspaceRoot,
      ...(assistantMemoryMetadata
        ? { agentResponseMetadata: assistantMemoryMetadata }
        : {}),
    });

    try {
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "user",
        content: msg.content,
      });
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "assistant",
        content: result.content,
        ...(assistantMemoryMetadata
          ? { metadata: assistantMemoryMetadata }
          : {}),
      });
    } catch (error) {
      logger.warn?.("Failed to persist messages to memory:", error);
    }

    if (result.toolCalls.length > 0) {
      const failures = result.toolCalls
        .map((toolCall) => summarizeToolFailureForLog(toolCall))
        .filter((entry): entry is ToolFailureSummary => entry !== null);

      logger.info(`Chat used ${result.toolCalls.length} tool call(s)`, {
        traceId: turnTraceId,
        tools: result.toolCalls.map((toolCall) => toolCall.name),
        provider: result.provider,
        failedToolCalls: failures.length,
        ...(failures.length > 0 ? { failureDetails: failures } : {}),
      });
    }
    return result;
  } catch (error) {
    const failure = summarizeLLMFailureForSurface(error);
    webChat.clearAbortController(msg.sessionId);
    signals.signalIdle(msg.sessionId);
    if (traceConfig.enabled) {
      logTraceErrorEvent(
        logger,
        "webchat.chat.error",
        {
          traceId: turnTraceId,
          sessionId: msg.sessionId,
          stopReason: failure.stopReason,
          stopReasonDetail: failure.stopReasonDetail,
          error: toErrorMessage(error),
          ...(error instanceof Error && error.stack
            ? {
                stack: truncateToolLogText(error.stack, traceConfig.maxChars),
              }
            : {}),
        },
        traceConfig.maxChars,
      );
    }
    logger.error("LLM chat error:", {
      stopReason: failure.stopReason,
      stopReasonDetail: failure.stopReasonDetail,
      error: toErrorMessage(error),
    });
    await webChat.send({
      sessionId: msg.sessionId,
      content: failure.userMessage,
    });
    return undefined;
  }
}
