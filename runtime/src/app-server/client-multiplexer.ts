/**
 * Ports the donor app-server's connection-to-session subscription map onto
 * AgenC daemon clients.
 *
 * Why this lives here:
 *   - F-03g owns concurrent client fan-out only. Session creation and
 *     termination stay in `session-lifecycle.ts`; transport accept loops stay
 *     in `transport/`.
 *
 * Cross-cuts deliberately NOT carried:
 *   - disconnect recovery policy and daemon process lifecycle are handled by
 *     later F-03 rows.
 */

import { randomUUID } from "node:crypto";
import { AsyncLock } from "../utils/async-lock.js";
import type {
  JsonObject,
  SessionAttachResult,
  SessionDetachResult,
} from "./protocol/index.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";

export type AgenCClientSend = (message: JsonObject) => void | Promise<void>;

export type AgenCClientMultiplexerErrorCode =
  | "CLIENT_ALREADY_REGISTERED"
  | "CLIENT_NOT_ATTACHED"
  | "CLIENT_NOT_FOUND";

export class AgenCClientMultiplexerError extends Error {
  readonly code: AgenCClientMultiplexerErrorCode;

  constructor(code: AgenCClientMultiplexerErrorCode, message: string) {
    super(message);
    this.name = "AgenCClientMultiplexerError";
    this.code = code;
  }
}

export interface AgenCClientMultiplexerOptions {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly createClientId?: () => string;
}

export interface AgenCClientRegistration {
  readonly clientId: string;
}

export interface RegisterAgenCClientOptions {
  readonly clientId?: string;
  readonly send: AgenCClientSend;
}

export interface AgenCSessionBroadcastFailure extends JsonObject {
  readonly clientId: string;
  readonly message: string;
}

export interface AgenCSessionBroadcastResult extends JsonObject {
  readonly sessionId: string;
  readonly deliveredClientIds: readonly string[];
  readonly failed: readonly AgenCSessionBroadcastFailure[];
}

interface MutableClient {
  clientId: string;
  send: AgenCClientSend;
  sessionIds: Set<string>;
  deliveryQueue: Promise<void>;
}

interface MutableSessionRoute {
  sessionId: string;
  clientAttachmentIds: Map<string, string>;
}

interface MultiplexerState {
  clients: Map<string, MutableClient>;
  sessions: Map<string, MutableSessionRoute>;
}

interface EnqueuedDelivery {
  readonly clientId: string;
  readonly delivered: Promise<void>;
}

export class AgenCDaemonClientMultiplexer {
  readonly #sessionManager: AgenCDaemonSessionManager;
  readonly #createClientId: () => string;
  readonly #state = new AsyncLock<MultiplexerState>({
    clients: new Map(),
    sessions: new Map(),
  });

  constructor(options: AgenCClientMultiplexerOptions) {
    this.#sessionManager = options.sessionManager;
    this.#createClientId =
      options.createClientId ?? (() => `client_${randomUUID()}`);
  }

  async registerClient(
    options: RegisterAgenCClientOptions,
  ): Promise<AgenCClientRegistration> {
    const clientId = options.clientId ?? this.#createClientId();
    return this.#state.with((state) => {
      if (state.clients.has(clientId)) {
        throw new AgenCClientMultiplexerError(
          "CLIENT_ALREADY_REGISTERED",
          `AgenC daemon client already registered: ${clientId}`,
        );
      }

      state.clients.set(clientId, {
        clientId,
        send: options.send,
        sessionIds: new Set(),
        deliveryQueue: Promise.resolve(),
      });
      return { clientId };
    });
  }

  async attachClientToSession(
    sessionId: string,
    clientId: string,
  ): Promise<SessionAttachResult> {
    return this.#state.with(async (state) => {
      const client = requireClient(state, clientId);
      const attachment = await this.#sessionManager.attachSession({
        sessionId,
        clientId,
      });
      const route = getOrCreateRoute(state, sessionId);

      client.sessionIds.add(sessionId);
      route.clientAttachmentIds.set(clientId, attachment.attachmentId);
      return attachment;
    });
  }

  async detachClientFromSession(
    sessionId: string,
    clientId: string,
  ): Promise<SessionDetachResult> {
    return this.#state.with(async (state) => {
      const client = requireClient(state, clientId);
      const route = state.sessions.get(sessionId);
      if (route === undefined || !route.clientAttachmentIds.has(clientId)) {
        throw new AgenCClientMultiplexerError(
          "CLIENT_NOT_ATTACHED",
          `AgenC daemon client ${clientId} is not attached to session ${sessionId}`,
        );
      }

      const detached = await this.#sessionManager.detachSession({
        sessionId,
        clientId,
      });
      route.clientAttachmentIds.delete(clientId);
      if (route.clientAttachmentIds.size === 0) {
        state.sessions.delete(sessionId);
      }
      client.sessionIds.delete(sessionId);
      return detached;
    });
  }

  async removeClient(clientId: string): Promise<readonly string[]> {
    return this.#state.with(async (state) => {
      const client = requireClient(state, clientId);
      const detachedSessionIds = [...client.sessionIds];

      state.clients.delete(clientId);
      for (const sessionId of detachedSessionIds) {
        const route = state.sessions.get(sessionId);
        route?.clientAttachmentIds.delete(clientId);
        if (route !== undefined && route.clientAttachmentIds.size === 0) {
          state.sessions.delete(sessionId);
        }
        await this.#sessionManager.detachSession({ sessionId, clientId });
      }

      return detachedSessionIds;
    });
  }

  async attachedClientIds(sessionId: string): Promise<readonly string[]> {
    return this.#state.with((state) => {
      const route = state.sessions.get(sessionId);
      return route === undefined ? [] : [...route.clientAttachmentIds.keys()];
    });
  }

  async broadcastSessionEvent(
    sessionId: string,
    event: JsonObject,
  ): Promise<AgenCSessionBroadcastResult> {
    const deliveries = await this.#state.with((state) => {
      const route = state.sessions.get(sessionId);
      if (route === undefined) return [];

      return [...route.clientAttachmentIds.keys()]
        .map((clientId) => enqueueDelivery(state.clients.get(clientId), event))
        .filter((delivery): delivery is EnqueuedDelivery => delivery !== null);
    });

    const settled = await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          await delivery.delivered;
          return {
            clientId: delivery.clientId,
            delivered: true as const,
          };
        } catch (error) {
          return {
            clientId: delivery.clientId,
            delivered: false as const,
            message: errorMessage(error),
          };
        }
      }),
    );

    return {
      sessionId,
      deliveredClientIds: settled
        .filter((result) => result.delivered)
        .map((result) => result.clientId),
      failed: settled
        .filter((result) => !result.delivered)
        .map((result) => ({
          clientId: result.clientId,
          message: result.message,
        })),
    };
  }
}

function requireClient(
  state: MultiplexerState,
  clientId: string,
): MutableClient {
  const client = state.clients.get(clientId);
  if (client === undefined) {
    throw new AgenCClientMultiplexerError(
      "CLIENT_NOT_FOUND",
      `AgenC daemon client not found: ${clientId}`,
    );
  }
  return client;
}

function getOrCreateRoute(
  state: MultiplexerState,
  sessionId: string,
): MutableSessionRoute {
  let route = state.sessions.get(sessionId);
  if (route === undefined) {
    route = {
      sessionId,
      clientAttachmentIds: new Map(),
    };
    state.sessions.set(sessionId, route);
  }
  return route;
}

function enqueueDelivery(
  client: MutableClient | undefined,
  event: JsonObject,
): EnqueuedDelivery | null {
  if (client === undefined) return null;

  const delivered = client.deliveryQueue.then(() =>
    Promise.resolve(client.send(event)),
  );
  client.deliveryQueue = delivered.then(
    () => undefined,
    () => undefined,
  );
  return {
    clientId: client.clientId,
    delivered,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
