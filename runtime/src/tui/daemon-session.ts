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

export interface AgenCTuiBridgeSession {
  readonly conversationId: string;
  readonly services: unknown;
  subscribeToEvents?(cb: (event: unknown) => void): () => void;
  submit?(
    message: string,
    opts?: { readonly displayUserMessage?: string | null },
  ): Promise<void>;
}

export type AgenCDaemonBackedTuiSession<
  Session extends AgenCTuiBridgeSession = AgenCTuiBridgeSession,
> = Omit<Session, "conversationId" | "submit" | "subscribeToEvents"> & {
  readonly conversationId: string;
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
      client.subscribeToSessionEvents(sessionId, (event) => {
        cb(toTranscriptEvent(event));
      }),
  } as AgenCDaemonBackedTuiSession<Session>;
}

function toTranscriptEvent(event: JsonObject): JsonObject {
  const msg = event.msg;
  if (isJsonObject(msg)) {
    return msg;
  }
  return event;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
