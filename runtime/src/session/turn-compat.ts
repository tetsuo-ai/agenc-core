import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { randomUUID, type UUID } from "node:crypto";
import type { z } from "zod/v4";

import type { LLMContentPart, LLMMessage, LLMTool, LLMToolCall } from "../llm/types.js";
import type { LLMUsage } from "../llm/types.js";
import { assertAgentRoleWorkspaceMatches } from "../agents/role.js";
import type { PhaseEvent } from "../phases/events.js";
import type { StopHookHandler, StopHookOutcome, StopRequest } from "../phases/stop-hooks.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { CanUseToolFn } from "../tui/hooks/useCanUseTool.js";
import type { Tool, ToolResult, ToolUseContext } from "../tools/Tool.js";
import { frameUntrustedToolHistoryMessages } from "../tools/untrusted-tool-result-framing.js";
import type { AttachmentMessage, Message } from "../types/message.js";
import { appendSystemContext, prependUserContext } from "../utils/api.js";
import { createAttachmentMessage } from "../utils/attachments.js";
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from "../utils/messages.js";
import type { SystemPrompt } from "../utils/systemPromptType.js";
import { zodToJsonSchema } from "../utils/zodToJsonSchema.js";
import { getCwdOverrideForCurrentContext } from "../utils/cwd.js";
import {
  runWithAgentMemoryAuthorization,
  type AgentMemoryAuthorization,
} from "../utils/agentContext.js";
import {
  getAgentName,
  getTeamName,
  isTeammate,
} from "../utils/teammate.js";
import { getTaskListId, listTasks } from "../utils/tasks.js";
import { Session, type SessionServices } from "./session.js";

type StructuredOutputMetadata = {
  readonly structuredOutput?: unknown;
  readonly compatMessages?: readonly Message[];
  readonly compatToolResultMessage?: Message;
};

const LEGACY_PROGRESS_MARKER = "__agenc_turn_compat_progress__:";

export interface TurnCompatParams {
  readonly messages: readonly Message[];
  readonly systemPrompt: SystemPrompt;
  readonly systemPromptTrust?: "trusted_internal" | "workspace_role";
  readonly userContext: Record<string, string>;
  readonly systemContext: Record<string, string>;
  readonly canUseTool: CanUseToolFn;
  readonly toolUseContext: ToolUseContext;
  readonly querySource: string;
  readonly maxTurns?: number;
  readonly maxOutputTokensOverride?: number;
  readonly skipCacheWrite?: boolean;
}

export interface TurnCompatSession {
  readonly session: Session;
  readonly history: LLMMessage[];
  readonly userMessage: string | readonly LLMContentPart[];
  readonly systemPrompt: string;
  readonly foregroundMemoryScope: ForegroundAgentMemoryScope;
}

type ForegroundAgentMemoryScope =
  | { readonly selected: false }
  | {
      readonly selected: true;
      readonly authorization: AgentMemoryAuthorization | undefined;
    };

export type TurnCompatRunEvent =
  | { readonly type: "phase"; readonly event: PhaseEvent }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "progress" }
  | { readonly type: "usage"; readonly usage: LLMUsage }
  | { readonly type: "max_turns"; readonly message: AttachmentMessage };

export async function createTurnCompatSession(
  parent: Session,
  params: TurnCompatParams,
  opts: { readonly conversationId?: string } = {},
): Promise<TurnCompatSession> {
  assertTurnCompatAgentCatalog(parent, params.toolUseContext);
  const catalogWorkspaceId =
    params.toolUseContext.options.agentDefinitions.agentRoleWorkspaceId;
  if (catalogWorkspaceId === undefined) {
    throw new Error("turn compatibility agent catalog provenance is missing");
  }
  const scopedAgentDefinitions = {
    ...params.toolUseContext.options.agentDefinitions,
    agentRoleWorkspaceId: catalogWorkspaceId,
  };
  const appState = params.toolUseContext.getAppState();
  const foregroundMemoryScope = resolveForegroundAgentMemoryScope(
    appState.agent,
    scopedAgentDefinitions.activeAgents,
  );
  const model = params.toolUseContext.options.mainLoopModel;
  const systemPrompt = appendSystemContext(
    params.systemPrompt,
    params.systemContext,
  ).join("\n\n");
  const { history, userMessage } = splitMessagesForTurn(
    prependUserContext([...params.messages], params.userContext),
  );
  const registry = await createToolRegistryFromToolContext({
    tools: params.toolUseContext.options.tools,
    toolUseContext: params.toolUseContext,
    canUseTool: params.canUseTool,
  });
  const effectiveCwd =
    getCwdOverrideForCurrentContext() ??
    parent.sessionConfiguration.cwd ??
    parent.config.cwd;
  const sessionConfiguration = {
    ...parent.sessionConfiguration,
    cwd: effectiveCwd,
    collaborationMode: {
      ...parent.sessionConfiguration.collaborationMode,
      model,
    },
  };
  const session = new Session({
    conversationId:
      opts.conversationId ??
      params.toolUseContext.agentId ??
      `${parent.conversationId}:turn:${randomUUID()}`,
    roleWorkspace: parent.roleWorkspace,
    agentDefinitions: scopedAgentDefinitions,
    initialState: {
      sessionConfiguration,
      history: [],
    },
    features: parent.features,
    services: {
      ...parent.services,
      registry,
      hooks: {
        ...parent.services.hooks,
        preToolUseHooks: [],
        postToolUseHooks: [],
        failureToolUseHooks: [],
        permissionDecisionHooks: [],
        stopHooks: [
          ...configuredCompatStopHooks(parent.services.hooks),
          createCompatSessionStopHook(params),
        ],
      },
      querySource: params.querySource,
      approvalResolver: {
        request: async () => ({ kind: "approved" }),
      },
      permissionModeRegistry: new PermissionModeRegistry(
        {
          ...appState.toolPermissionContext,
          mode: "bypassPermissions",
          isBypassPermissionsModeAvailable: true,
        } as unknown as ToolPermissionContext,
      ),
    } as SessionServices,
    jsRepl: parent.jsRepl,
    config: {
      ...parent.config,
      cwd: effectiveCwd,
      model,
    },
    modelInfo: {
      ...parent.modelInfo,
      slug: model,
      ...(params.maxOutputTokensOverride !== undefined
        ? { maxOutputTokens: params.maxOutputTokensOverride }
        : {}),
    },
  });
  attachToolContextSurface(session, params.toolUseContext);
  return {
    session,
    history,
    userMessage,
    systemPrompt,
    foregroundMemoryScope,
  };
}

export function assertTurnCompatAgentCatalog(
  parent: Pick<Session, "roleWorkspace">,
  toolUseContext: Pick<ToolUseContext, "options" | "getAppState">,
): void {
  assertAgentRoleWorkspaceMatches(
    parent.roleWorkspace,
    toolUseContext.options.agentDefinitions.agentRoleWorkspaceId,
  );
  const appState = toolUseContext.getAppState();
  assertAgentRoleWorkspaceMatches(
    parent.roleWorkspace,
    appState.agentDefinitions.agentRoleWorkspaceId,
  );
}

function configuredCompatStopHooks(
  hooks: SessionServices["hooks"],
): readonly StopHookHandler[] {
  const configured = (hooks as { readonly stopHooks?: readonly StopHookHandler[] })
    .stopHooks;
  return configured ?? [];
}

function createCompatSessionStopHook(
  params: TurnCompatParams,
): StopHookHandler {
  return {
    name: "compat_session_hooks",
    async run(request: StopRequest): Promise<StopHookOutcome> {
      const {
        executeStopHooks,
        getStopHookMessage,
        executeTaskCompletedHooks,
        executeTeammateIdleHooks,
        getTaskCompletedHookMessage,
        getTeammateIdleHookMessage,
      } = await import("../utils/hooks.js");
      const blockingFragments: string[] = [];
      let stopReason: string | undefined;
      let preventContinuation = false;
      const messages = buildStopHookMessages(params, request);

      for await (const result of executeStopHooks(
        request.permissionMode,
        params.toolUseContext.abortController.signal,
        undefined,
        request.stopHookActive,
        params.toolUseContext.agentId,
        params.toolUseContext,
        messages,
        params.toolUseContext.agentType,
      )) {
        if (result.preventContinuation) {
          preventContinuation = true;
          stopReason = result.stopReason;
        }
        if (result.blockingError) {
          blockingFragments.push(getStopHookMessage(result.blockingError));
        }
      }

      if (preventContinuation) {
        return {
          shouldStop: true,
          ...(stopReason !== undefined ? { stopReason } : {}),
          shouldBlock: false,
          continuationFragments: [],
        };
      }
      if (blockingFragments.length > 0) {
        return {
          shouldStop: false,
          shouldBlock: true,
          blockReason: blockingFragments.join("\n\n"),
          continuationFragments: blockingFragments,
        };
      }

      // After Stop hooks pass, run TaskCompleted and TeammateIdle hooks if
      // this session is a teammate. Mirrors the legacy handleStopHooks
      // teammate boundary (query/stopHooks.ts) which the unification dropped.
      if (isTeammate()) {
        const signal = params.toolUseContext.abortController.signal;
        const teammateName = getAgentName() ?? "";
        const teamName = getTeamName() ?? "";
        const teammateFragments: string[] = [];
        let teammatePrevented = false;
        let teammateStopReason: string | undefined;

        const taskListId = getTaskListId();
        const tasks = await listTasks(taskListId);
        const inProgressTasks = tasks.filter(
          (task) =>
            task.status === "in_progress" && task.owner === teammateName,
        );

        for (const task of inProgressTasks) {
          for await (const result of executeTaskCompletedHooks(
            task.id,
            task.subject,
            task.description,
            teammateName,
            teamName,
            request.permissionMode,
            signal,
            undefined,
            params.toolUseContext,
          )) {
            if (result.preventContinuation) {
              teammatePrevented = true;
              teammateStopReason =
                result.stopReason ||
                "TaskCompleted hook prevented continuation";
            }
            if (result.blockingError) {
              teammateFragments.push(
                getTaskCompletedHookMessage(result.blockingError),
              );
            }
          }
        }

        for await (const result of executeTeammateIdleHooks(
          teammateName,
          teamName,
          request.permissionMode,
          signal,
        )) {
          if (result.preventContinuation) {
            teammatePrevented = true;
            teammateStopReason =
              result.stopReason || "TeammateIdle hook prevented continuation";
          }
          if (result.blockingError) {
            teammateFragments.push(
              getTeammateIdleHookMessage(result.blockingError),
            );
          }
        }

        if (teammatePrevented) {
          return {
            shouldStop: true,
            ...(teammateStopReason !== undefined
              ? { stopReason: teammateStopReason }
              : {}),
            shouldBlock: false,
            continuationFragments: [],
          };
        }
        if (teammateFragments.length > 0) {
          return {
            shouldStop: false,
            shouldBlock: true,
            blockReason: teammateFragments.join("\n\n"),
            continuationFragments: teammateFragments,
          };
        }
      }

      return {
        shouldStop: true,
        shouldBlock: false,
        continuationFragments: [],
      };
    },
  };
}

function buildStopHookMessages(
  params: TurnCompatParams,
  request: StopRequest,
): Message[] {
  if (request.hookMessages !== undefined) {
    return [...request.hookMessages];
  }
  if (request.lastAssistantMessage === undefined) {
    return [...params.messages];
  }
  return [
    ...params.messages,
    createAssistantMessage({
      content: [
        { type: "text", text: request.lastAssistantMessage, citations: [] },
      ],
    }),
  ];
}

export async function* runTurnCompat(
  parent: Session,
  params: TurnCompatParams,
  opts: {
    readonly conversationId?: string;
    readonly signal?: AbortSignal;
  } = {},
): AsyncGenerator<TurnCompatRunEvent, void> {
  const turn = await createTurnCompatSession(parent, params, {
    ...(opts.conversationId !== undefined
      ? { conversationId: opts.conversationId }
      : {}),
  });
  let assistantText = "";
  let flushedToolAssistantText = "";
  let pendingToolCalls: LLMToolCall[] = [];
  let pendingToolAssistantUuid: UUID | undefined;
  let completedTurnCount = 0;
  const queuedEvents: TurnCompatRunEvent[] = [];
  let queueWake: (() => void) | null = null;

  const enqueueEvent = (event: TurnCompatRunEvent): void => {
    queuedEvents.push(event);
    const wake = queueWake;
    queueWake = null;
    wake?.();
  };
  const waitForQueuedEvent = async (): Promise<void> => {
    if (queuedEvents.length > 0) return;
    await new Promise<void>((resolve) => {
      queueWake = resolve;
    });
  };
  const drainQueuedEvents = function* (): Generator<TurnCompatRunEvent> {
    while (queuedEvents.length > 0) {
      const queued = queuedEvents.shift();
      if (queued) yield queued;
    }
  };
  const unsubscribe = turn.session.eventLog.subscribe((logged) => {
    if (isStreamProgressEventType(logged.msg.type)) {
      enqueueEvent({ type: "progress" });
      return;
    }
    const payload =
      logged.msg.type === "tool_progress" ? logged.msg.payload : undefined;
    if (!payload || !payload.chunk.startsWith(LEGACY_PROGRESS_MARKER)) return;
    const message = parseLegacyProgressMessage(payload.chunk);
    if (message) enqueueEvent({ type: "message", message });
  });

  const flushPendingToolAssistant = function* (): Generator<TurnCompatRunEvent> {
    if (pendingToolCalls.length === 0) return;
    const toolAssistantText = assistantText;
    const assistantMessage = createAssistantMessage({
      content: [
        ...(toolAssistantText.length > 0
          ? [{ type: "text" as const, text: toolAssistantText }]
          : []),
        ...pendingToolCalls.map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: parseToolInput(call.arguments),
        })),
      ] as Parameters<typeof createAssistantMessage>[0]["content"],
    });
    pendingToolCalls = [];
    pendingToolAssistantUuid = assistantMessage.uuid as UUID;
    flushedToolAssistantText = toolAssistantText;
    assistantText = "";
    yield { type: "message", message: assistantMessage };
  };

  const runAbortController = new AbortController();
  const forwardAbort = (): void => {
    if (runAbortController.signal.aborted) return;
    runAbortController.abort(
      (opts.signal as (AbortSignal & { readonly reason?: unknown }) | undefined)
        ?.reason,
    );
  };
  if (opts.signal?.aborted) {
    forwardAbort();
  } else {
    opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const foregroundMemoryScope = turn.foregroundMemoryScope;
  const runInForegroundMemoryScope = <T>(fn: () => T): T =>
    foregroundMemoryScope.selected
      ? runWithAgentMemoryAuthorization(
          foregroundMemoryScope.authorization,
          fn,
        )
      : fn();

  const iterator = runInForegroundMemoryScope(() =>
    turn.session.runTurn(turn.userMessage, {
      history: turn.history,
      systemPrompt: turn.systemPrompt,
      ...(params.systemPromptTrust !== undefined
        ? { systemPromptTrust: params.systemPromptTrust }
        : {}),
      signal: runAbortController.signal,
      querySource: params.querySource,
      ...(params.skipCacheWrite !== undefined
        ? { skipCacheWrite: params.skipCacheWrite }
        : {}),
      configOverrides:
        params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : undefined,
    }),
  );
  const requestNext = () =>
    runInForegroundMemoryScope(() => iterator.next());

  let next = requestNext();
  let completed = false;
  try {
    while (true) {
      yield* drainQueuedEvents();
      const raced = await Promise.race([
        next.then((step) => ({ type: "step" as const, step })),
        waitForQueuedEvent().then(() => ({ type: "queue" as const })),
      ]);
      if (raced.type === "queue") continue;
      queueWake = null;
      if (raced.step.done) {
        completed = true;
        break;
      }

      const event = raced.step.value;
      yield { type: "phase", event };
      if (event.type === "assistant_text") {
        assistantText = event.content;
        flushedToolAssistantText = "";
        next = requestNext();
        continue;
      }

      if (event.type === "tool_call") {
        pendingToolCalls = [...pendingToolCalls, event.toolCall];
        next = requestNext();
        continue;
      }

      if (event.type === "tool_result") {
        yield* flushPendingToolAssistant();
        const metadata = event.result.metadata as StructuredOutputMetadata | undefined;
        for (const message of metadata?.compatMessages ?? []) {
          yield { type: "message", message };
        }
        if (
          metadata?.structuredOutput !== undefined &&
          !hasStructuredOutputAttachment(metadata.compatMessages)
        ) {
          yield {
            type: "message",
            message: createAttachmentMessage({
              type: "structured_output",
              data: metadata.structuredOutput,
            }),
          };
        }
        yield {
          type: "message",
          message: withSourceToolAssistantUuid(
            metadata?.compatToolResultMessage ??
              createUserMessage({
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: event.toolCall.id,
                    content: event.result.content,
                    is_error: event.result.isError === true,
                  },
                ],
                toolUseResult: event.result,
              }),
            pendingToolAssistantUuid,
          ),
        };
        next = requestNext();
        continue;
      }

      if (event.type === "queued_command") {
        if (isVisibleQueuedCommandEvent(event)) {
          yield {
            type: "message",
            message: createUserMessage({
              content: event.displayText,
              uuid: event.uuid,
            }),
          };
        }
        next = requestNext();
        continue;
      }

      if (event.type === "turn_complete") {
        yield* flushPendingToolAssistant();
        completedTurnCount += 1;
        yield { type: "usage", usage: event.usage };
        if (event.stopReason === "error") {
          yield {
            type: "message",
            message: createAssistantAPIErrorMessage({
              content: event.error?.message ?? "turn errored",
            }),
          };
          next = requestNext();
          continue;
        }
        if (event.stopReason === "max_turns") {
          yield {
            type: "max_turns",
            message: createAttachmentMessage({
              type: "max_turns_reached",
              maxTurns: params.maxTurns ?? 0,
              turnCount: completedTurnCount + 1,
            }),
          };
          next = requestNext();
          continue;
        }
        if (
          event.content.length > 0 &&
          event.content !== flushedToolAssistantText
        ) {
          yield {
            type: "message",
            message: createAssistantMessage({
              content: event.content,
              usage: llmUsageToLegacyUsage(event.usage) as never,
            }),
          };
        }
      }
      next = requestNext();
    }
    yield* drainQueuedEvents();
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
    if (!completed && !runAbortController.signal.aborted) {
      runAbortController.abort(new Error("turn compatibility stream closed"));
    }
    await runInForegroundMemoryScope(
      () => iterator.return?.({ reason: "cancelled" }),
    );
    unsubscribe();
    queueWake = null;
  }
}

/**
 * Resolve the legacy/main-thread selected role from the same canonical catalog
 * envelope that is copied into the compatibility Session. A present but stale
 * selection is an explicit deny; it must never inherit an unrelated ambient
 * agent grant.
 */
function resolveForegroundAgentMemoryScope(
  selectedAgentType: string | undefined,
  activeAgents: ToolUseContext['options']['agentDefinitions']['activeAgents'],
): ForegroundAgentMemoryScope {
  if (selectedAgentType === undefined) {
    return { selected: false };
  }
  const selectedAgent = activeAgents
    .find((agent) => agent.agentType === selectedAgentType);
  return {
    selected: true,
    ...(selectedAgent?.memory !== undefined
      ? {
          authorization: {
            agentType: selectedAgent.agentType,
            scope: selectedAgent.memory,
          },
        }
      : { authorization: undefined }),
  };
}

function parseLegacyProgressMessage(chunk: string): Message | null {
  try {
    return JSON.parse(chunk.slice(LEGACY_PROGRESS_MARKER.length)) as Message;
  } catch {
    return null;
  }
}

function hasStructuredOutputAttachment(messages: readonly Message[] | undefined): boolean {
  return (messages ?? []).some(
    (message) =>
      message?.type === "attachment" &&
      message.attachment?.type === "structured_output",
  );
}

function isStreamProgressEventType(type: string): boolean {
  return (
    type === "agent_message_delta" ||
    type === "assistant_thinking_delta" ||
    type === "tool_input_delta"
  );
}

function withSourceToolAssistantUuid(message: Message, uuid: UUID | undefined): Message {
  if (uuid === undefined || message?.type !== "user") return message;
  return {
    ...message,
    sourceToolAssistantUUID: uuid,
  };
}

function isVisibleQueuedCommandEvent(
  event: PhaseEvent,
): event is Extract<PhaseEvent, { readonly type: "queued_command" }> {
  return (
    event.type === "queued_command" &&
    event.commandMode === "prompt" &&
    event.isMeta !== true &&
    (event.originKind === undefined || event.originKind === "human")
  );
}

function llmUsageToLegacyUsage(usage: LLMUsage): Record<string, unknown> {
  return {
    input_tokens: usage.promptTokens ?? 0,
    output_tokens: usage.completionTokens ?? 0,
    cache_read_input_tokens: usage.cachedInputTokens ?? 0,
    cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    server_tool_use: {
      web_search_requests: usage.webSearchRequests ?? 0,
      web_fetch_requests: 0,
    },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  };
}

export function structuredOutputFromToolResult(
  result: ToolDispatchResult,
): unknown | undefined {
  return (result.metadata as StructuredOutputMetadata | undefined)
    ?.structuredOutput;
}

function attachToolContextSurface(
  session: Session,
  toolUseContext: ToolUseContext,
): void {
  Object.assign(session as unknown as Record<string, unknown>, {
    readFileState: toolUseContext.readFileState,
    loadedNestedMemoryPaths: toolUseContext.loadedNestedMemoryPaths,
    mcpClients: toolUseContext.options.mcpClients,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    tasks: toolUseContext.getAppState().tasks,
    queryTracking: toolUseContext.queryTracking,
    setStreamMode: toolUseContext.setStreamMode,
    setResponseLength: toolUseContext.setResponseLength,
    onCompactProgress: toolUseContext.onCompactProgress,
    setSDKStatus: toolUseContext.setSDKStatus,
    addNotification: toolUseContext.addNotification,
  });
}

function splitMessagesForTurn(
  messages: readonly Message[],
): { readonly history: LLMMessage[]; readonly userMessage: string | readonly LLMContentPart[] } {
  const converted = messagesToLlmMessages(messages);
  for (let index = converted.length - 1; index >= 0; index -= 1) {
    const message = converted[index];
    if (message?.role !== "user") continue;
    return {
      history: [
        ...converted.slice(0, index),
        ...converted.slice(index + 1),
      ],
      userMessage: message.content,
    };
  }
  return {
    history: converted.slice(0, -1),
    userMessage: converted.at(-1)?.content ?? "",
  };
}

function messagesToLlmMessages(messages: readonly Message[]): LLMMessage[] {
  const converted: LLMMessage[] = [];
  let pendingCompatMessages: Message[] = [];
  const flushPendingCompatMessages = (): void => {
    if (pendingCompatMessages.length === 0) return;
    converted.push(
      ...normalizeMessagesForAPI([...pendingCompatMessages]).flatMap(
        messageToLlmMessages,
      ),
    );
    pendingCompatMessages = [];
  };

  for (const message of messages) {
    if (isLlmMessage(message)) {
      flushPendingCompatMessages();
      converted.push(cloneLlmMessage(message));
      continue;
    }
    if (message?.type === "system" && typeof message.content === "string") {
      flushPendingCompatMessages();
      converted.push(...messageToLlmMessages(message));
      continue;
    }
    pendingCompatMessages.push(message);
  }
  flushPendingCompatMessages();
  return frameUntrustedToolHistoryMessages(converted);
}

function messageToLlmMessages(message: Message): LLMMessage[] {
  if (isLlmMessage(message)) {
    return [cloneLlmMessage(message)];
  }
  if (message?.type === "user") {
    const content = message.message?.content ?? message.content ?? "";
    if (Array.isArray(content)) {
      const out: LLMMessage[] = [];
      const userParts: LLMContentPart[] = [];
      const flushUser = (): void => {
        if (userParts.length === 0) return;
        out.push({ role: "user", content: [...userParts] });
        userParts.length = 0;
      };
      for (const part of content as ContentBlockParam[]) {
        if (part.type === "tool_result") {
          flushUser();
          out.push({
            role: "tool",
            toolCallId: part.tool_use_id,
            content: toolResultContentToText(part.content),
          });
        } else if (part.type === "text") {
          userParts.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
          const url =
            part.source.type === "base64"
              ? `data:${part.source.media_type};base64,${part.source.data}`
              : part.source.url;
          userParts.push({ type: "image_url", image_url: { url } });
        } else if (part.type === "document" && part.source.type === "base64") {
          userParts.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: part.source.data,
            },
            ...(part.title ? { title: part.title } : {}),
          });
        }
        // other block types (thinking, tool_use, etc.) intentionally
        // skipped on user messages
      }
      flushUser();
      return out;
    }
    return [{ role: "user", content: String(content) }];
  }
  if (message?.type === "assistant") {
    const content = message.message?.content ?? [];
    if (!Array.isArray(content)) {
      return [{ role: "assistant", content: String(content ?? "") }];
    }
    const text: string[] = [];
    const toolCalls: LLMToolCall[] = [];
    for (const block of content) {
      if (block?.type === "text") {
        text.push(String(block.text ?? ""));
      } else if (block?.type === "tool_use") {
        toolCalls.push({
          id: String(block.id),
          name: String(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return [{
      role: "assistant",
      content: text.join("\n"),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    }];
  }
  if (message?.type === "system" && typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }
  return [];
}

function isLlmMessage(value: unknown): value is LLMMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return (
    role === "system" ||
    role === "developer" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  );
}

function cloneLlmMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
  };
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseToolInput(raw: string): unknown {
  try {
    return raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function createToolRegistryFromToolContext(opts: {
  readonly tools: readonly Tool[];
  readonly toolUseContext: ToolUseContext;
  readonly canUseTool: CanUseToolFn;
}): Promise<ToolRegistry> {
  const specs = await Promise.all(
    opts.tools.map(async (tool) => ({
      source: tool,
      llmTool: await oldToolToLlmTool(tool, opts.toolUseContext),
    })),
  );
  return {
    get tools() {
      return specs.map((spec) => runtimeToolFromOldTool(
        spec.source,
        opts.toolUseContext,
        opts.canUseTool,
        spec.llmTool,
      ));
    },
    toLLMTools() {
      return specs.map((spec) => spec.llmTool);
    },
    async dispatch(toolCall) {
      const spec = specs.find((entry) => entry.source.name === toolCall.name);
      if (!spec) {
        return { content: `unknown tool: ${toolCall.name}`, isError: true };
      }
      const parsed = parseToolArguments(toolCall.arguments);
      if (!parsed.ok) return { content: parsed.error, isError: true };
      return runtimeToolFromOldTool(
        spec.source,
        opts.toolUseContext,
        opts.canUseTool,
        spec.llmTool,
      ).execute(parsed.args);
    },
  } as ToolRegistry;
}

async function oldToolToLlmTool(
  tool: Tool,
  context: ToolUseContext,
): Promise<LLMTool> {
  let description = tool.name;
  try {
    description = await tool.prompt({
      getToolPermissionContext: async () =>
        context.getAppState().toolPermissionContext,
      tools: context.options.tools,
      agents: context.options.agentDefinitions.activeAgents,
      allowedAgentTypes: context.options.agentDefinitions.allowedAgentTypes,
    });
  } catch {
    description = tool.searchHint ?? tool.name;
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description,
      parameters: tool.inputJSONSchema ?? zodToJsonSchema(
        tool.inputSchema as z.ZodTypeAny,
      ),
    },
  };
}

function runtimeToolFromOldTool(
  tool: Tool,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  llmTool: LLMTool,
): ToolRegistry["tools"][number] {
  return {
    name: tool.name,
    description: llmTool.function.description,
    inputSchema: llmTool.function.parameters,
    isReadOnly: true,
    requiresApproval: false,
    metadata: { mutating: false },
    async execute(args) {
      const callId = typeof args.__callId === "string"
        ? args.__callId
        : randomUUID();
      const input = stripInjectedArgs(args);
      const injectedProgress =
        typeof args.__onProgress === "function"
          ? args.__onProgress as (event: { chunk: string; stream?: "status" }) => void
          : undefined;
      const block = {
        type: "tool_use" as const,
        id: callId,
        name: tool.name,
        input,
      };
      const parentMessage = createAssistantMessage({
        content: [block] as unknown as Parameters<typeof createAssistantMessage>[0]["content"],
      });
      const toolContext = {
        ...toolUseContext,
        toolUseId: callId,
        hookChainsCanUseTool: canUseTool,
      };
      const permission = await canUseTool(
        tool,
        input,
        toolContext,
        parentMessage,
        callId,
      );
      if (permission.behavior !== "allow") {
        const message = permission.message ?? `Permission to use ${tool.name} was denied.`;
        return {
          content: message,
          isError: true,
          metadata: {
            compatToolResultMessage: createUserMessage({
              content: [
                {
                  type: "tool_result",
                  tool_use_id: callId,
                  content: message,
                  is_error: true,
                },
              ],
              toolUseResult: `Error: ${message}`,
            }),
          },
        };
      }
      const result = await tool.call(
        permission.updatedInput ?? input,
        toolContext,
        canUseTool,
        parentMessage,
        (progress) => {
          emitLegacyProgress(
            injectedProgress,
            createProgressMessage({
              toolUseID: progress.toolUseID,
              parentToolUseID: callId,
              data: progress.data,
            }),
          );
        },
      );
      return oldToolResultToDispatchResult(tool, result, callId, toolUseContext);
    },
  };
}

function emitLegacyProgress(
  injectedProgress: ((event: { chunk: string; stream?: "status" }) => void) | undefined,
  message: Message,
): void {
  if (!injectedProgress) return;
  try {
    injectedProgress({
      chunk: `${LEGACY_PROGRESS_MARKER}${JSON.stringify(message)}`,
      stream: "status",
    });
  } catch {
    // Progress is best-effort; tool results still carry the durable outcome.
  }
}

function stripInjectedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("__")) continue;
    clean[key] = value;
  }
  return clean;
}

function oldToolResultToDispatchResult(
  tool: Tool,
  result: ToolResult<unknown> & { readonly structured_output?: unknown },
  callId: string,
  toolUseContext: ToolUseContext,
): ToolDispatchResult {
  const block = tool.mapToolResultToToolResultBlockParam(result.data, callId);
  const messageBlock = {
    ...block,
    is_error: block.is_error === true,
  };
  const structuredOutput = result.structured_output;
  return {
    content: toolResultContentToText(block.content),
    isError: messageBlock.is_error,
    metadata: {
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(structuredOutput !== undefined
        ? {
            compatMessages: [
              createAttachmentMessage({
                type: "structured_output",
                data: structuredOutput,
              }),
            ],
          }
        : {}),
      compatToolResultMessage: createUserMessage({
        content: [messageBlock],
        toolUseResult:
          toolUseContext.agentId && !toolUseContext.preserveToolUseResults
            ? undefined
            : result.data,
      }),
    },
  };
}

function parseToolArguments(raw: string): {
  readonly ok: true;
  readonly args: Record<string, unknown>;
} | {
  readonly ok: false;
  readonly error: string;
} {
  try {
    const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error: `tool arguments must be an object for ${raw}`,
      };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
