import type {
  ChatExecutor,
  ChatExecutorResult,
  ChatToolRoutingSummary,
} from "../llm/chat-executor.js";
import { executeChatToLegacyResult } from "../llm/execute-chat.js";
import { normalizePromptEnvelope } from "../llm/prompt-envelope.js";
import type {
  LLMProviderTraceEvent,
  LLMStructuredOutputRequest,
  ToolHandler,
} from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { Logger } from "../utils/logger.js";
import type { ChatExecutionTraceEvent } from "../llm/chat-executor-types.js";
import { hasActionableStatefulFallback } from "../llm/chat-executor-recovery.js";
import type { GatewayMessage } from "./message.js";
import {
  resolveSessionShellProfile,
  type Session,
  type SessionManager,
} from "./session.js";
import type { ToolRoutingDecision } from "./tool-routing.js";
import { resolveTurnMaxToolRounds } from "./tool-round-budget.js";
import {
  buildDaemonMemoryEntryOptions,
  shouldPersistToDaemonMemory,
} from "./channel-message-memory.js";
import {
  isConcordiaGenerateAgentsMessage,
} from "../llm/chat-executor-turn-contracts.js";
import {
  buildRuntimeContractStatusSnapshotForSession,
  buildSessionActiveTaskContext,
  buildSessionStatefulOptions,
  enrichRuntimeContractSnapshotForSession,
  persistSessionActiveTaskContext,
  persistSessionStartContextMessages,
  persistSessionRuntimeContractSnapshot,
  persistSessionRuntimeContractStatusSnapshot,
  persistSessionStatefulContinuation,
} from "./daemon-session-state.js";
import {
  appendTranscriptBatch,
  createTranscriptHistorySnapshotEvent,
  createTranscriptMessageEvent,
  createTranscriptMetadataProjectionEvent,
} from "./session-transcript.js";
import type { AgentDefinition } from "./agent-loader.js";
import type { DelegationVerifierService } from "./delegation-runtime.js";
import type { PersistentWorkerManager } from "./persistent-worker-manager.js";
import type { SubAgentManager } from "./sub-agent.js";
import type { TaskStore } from "../tools/system/task-tracker.js";
import { filterSystemPromptForToolRouting } from "./system-prompt-routing.js";
import { appendShellProfilePromptSection } from "./shell-profile.js";
import {
  buildRuntimeContractSessionTraceId,
  logExecutionTraceEvent,
  logProviderPayloadTraceEvent,
  logTraceEvent,
  summarizeCallUsageForTrace,
  summarizeHistoryForTrace,
  summarizeInitialRequestShape,
  summarizeRoleCounts,
  summarizeToolArgsForLog,
  summarizeToolResultForTrace,
  summarizeToolRoutingDecisionForTrace,
  summarizeToolRoutingSummaryForTrace,
  summarizeTraceValue,
  truncateToolLogText,
  type ResolvedTraceLoggingConfig,
} from "./daemon-trace.js";

const CONCORDIA_GENERATED_AGENTS_SCHEMA_NAME =
  "concordia_generated_agents";

function buildConcordiaGenerateAgentsStructuredOutput(
  msg: GatewayMessage,
): LLMStructuredOutputRequest | undefined {
  if (!isConcordiaGenerateAgentsMessage(msg)) {
    return undefined;
  }

  const countMatch = msg.content.match(/\bGenerate exactly\s+(\d+)\b/i);
  const expectedCount = countMatch ? Number.parseInt(countMatch[1] ?? "", 10) : undefined;
  const countBounds =
    typeof expectedCount === "number" && Number.isFinite(expectedCount) && expectedCount > 0
      ? { minItems: expectedCount, maxItems: expectedCount }
      : {};

  return {
    enabled: true,
    schema: {
      type: "json_schema",
      name: CONCORDIA_GENERATED_AGENTS_SCHEMA_NAME,
      strict: true,
      schema: {
        type: "array",
        ...countBounds,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "personality", "goal"],
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            },
            name: { type: "string", minLength: 1 },
            personality: { type: "string", minLength: 1 },
            goal: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

interface ExecuteTextChannelTurnParams {
  readonly logger: Logger;
  readonly channelName: string;
  readonly msg: GatewayMessage;
  readonly session: Session;
  readonly sessionMgr: SessionManager;
  readonly systemPrompt: string;
  readonly chatExecutor: ChatExecutor;
  readonly toolHandler: ToolHandler;
  readonly defaultMaxToolRounds: number;
  readonly traceConfig: ResolvedTraceLoggingConfig;
  readonly turnTraceId: string;
  readonly memoryBackend?: MemoryBackend | null;
  readonly includeTraceArtifacts?: boolean;
  readonly includePlannerSummaryInTrace?: boolean;
  readonly buildToolRoutingDecision: (
    sessionId: string,
    content: string,
    history: Session["history"],
  ) => ToolRoutingDecision | undefined;
  readonly recordToolRoutingOutcome: (
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ) => void;
  readonly persistToDaemonMemory?: boolean;
  readonly subAgentManager?: Pick<SubAgentManager, "spawn" | "waitForResult"> | null;
  readonly verifierService?: Pick<
    DelegationVerifierService,
    "resolveVerifierRequirement" | "shouldVerifySubAgentResult"
  > | null;
  readonly workerManager?: PersistentWorkerManager | null;
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly taskStore?: TaskStore | null;
}

export async function executeTextChannelTurn(
  params: ExecuteTextChannelTurnParams,
): Promise<ChatExecutorResult> {
  const {
    logger,
    channelName,
    msg,
    session,
    sessionMgr,
    systemPrompt,
    chatExecutor,
    toolHandler,
    defaultMaxToolRounds,
    traceConfig,
    turnTraceId,
    memoryBackend,
    includeTraceArtifacts = false,
    includePlannerSummaryInTrace = false,
    buildToolRoutingDecision,
    recordToolRoutingOutcome,
    persistToDaemonMemory = shouldPersistToDaemonMemory(msg),
    taskStore = null,
  } = params;

  const toolRoutingDecision = buildToolRoutingDecision(
    msg.sessionId,
    msg.content,
    session.history,
  );
  if (memoryBackend) {
    await appendTranscriptBatch(memoryBackend, msg.sessionId, [
      createTranscriptMessageEvent({
        surface: "text",
        message: { role: "user", content: msg.content },
        dedupeKey: `${channelName}:user:${turnTraceId}`,
      }),
    ]);
  }
  const profileAwareSystemPrompt = appendShellProfilePromptSection({
    systemPrompt,
    profile: resolveSessionShellProfile(session.metadata),
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
      `${channelName}.chat.request`,
      requestTracePayload,
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
            artifactPayload: {
              traceId: turnTraceId,
              sessionId: msg.sessionId,
              historyLength: session.history.length,
              historyRoleCounts: summarizeRoleCounts(session.history),
              systemPromptChars: effectiveSystemPrompt.length,
              ...(traceConfig.includeSystemPrompt
                ? { systemPrompt: effectiveSystemPrompt }
                : {}),
              ...(traceConfig.includeHistory
                ? { history: session.history }
                : {}),
            },
          }
        : undefined,
    );
  }
  if (traceConfig.enabled && toolRoutingDecision) {
    logTraceEvent(
      logger,
      `${channelName}.tool_routing`,
      {
        traceId: turnTraceId,
        sessionId: msg.sessionId,
        routing: summarizeToolRoutingDecisionForTrace(toolRoutingDecision),
      },
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
            artifactPayload: {
              traceId: turnTraceId,
              sessionId: msg.sessionId,
              routing: toolRoutingDecision,
            },
          }
        : undefined,
    );
  }

  const sessionStateful = buildSessionStatefulOptions(session);
  const sessionActiveTaskContext = buildSessionActiveTaskContext(session);
  const isConcordiaGenerateAgentsTurn = isConcordiaGenerateAgentsMessage(msg);
  const structuredOutput =
    buildConcordiaGenerateAgentsStructuredOutput(msg);
  const effectiveMaxToolRounds = resolveTurnMaxToolRounds(
    defaultMaxToolRounds,
    toolRoutingDecision,
  );
  // Phase E: text-channel caller now drains the Phase C generator
  // via executeChatToLegacyResult. Identical semantics to the
  // direct chatExecutor.execute() call under the adapter shape —
  // Phase F will swap the underlying orchestration without
  // touching this call site.
  const rawResult = await executeChatToLegacyResult(chatExecutor, {
    message: msg,
    history: session.history,
    promptEnvelope,
    sessionId: msg.sessionId,
    ...(sessionActiveTaskContext
      ? { runtimeContext: { activeTaskContext: sessionActiveTaskContext } }
      : {}),
    toolHandler,
    maxToolRounds: effectiveMaxToolRounds,
    ...(sessionStateful ? { stateful: sessionStateful } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    ...(isConcordiaGenerateAgentsTurn
      ? { contextInjection: { memory: false } }
      : {}),
    toolRouting: toolRoutingDecision
      ? {
          routedToolNames: toolRoutingDecision.routedToolNames,
          expandedToolNames: toolRoutingDecision.expandedToolNames,
          expandOnMiss: true,
        }
      : undefined,
    ...(traceConfig.enabled
      ? {
          trace: {
            ...(traceConfig.includeProviderPayloads
              ? {
                  includeProviderPayloads: true,
                  onProviderTraceEvent: (event: LLMProviderTraceEvent) => {
                    logProviderPayloadTraceEvent({
                      logger,
                      channelName,
                      traceId: turnTraceId,
                      sessionId: msg.sessionId,
                      traceConfig,
                      event,
                    });
                  },
                }
              : {}),
            onExecutionTraceEvent: (event: ChatExecutionTraceEvent) => {
              logExecutionTraceEvent({
                logger,
                channelName,
                traceId: turnTraceId,
                sessionId: msg.sessionId,
                traceConfig,
                event,
              });
            },
          },
        }
      : {}),
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
      statefulSummary: result.statefulSummary,
      ...(includePlannerSummaryInTrace
        ? { plannerSummary: result.plannerSummary }
        : {}),
      toolRoutingDecision: summarizeToolRoutingDecisionForTrace(
        toolRoutingDecision,
      ),
      toolRoutingSummary: summarizeToolRoutingSummaryForTrace(
        result.toolRoutingSummary,
      ),
      stopReason: result.stopReason,
      completionState: result.completionState,
      verifierSnapshot: result.verifierSnapshot,
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
      `${channelName}.chat.response`,
      responseTracePayload,
      traceConfig.maxChars,
      includeTraceArtifacts
        ? {
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
              statefulSummary: result.statefulSummary,
              ...(includePlannerSummaryInTrace
                ? { plannerSummary: result.plannerSummary }
                : {}),
              toolRoutingDecision,
              toolRoutingSummary: result.toolRoutingSummary,
              stopReason: result.stopReason,
              completionState: result.completionState,
              verifierSnapshot: result.verifierSnapshot,
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
          }
        : undefined,
    );
  }

  if (hasActionableStatefulFallback(result.statefulSummary)) {
    logger.warn(`[stateful] ${channelName} fallback_to_stateless`, {
      traceId: turnTraceId,
      sessionId: msg.sessionId,
      summary: result.statefulSummary,
    });
  }

  persistSessionStatefulContinuation(session, result);
  persistSessionActiveTaskContext(session, result);
  persistSessionStartContextMessages(session, result);
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
  if (memoryBackend) {
    await appendTranscriptBatch(memoryBackend, msg.sessionId, [
      createTranscriptMessageEvent({
        surface: "text",
        message: { role: "assistant", content: result.content },
        dedupeKey: `${channelName}:assistant:${turnTraceId}`,
      }),
      createTranscriptMetadataProjectionEvent({
        surface: "text",
        key: "session.metadata",
        value: session.metadata,
        dedupeKey: `${channelName}:metadata:${turnTraceId}`,
      }),
      ...(result.compacted || (overflowCompaction?.messagesRemoved ?? 0) > 0
        ? [
            createTranscriptHistorySnapshotEvent({
              surface: "text",
              history: session.history,
              reason: "compaction",
              dedupeKey: `${channelName}:snapshot:${turnTraceId}`,
            }),
          ]
        : []),
    ]);
  }

  if (memoryBackend && persistToDaemonMemory) {
    const persistenceOptions = buildDaemonMemoryEntryOptions(
      msg,
      session.workspaceId,
      channelName,
    );
    try {
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "user",
        content: msg.content,
        ...persistenceOptions,
      });
      await memoryBackend.addEntry({
        sessionId: msg.sessionId,
        role: "assistant",
        content: result.content,
        ...persistenceOptions,
      });
    } catch {
      // Non-critical memory persistence failures should not fail the chat turn.
    }
  }

  return result;
}
