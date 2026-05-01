/**
 * Daemon-backed session adapter for the AgenC TUI.
 *
 * F-04b keeps the existing TUI session contract intact while routing user
 * input and streamed session events through the daemon protocol.
 */

import type {
  AgenCDaemonMethod,
  AgenCDaemonResultByMethod,
  JsonObject,
  JsonValue,
  MessageStreamParams,
  SessionAttachParams,
} from "../app-server/protocol/index.js";

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
  readonly services: unknown;
  readonly initialTranscriptEvents?: readonly unknown[];
  getInitialTranscriptEvents?(): readonly unknown[];
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
}

export type AgenCDaemonBackedTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> = Omit<
  Session,
  | "conversationId"
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
  return {
    ...baseSession,
    conversationId: sessionId,
    submit: async (message) => {
      if (message.length === 0) return;
      await client.request("message.stream", {
        sessionId,
        content: message,
        streamId: `${clientId}:${Date.now()}`,
      } satisfies MessageStreamParams);
    },
    subscribeToEvents: (cb) =>
      subscribeToDaemonEvents(client, sessionId, cb),
    getInitialTranscriptEvents: () => [
      ...baseInitialTranscriptEvents(baseSession),
      ...connectionNoticeEvents(client.getConnectionState?.() ?? null),
    ],
  } as AgenCDaemonBackedTuiSession<Session>;
}

function subscribeToDaemonEvents(
  client: AgenCDaemonTuiClient,
  sessionId: string,
  cb: (event: unknown) => void,
): () => void {
  const unsubscribeSession = client.subscribeToSessionEvents(
    sessionId,
    (event) => {
      cb(toTranscriptEvent(event));
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
  return event;
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
