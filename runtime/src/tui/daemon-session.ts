/**
 * Daemon-backed session adapter for the AgenC TUI.
 *
 * F-04b keeps the existing TUI session contract intact while routing user
 * input and streamed session events through the daemon protocol.
 */

import type {
  AgentAttachParams,
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  ElicitationRespondParams,
  JsonObject,
  JsonValue,
  MessageContentBlock,
  MessageStreamParams,
  RequestId,
  SessionAttachParams,
  SessionMcpAddServerParams,
  SessionMcpServerConfig,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageParams,
  SessionRewindConversationToMessageResult,
  SessionSnapshotResult,
} from "../app-server/protocol/index.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { reviewDecisionIsAllow, type ReviewDecision } from "../permissions/review-decision.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { isMcpUrlCompletionResponse } from "../elicitation/url-completion.js";
import {
  createRealtimeTuiControls,
  type AgenCRealtimeTuiControls,
  type CreateRealtimeTuiControlsOptions,
} from "./realtime/controller.js";
import type {
  RealtimeAudioPlayer,
  StartRealtimeAudioCapture,
} from "./realtime/audio.js";
import type { AgenCCompactProgressControls } from "./session-types.js";
import type { McpServerMutationResult } from "../session/session.js";

export const AGENC_DAEMON_RECONNECTING_MESSAGE =
  "daemon disconnected, reconnecting";

let nextRealtimeTranscriptEventSequence = 0;

export type AgenCDaemonConnectionStatus =
  | "connected"
  | "disconnected"
  | "reconnecting";

export interface AgenCDaemonConnectionState extends JsonObject {
  readonly status: AgenCDaemonConnectionStatus;
  readonly id?: string;
  readonly message?: string;
}

export interface AgenCTuiBridgeSession extends AgenCCompactProgressControls {
  readonly conversationId: string;
  readonly services: {
    approvalResolver?: ApprovalResolver;
    requestUserInputResolver?: {
      request(
        event: RequestUserInputEvent,
        signal?: AbortSignal,
      ): Promise<RequestUserInputResponse | null>;
    };
    mcpElicitationResolver?: {
      request(
        event: McpElicitationRequestEvent,
        signal?: AbortSignal,
      ): Promise<McpElicitationResponse | null>;
    };
    readonly [key: string]: unknown;
  };
  readonly initialTranscriptEvents?: readonly unknown[];
  getInitialTranscriptEvents?(): readonly unknown[];
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  emitPhaseEvent?(event: PhaseEvent): void;
  clearDaemonSession?(): Promise<void>;
  getDaemonSessionSnapshot?(): Promise<SessionSnapshotResult>;
  partialCompactFromMessage?(params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionPartialCompactFromMessageResult>;
  rewindConversationToMessage?(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindConversationToMessageResult>;
  readonly realtime?: AgenCRealtimeTuiControls;
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput?(input: unknown): number;
  listMcpClients?(): readonly unknown[];
  listMcpTools?(): readonly unknown[];
}

export type AgenCDaemonBackedTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> = Omit<
  Session,
  | "conversationId"
  | "enqueueIdleInput"
  | "getInitialTranscriptEvents"
  | "submit"
  | "subscribeToEvents"
> & {
  readonly conversationId: string;
  getInitialTranscriptEvents(): readonly unknown[];
  subscribeToEvents(cb: (event: unknown) => void): () => void;
  submit(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput(input: unknown): number;
  readonly realtime: AgenCRealtimeTuiControls;
  respondToUserInput(
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
  respondToMcpElicitation(
    serverName: string,
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
  partialCompactFromMessage(params: {
    readonly messageOrdinal: number;
    readonly direction: "from" | "up_to";
    readonly feedback?: string;
    readonly signal?: AbortSignal;
  }): Promise<SessionPartialCompactFromMessageResult>;
  rewindConversationToMessage(params: {
    readonly messageOrdinal: number;
  }): Promise<SessionRewindConversationToMessageResult>;
};

export interface AgenCDaemonTuiClient {
  request(
    method: "session.partialCompactFromMessage",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionPartialCompactFromMessageResult>;
  request(
    method: "session.rewindConversationToMessage",
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionRewindConversationToMessageResult>;
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgenCDaemonResultByMethod[Method]>;
  subscribeToNotifications?(
    cb: (event: JsonObject) => void,
  ): () => void;
  subscribeToSessionEvents(
    sessionId: string,
    cb: (event: JsonObject) => void,
  ): () => void;
  getConnectionState?(): AgenCDaemonConnectionState | null;
  subscribeToConnectionState?(
    cb: (state: AgenCDaemonConnectionState) => void,
  ): () => void;
}

export interface AgenCDaemonTuiSessionOptions<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> {
  readonly baseSession: Session;
  readonly client: AgenCDaemonTuiClient;
  readonly sessionId: string;
  readonly clientId: string;
  readonly conversationId?: string;
  readonly realtimeThreadId?: string;
  readonly realtimeWebrtcSessionFactory?: CreateRealtimeTuiControlsOptions["startWebrtcSession"];
  readonly realtimeAudioCaptureFactory?: StartRealtimeAudioCapture;
  readonly realtimeAudioPlayer?: RealtimeAudioPlayer;
}

export interface AgenCDaemonAgentTuiSessionOptions<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> extends Omit<AgenCDaemonTuiSessionOptions<Session>, "sessionId"> {
  readonly agentId: string;
}

export async function attachDaemonAgentTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
>(
  options: AgenCDaemonAgentTuiSessionOptions<Session>,
): Promise<AgenCDaemonBackedTuiSession<Session>> {
  const attachment = await options.client.request("agent.attach", {
    agentId: options.agentId,
    clientId: options.clientId,
  } satisfies AgentAttachParams);
  const sessionId = attachment.sessionIds[0];
  if (sessionId === undefined) {
    throw new Error(`daemon agent has no attached session: ${options.agentId}`);
  }
  return createDaemonTuiSession({
    ...options,
    sessionId,
    conversationId: attachment.runtimeSessionId ?? options.agentId,
    realtimeThreadId: options.agentId,
  });
}

export async function attachDaemonTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
>(
  options: AgenCDaemonTuiSessionOptions<Session>,
): Promise<AgenCDaemonBackedTuiSession<Session>> {
  await options.client.request("session.attach", {
    sessionId: options.sessionId,
    clientId: options.clientId,
  } satisfies SessionAttachParams);
  return createDaemonTuiSession(options);
}

export function createDaemonTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
>(
  options: AgenCDaemonTuiSessionOptions<Session>,
): AgenCDaemonBackedTuiSession<Session> {
  const { baseSession, client, sessionId, clientId } = options;
  const conversationId = options.conversationId ?? sessionId;
  const realtimeThreadId = options.realtimeThreadId ?? conversationId;
  const queuedInputs: MessageContentBlock[] = [];
  const eventSubscribers = new Set<(event: unknown) => void>();
  let activeTurnSnapshot: { readonly turnId: string } | null = null;
  let queuedInputCount = 0;
  let unsubscribeDaemonEvents: (() => void) | null = null;
  const noteDaemonActivity = (event: unknown): void => {
    if (
      typeof event !== "object" ||
      event === null ||
      (event as { readonly type?: unknown }).type !== "background_agent_status"
    ) {
      return;
    }
    const payload = (event as { readonly payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null) return;
    const status = (payload as { readonly status?: unknown }).status;
    const turnId = (payload as { readonly turnId?: unknown }).turnId;
    if (typeof status !== "string") return;
    if (
      status === "idle" ||
      status === "completed" ||
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      activeTurnSnapshot = null;
      return;
    }
    activeTurnSnapshot = {
      turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : "daemon-turn",
    };
  };
  const broadcastDaemonEvent = (event: unknown): void => {
    noteDaemonActivity(event);
    for (const subscriber of [...eventSubscribers]) {
      subscriber(event);
    }
  };
  const realtime = createRealtimeTuiControls({
    threadId: realtimeThreadId,
    client,
    emitEvent: broadcastDaemonEvent,
    ...(options.realtimeWebrtcSessionFactory !== undefined
      ? { startWebrtcSession: options.realtimeWebrtcSessionFactory }
      : {}),
    ...(options.realtimeAudioCaptureFactory !== undefined
      ? { startAudioCapture: options.realtimeAudioCaptureFactory }
      : {}),
    ...(options.realtimeAudioPlayer !== undefined
      ? { audioPlayer: options.realtimeAudioPlayer }
      : {}),
  });
  const ensureDaemonEventsSubscribed = (): void => {
    if (unsubscribeDaemonEvents !== null) return;
    unsubscribeDaemonEvents = subscribeToDaemonEvents(
      client,
      sessionId,
      realtimeThreadId,
      baseSession,
      realtime,
      broadcastDaemonEvent,
    );
  };
  const maybeStopDaemonEvents = (): void => {
    if (eventSubscribers.size > 0 || unsubscribeDaemonEvents === null) return;
    unsubscribeDaemonEvents();
    unsubscribeDaemonEvents = null;
  };
  const services = baseSession.services as MutableBridgeServices;
  if (services.mcpManager !== undefined) {
    services.mcpManager = createDaemonMirroredMcpManager(
      services.mcpManager,
      client,
      sessionId,
    );
  }
  return {
    ...baseSession,
    conversationId,
    services,
    realtime,
    activeTurn: {
      unsafePeek: () =>
        activeTurnSnapshot ?? baseSession.activeTurn?.unsafePeek?.() ?? null,
    },
    submit: async (message, opts) => {
      const queued = queuedInputs.splice(0);
      queuedInputCount = 0;
      if (queued.length === 0 && message.length === 0) return;
      const streamId = `${clientId}:${Date.now()}`;
      activeTurnSnapshot = { turnId: streamId };
      const content =
        queued.length === 0
          ? message
          : [
              ...queued,
              ...(message.length > 0
                ? [{ type: "text", text: message } as MessageContentBlock]
                : []),
            ];
      try {
        await client.request("message.stream", {
          sessionId,
          content,
          ...(opts?.displayUserMessage !== undefined
            ? { metadata: { displayUserMessage: opts.displayUserMessage } }
            : {}),
          streamId,
        } satisfies MessageStreamParams);
      } catch (error) {
        activeTurnSnapshot = null;
        throw error;
      }
    },
    enqueueIdleInput: (input) => {
      const blocks = queuedInputBlocks(input);
      if (blocks.length > 0) {
        queuedInputs.push(...blocks);
        queuedInputCount += 1;
      }
      return queuedInputCount;
    },
    respondToUserInput: async (requestId, response) =>
      client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "request_user_input",
        response,
      } satisfies ElicitationRespondParams),
    respondToMcpElicitation: async (serverName, requestId, response) =>
      client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "mcp",
        serverName,
        response,
      } satisfies ElicitationRespondParams),
    clearDaemonSession: async () => {
      await client.request("session.clear", { sessionId });
    },
    getDaemonSessionSnapshot: async () =>
      client.request("session.snapshot", { sessionId }),
    cancelActiveTurn: async (reason?: string) => {
      // Best-effort: a closed/disconnected daemon socket throws. The
      // user pressed ESC — they want the turn to stop, but a thrown
      // error here doesn't help them. Swallow and let the next health
      // check / event surface the disconnection separately.
      try {
        await client.request("session.cancelTurn", {
          sessionId,
          ...(reason !== undefined ? { reason } : {}),
        });
      } catch {
        // best-effort
      }
    },
    partialCompactFromMessage: async (params) =>
      client.request("session.partialCompactFromMessage", {
        sessionId,
        messageOrdinal: params.messageOrdinal,
        direction: params.direction,
        ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      } satisfies SessionPartialCompactFromMessageParams, {
        signal: params.signal,
      }),
    rewindConversationToMessage: async (params) =>
      client.request("session.rewindConversationToMessage", {
        sessionId,
        messageOrdinal: params.messageOrdinal,
      } satisfies SessionRewindConversationToMessageParams),
    subscribeToEvents: (cb) => {
      eventSubscribers.add(cb);
      ensureDaemonEventsSubscribed();
      return () => {
        eventSubscribers.delete(cb);
        maybeStopDaemonEvents();
      };
    },
    getInitialTranscriptEvents: () => [
      ...baseInitialTranscriptEvents(baseSession),
      ...connectionNoticeEvents(client.getConnectionState?.() ?? null),
    ],
  } as AgenCDaemonBackedTuiSession<Session>;
}

type McpManagerLike = NonNullable<AgenCTuiBridgeSession["services"]["mcpManager"]> & {
  addServer?(
    config: SessionMcpServerConfig,
  ): Promise<McpServerMutationResult>;
};

interface MutableBridgeServices {
  mcpManager?: unknown;
  [key: string]: unknown;
}

function createDaemonMirroredMcpManager(
  baseManager: unknown,
  client: AgenCDaemonTuiClient,
  sessionId: string,
): unknown {
  if (typeof baseManager !== "object" || baseManager === null) {
    return baseManager;
  }
  const manager = baseManager as McpManagerLike;
  return {
    ...manager,
    addServer: async (
      config: SessionMcpServerConfig,
    ): Promise<McpServerMutationResult> => {
      const remote = await client.request("session.mcp.addServer", {
        sessionId,
        config,
      } satisfies SessionMcpAddServerParams);
      if (remote.success && typeof manager.addServer === "function") {
        const local = await manager.addServer(config);
        const alreadyConfigured =
          local.success === false &&
          typeof local.error === "string" &&
          /already configured/i.test(local.error);
        if (!local.success && !alreadyConfigured) {
          return local;
        }
      }
      return {
        serverName: remote.serverName,
        success: remote.success,
        toolCount: remote.toolCount,
        ...(remote.error !== undefined ? { error: remote.error } : {}),
      };
    },
  };
}

function queuedInputBlocks(input: unknown): MessageContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (!isJsonObject(input)) return [];
  return messageContentBlocks(input.content);
}

function messageContentBlocks(
  content: JsonValue | undefined,
): MessageContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .flatMap((part): MessageContentBlock[] => {
      if (!isJsonObject(part) || typeof part.type !== "string") return [];
      if (part.type === "text") {
        return typeof part.text === "string"
          ? [{ type: "text", text: part.text }]
          : [];
      }
      if (part.type === "image_url") {
        const image = part.image_url;
        if (isJsonObject(image) && typeof image.url === "string") {
          return [{ type: "image_url", image_url: { url: image.url } }];
        }
      }
      return [];
    })
}

function subscribeToDaemonEvents(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  realtimeThreadId: string,
  session: AgenCTuiBridgeSession,
  realtime: AgenCRealtimeTuiControls,
  cb: (event: unknown) => void,
): () => void {
  const unsubscribeSession = client.subscribeToSessionEvents(
    sessionId,
    (event) => {
      const transcriptEvent = toTranscriptEvent(event);
      cb(transcriptEvent);
      void maybeBridgeDaemonApproval(client, sessionId, session, transcriptEvent, cb);
      void maybeBridgeDaemonElicitation(client, sessionId, session, transcriptEvent, cb);
    },
  );
  const unsubscribeRealtime = client.subscribeToNotifications?.((event) => {
    const transcriptEvent = toRealtimeTranscriptEvent(event, realtimeThreadId);
    if (transcriptEvent === null) return;
    realtime.handleTranscriptEvent(transcriptEvent);
    cb(transcriptEvent);
  });
  const unsubscribeConnection = client.subscribeToConnectionState?.((state) => {
    for (const event of connectionNoticeEvents(state)) {
      cb(event);
    }
  });
  return () => {
    unsubscribeSession();
    unsubscribeRealtime?.();
    unsubscribeConnection?.();
  };
}

/**
 * Surface a failed delivery RPC to the user as a warning notice.
 *
 * The approve/deny/elicitation decision the user made could not be delivered
 * to the daemon (e.g. a transient/disconnected socket). Without surfacing it,
 * the tool call hangs forever with no feedback. Mirror the connection-notice
 * shape so the TUI renders it like other daemon warnings.
 */
function emitDaemonDeliveryFailureNotice(
  cb: (event: unknown) => void,
  requestId: string,
  action: string,
  error: unknown,
): void {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  cb({
    id: `agenc-daemon-delivery-failed-${requestId}`,
    type: "warning",
    payload: {
      message: `failed to deliver ${action} to daemon: ${message}`,
      cause: "daemon_delivery_failed",
      action,
      requestId,
    },
  });
}

async function maybeBridgeDaemonApproval(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
  cb: (event: unknown) => void,
): Promise<void> {
  if (!isJsonObject(event) || event.type !== "request_permissions") return;
  const payload = event.payload;
  if (!isJsonObject(payload) || typeof payload.callId !== "string") return;
  const resolver = session.services.approvalResolver;
  if (resolver === undefined) return;
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName : "tool";
  const decision = await resolver
    .request(buildDaemonApprovalCtx(session, payload, toolName))
    .catch((): ReviewDecision => ({ kind: "denied" }));
  // A transient daemon RPC failure here silently drops the user's
  // approve/deny decision and the tool call hangs forever. Catch and surface
  // it so the user gets feedback instead of an indefinite hang.
  try {
    if (reviewDecisionIsAllow(decision)) {
      await client.request("tool.approve", {
        sessionId,
        requestId: payload.callId,
        scope: decision.kind === "approved_for_session" ? "session" : "once",
      });
      return;
    }
    await client.request("tool.deny", {
      sessionId,
      requestId: payload.callId,
      reason: decision.kind,
    });
  } catch (error) {
    emitDaemonDeliveryFailureNotice(
      cb,
      payload.callId,
      reviewDecisionIsAllow(decision) ? "tool.approve" : "tool.deny",
      error,
    );
  }
}

async function maybeBridgeDaemonElicitation(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
  cb: (event: unknown) => void,
): Promise<void> {
  if (!isJsonObject(event) || typeof event.type !== "string") return;
  const payload = event.payload;
  if (!isJsonObject(payload)) return;
  if (
    event.type === "request_user_input" &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    const resolver = session.services.requestUserInputResolver;
    if (resolver === undefined) return;
    let response: RequestUserInputResponse | null;
    try {
      response = await resolver.request({
        requestId: typeof payload.requestId === "string"
          ? payload.requestId
          : payload.callId,
        callId: payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(payload.questions) as unknown as RequestUserInputEvent["questions"],
      });
    } catch {
      response = null;
    }
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : payload.callId;
    try {
      await client.request("elicitation.respond", {
        sessionId,
        requestId,
        kind: "request_user_input",
        response: (response ?? { action: "cancel" }) as unknown as JsonObject,
      } satisfies ElicitationRespondParams);
    } catch (error) {
      emitDaemonDeliveryFailureNotice(
        cb,
        requestId,
        "elicitation.respond",
        error,
      );
    }
    return;
  }
  if (
    event.type === "mcp_elicitation_request" &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    const resolver = session.services.mcpElicitationResolver;
    if (resolver === undefined) return;
    const response = await resolver
      .request({
        serverName: payload.serverName,
        requestId: payload.requestId,
        turnId: payload.turnId,
        request: payload.request as unknown as McpElicitationRequestEvent["request"],
      })
      .catch((): McpElicitationResponse => ({ action: "cancel" }));
    if (isMcpUrlCompletionResponse(response)) return;
    try {
      await client.request("elicitation.respond", {
        sessionId,
        requestId: payload.requestId,
        kind: "mcp",
        serverName: payload.serverName,
        response: (response ?? { action: "cancel" }) as unknown as JsonObject,
      } satisfies ElicitationRespondParams);
    } catch (error) {
      emitDaemonDeliveryFailureNotice(
        cb,
        String(payload.requestId),
        "elicitation.respond",
        error,
      );
    }
  }
}

function buildDaemonApprovalCtx(
  session: AgenCTuiBridgeSession,
  payload: JsonObject,
  toolName: string,
): ApprovalCtx {
  const callId = payload.callId as string;
  const input = isJsonObject(payload.input) ? payload.input : {};
  return {
    invocation: {
      session,
      turn: { subId: typeof payload.turnId === "string" ? payload.turnId : callId },
      tracker: {
        appendFileDiff() {},
        snapshot: () => [],
        clear() {},
      },
      callId,
      toolName: { name: toolName },
      payload: {
        kind: "function",
        arguments: JSON.stringify(input),
      },
      source: "direct",
    } as unknown as ApprovalCtx["invocation"],
    callId,
    toolName,
    turnId: typeof payload.turnId === "string" ? payload.turnId : callId,
    ...(typeof payload.reason === "string" ? { retryReason: payload.reason } : {}),
  };
}

function baseInitialTranscriptEvents(
  session: AgenCTuiBridgeSession,
): readonly unknown[] {
  return [
    ...((session.getInitialTranscriptEvents?.() ??
      session.initialTranscriptEvents ??
      []) as readonly unknown[]),
  ];
}

function toTranscriptEvent(event: JsonObject): JsonObject {
  const msg = event.msg;
  if (isJsonObject(msg)) {
    return msg;
  }
  const method = event.method;
  const params = event.params;
  if (typeof method !== "string" || !isJsonObject(params)) {
    return event;
  }
  if (method === "event.message_chunk" && typeof params.delta === "string") {
    return {
      id: stringParam(params.eventId, "message-delta"),
      type: "agent_message_delta",
      payload: { delta: params.delta },
    };
  }
  if (
    method === "event.tool_request" &&
    typeof params.requestId === "string" &&
    typeof params.toolName === "string"
  ) {
    return {
      id: stringParam(params.eventId, `tool-request:${params.requestId}`),
      type: "tool_call_started",
      payload: {
        callId: params.requestId,
        toolName: params.toolName,
        args: JSON.stringify(params.input ?? {}),
      },
    };
  }
  if (method === "event.permission_request" && typeof params.requestId === "string") {
    return {
      id: stringParam(params.eventId, `permission-request:${params.requestId}`),
      type: "request_permissions",
      payload: {
        callId: params.requestId,
        ...(typeof params.toolName === "string" ? { toolName: params.toolName } : {}),
        ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        permissions: Array.isArray(params.permissions)
          ? params.permissions.filter((item): item is string => typeof item === "string")
          : [],
        ...(params.input !== undefined ? { input: params.input } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
      },
    };
  }
  if (
    method === "event.user_input_request" &&
    typeof params.requestId === "string" &&
    typeof params.callId === "string" &&
    typeof params.turnId === "string" &&
    Array.isArray(params.questions)
  ) {
    return {
      id: stringParam(params.eventId, `user-input-request:${params.requestId}`),
      type: "request_user_input",
      payload: {
        requestId: params.requestId,
        callId: params.callId,
        turnId: params.turnId,
        questions: jsonObjectArray(params.questions),
      },
    };
  }
  if (
    method === "event.mcp_elicitation_request" &&
    (typeof params.requestId === "string" ||
      typeof params.requestId === "number") &&
    typeof params.serverName === "string" &&
    typeof params.turnId === "string" &&
    isJsonObject(params.request)
  ) {
    return {
      id: stringParam(params.eventId, `mcp-elicitation:${String(params.requestId)}`),
      type: "mcp_elicitation_request",
      payload: {
        requestId: params.requestId,
        serverName: params.serverName,
        turnId: params.turnId,
        request: params.request,
      },
    };
  }
  if (method === "event.agent_status") {
    return transcriptEventFromAgentStatus(params);
  }
  if (method === "event.session_event" && isJsonObject(params.event)) {
    return params.event;
  }
  return event;
}

function toRealtimeTranscriptEvent(
  event: JsonObject,
  realtimeThreadId: string,
): JsonObject | null {
  const method = event.method;
  const params = event.params;
  if (typeof method !== "string" || !isJsonObject(params)) return null;
  if (!method.startsWith("thread/realtime/")) return null;
  if (params.threadId !== realtimeThreadId) return null;
  const id = stringParam(
    params.eventId,
    nextRealtimeEventId(method, params.threadId),
  );
  switch (method) {
    case "thread/realtime/started":
      return {
        id,
        type: "realtime_started",
        payload: {
          threadId: params.threadId,
          realtimeSessionId:
            typeof params.realtimeSessionId === "string"
              ? params.realtimeSessionId
              : null,
          ...(typeof params.version === "string" ? { version: params.version } : {}),
        },
      };
    case "thread/realtime/itemAdded":
      return {
        id,
        type: "realtime_item_added",
        payload: {
          threadId: params.threadId,
          item: params.item ?? null,
        },
      };
    case "thread/realtime/transcript/delta":
      return {
        id,
        type: "realtime_transcript_delta",
        payload: {
          threadId: params.threadId,
          role: typeof params.role === "string" ? params.role : "assistant",
          delta: typeof params.delta === "string" ? params.delta : "",
        },
      };
    case "thread/realtime/transcript/done":
      return {
        id,
        type: "realtime_transcript_done",
        payload: {
          threadId: params.threadId,
          role: typeof params.role === "string" ? params.role : "assistant",
          text: typeof params.text === "string" ? params.text : "",
        },
      };
    case "thread/realtime/outputAudio/delta":
      return {
        id,
        type: "realtime_output_audio_delta",
        payload: {
          threadId: params.threadId,
          audio: params.audio,
        },
      };
    case "thread/realtime/sdp":
      return {
        id,
        type: "realtime_sdp",
        payload: {
          threadId: params.threadId,
          sdp: typeof params.sdp === "string" ? params.sdp : "",
        },
      };
    case "thread/realtime/error":
      return {
        id,
        type: "realtime_error",
        payload: {
          threadId: params.threadId,
          message:
            typeof params.message === "string"
              ? params.message
              : "Realtime error",
        },
      };
    case "thread/realtime/closed":
      return {
        id,
        type: "realtime_closed",
        payload: {
          threadId: params.threadId,
          reason: typeof params.reason === "string" ? params.reason : null,
        },
      };
    default:
      return null;
  }
}

function nextRealtimeEventId(method: string, threadId: JsonValue | undefined): string {
  nextRealtimeTranscriptEventSequence += 1;
  return `realtime:${method}:${String(threadId ?? "thread")}:${nextRealtimeTranscriptEventSequence}`;
}

function transcriptEventFromAgentStatus(params: JsonObject): JsonObject {
  const status = params.status;
  const turnId = stringParam(params.turnId, stringParam(params.eventId, "status"));
  if (status === "error") {
    return {
      id: stringParam(params.eventId, turnId),
      type: "error",
      payload: {
        turnId,
        message: typeof params.message === "string" ? params.message : "agent error",
      },
    };
  }
  return {
    id: stringParam(params.eventId, turnId),
    type: "background_agent_status",
    payload: {
      turnId,
      status,
      ...(typeof params.agentId === "string" && params.agentId.length > 0
        ? { agentId: params.agentId }
        : {}),
      ...(typeof params.runStatus === "string" && params.runStatus.length > 0
        ? { runStatus: params.runStatus }
        : {}),
      ...(typeof params.message === "string"
        ? { message: params.message }
        : {}),
    },
  };
}

function stringParam(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function jsonObjectArray(value: readonly unknown[]): JsonObject[] {
  return value.filter(isJsonObject);
}

function connectionNoticeEvents(
  state: AgenCDaemonConnectionState | null,
): readonly JsonObject[] {
  if (state === null || state.status === "connected") return [];
  return [
    {
      id: state.id ?? `agenc-daemon-${state.status}`,
      type: "warning",
      payload: {
        message: state.message ?? AGENC_DAEMON_RECONNECTING_MESSAGE,
        cause: "daemon_connection_state",
        status: state.status,
      },
    },
  ];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
