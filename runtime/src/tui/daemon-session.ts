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
  JsonObject,
  JsonValue,
  MessageContentBlock,
  MessageStreamParams,
  SessionAttachParams,
} from "../app-server/protocol/index.js";
import type { ApprovalCtx, ApprovalResolver } from "../tools/orchestrator.js";
import { reviewDecisionIsAllow, type ReviewDecision } from "../permissions/review-decision.js";

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
  let queuedInputCount = 0;
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
    subscribeToEvents: (cb) =>
      subscribeToDaemonEvents(client, sessionId, baseSession, cb),
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
