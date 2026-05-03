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
} from "../app-server/protocol/index.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { reviewDecisionIsAllow, type ReviewDecision } from "../permissions/review-decision.js";
import type {
  McpElicitationRequestEvent,
  McpElicitationResponse,
  RequestUserInputEvent,
  RequestUserInputResponse,
} from "../elicitation/types.js";
import { isMcpUrlCompletionResponse } from "../elicitation/url-completion.js";

export const AGENC_DAEMON_RECONNECTING_MESSAGE =
  "daemon disconnected, reconnecting";

export type AgenCDaemonConnectionStatus =
  | "connected"
  | "disconnected"
  | "reconnecting";

export interface AgenCDaemonConnectionState extends JsonObject {
  readonly status: AgenCDaemonConnectionStatus;
  readonly id?: string;
  readonly message?: string;
}

export interface AgenCTuiBridgeSession {
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
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
  enqueueIdleInput?(input: unknown): number;
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
  respondToUserInput(
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
  respondToMcpElicitation(
    serverName: string,
    requestId: RequestId,
    response: ElicitationRespondParams["response"],
  ): Promise<AgenCDaemonResultByMethod["elicitation.respond"]>;
};

export interface AgenCDaemonTuiClient {
  request<Method extends AgenCDaemonMethod>(
    method: Method,
    params?: JsonObject,
  ): Promise<AgenCDaemonResultByMethod[Method]>;
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
  const queuedInputs: MessageContentBlock[] = [];
  const eventSubscribers = new Set<(event: unknown) => void>();
  let queuedInputCount = 0;
  let unsubscribeDaemonEvents: (() => void) | null = null;
  const broadcastDaemonEvent = (event: unknown): void => {
    for (const subscriber of [...eventSubscribers]) {
      subscriber(event);
    }
  };
  const ensureDaemonEventsSubscribed = (): void => {
    if (unsubscribeDaemonEvents !== null) return;
    unsubscribeDaemonEvents = subscribeToDaemonEvents(
      client,
      sessionId,
      baseSession,
      broadcastDaemonEvent,
    );
  };
  const maybeStopDaemonEvents = (): void => {
    if (eventSubscribers.size > 0 || unsubscribeDaemonEvents === null) return;
    unsubscribeDaemonEvents();
    unsubscribeDaemonEvents = null;
  };
  return {
    ...baseSession,
    conversationId,
    submit: async (message, opts) => {
      const queued = queuedInputs.splice(0);
      queuedInputCount = 0;
      if (queued.length === 0 && message.length === 0) return;
      const content =
        queued.length === 0
          ? message
          : [
              ...queued,
              ...(message.length > 0
                ? [{ type: "text", text: message } as MessageContentBlock]
                : []),
            ];
      await client.request("message.stream", {
        sessionId,
        content,
        ...(opts?.displayUserMessage !== undefined
          ? { metadata: { displayUserMessage: opts.displayUserMessage } }
          : {}),
        streamId: `${clientId}:${Date.now()}`,
      } satisfies MessageStreamParams);
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
  session: AgenCTuiBridgeSession,
  cb: (event: unknown) => void,
): () => void {
  const unsubscribeSession = client.subscribeToSessionEvents(
    sessionId,
    (event) => {
      const transcriptEvent = toTranscriptEvent(event);
      cb(transcriptEvent);
      void maybeBridgeDaemonApproval(client, sessionId, session, transcriptEvent);
      void maybeBridgeDaemonElicitation(client, sessionId, session, transcriptEvent);
    },
  );
  const unsubscribeConnection = client.subscribeToConnectionState?.((state) => {
    for (const event of connectionNoticeEvents(state)) {
      cb(event);
    }
  });
  return () => {
    unsubscribeSession();
    unsubscribeConnection?.();
  };
}

async function maybeBridgeDaemonApproval(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
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
}

async function maybeBridgeDaemonElicitation(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  session: AgenCTuiBridgeSession,
  event: unknown,
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
        questions: jsonObjectArray(payload.questions) as RequestUserInputEvent["questions"],
      });
    } catch {
      response = null;
    }
    await client.request("elicitation.respond", {
      sessionId,
      requestId: typeof payload.requestId === "string"
        ? payload.requestId
        : payload.callId,
      kind: "request_user_input",
      response: (response ?? { action: "cancel" }) as unknown as JsonObject,
    } satisfies ElicitationRespondParams);
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
        request: payload.request as McpElicitationRequestEvent["request"],
      })
      .catch((): McpElicitationResponse => ({ action: "cancel" }));
    if (isMcpUrlCompletionResponse(response)) return;
    await client.request("elicitation.respond", {
      sessionId,
      requestId: payload.requestId,
      kind: "mcp",
      serverName: payload.serverName,
      response: (response ?? { action: "cancel" }) as unknown as JsonObject,
    } satisfies ElicitationRespondParams);
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
    } as ApprovalCtx["invocation"],
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
      id: stringParam(params.eventId, params.requestId),
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
      id: stringParam(params.eventId, params.requestId),
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
      id: stringParam(params.eventId, params.requestId),
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
      id: stringParam(params.eventId, String(params.requestId)),
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

function transcriptEventFromAgentStatus(params: JsonObject): JsonObject {
  const status = params.status;
  const turnId = stringParam(params.turnId, stringParam(params.eventId, "status"));
  if (status === "running") {
    return {
      id: stringParam(params.eventId, turnId),
      type: "turn_started",
      payload: { turnId },
    };
  }
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
    type: "turn_complete",
    payload: {
      turnId,
      ...(typeof params.message === "string"
        ? { lastAgentMessage: params.message }
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
        status: state.status,
      },
    },
  ];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
