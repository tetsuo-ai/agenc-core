/**
 * Ports the donor app-server's connection-to-session subscription map onto
 * AgenC daemon clients.
 *
 * Why this lives here:
 *   - F-03g owns concurrent client fan-out only. Session creation and
 *     lifecycle authority stays in `session-lifecycle.ts`; this multiplexer
 *     only reconciles route cleanup for routed detach and terminate calls.
 *     Transport accept loops stay in `transport/`.
 *
 * Cross-cuts deliberately NOT carried:
 *   - disconnect recovery policy and daemon process lifecycle are handled by
 *     later F-03 rows.
 */

import { randomUUID } from "node:crypto";
import { AsyncLock } from "../utils/async-lock.js";
import type {
  AgenCDaemonSessionNotification,
  JsonObject,
  SessionAttachResult,
  SessionDetachParams,
  SessionDetachResult,
  SessionTerminateParams,
  SessionTerminateResult,
} from "./protocol/index.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";

export type AgenCClientSend = (message: JsonObject) => void | Promise<void>;

export type AgenCClientMultiplexerErrorCode =
  | "CLIENT_ALREADY_REGISTERED"
  | "CLIENT_NOT_ATTACHED"
  | "CLIENT_NOT_FOUND"
  | "SESSION_NOTIFICATION_MISMATCH";

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
  readonly maxBufferedEventsPerSession?: number;
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
  bufferedEvents: JsonObject[];
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
  readonly #maxBufferedEventsPerSession: number;
  readonly #state = new AsyncLock<MultiplexerState>({
    clients: new Map(),
    sessions: new Map(),
  });

  constructor(options: AgenCClientMultiplexerOptions) {
    this.#sessionManager = options.sessionManager;
    this.#createClientId =
      options.createClientId ?? (() => `client_${randomUUID()}`);
    this.#maxBufferedEventsPerSession =
      options.maxBufferedEventsPerSession ?? 1000;
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
    const { attachment, replayedEventCount, replay } = await this.#state.with(
      async (state) => {
        const client = requireClient(state, clientId);
        const attachment = await this.#sessionManager.attachSession({
          sessionId,
          clientId,
        });
        const route = getOrCreateRoute(state, sessionId);

        client.sessionIds.add(sessionId);
        route.clientAttachmentIds.set(clientId, attachment.attachmentId);
        const replayedEventCount = route.bufferedEvents.length;
        const replay = route.bufferedEvents
          .map((event) => enqueueDelivery(client, event))
          .filter((delivery): delivery is EnqueuedDelivery => delivery !== null);

        return { attachment, replayedEventCount, replay };
      },
    );

    if (replay.length > 0) {
      const replayResult = await settleDeliveries(replay);
      if (replayResult.failed.length === 0) {
        await this.#state.with((state) => {
          const route = state.sessions.get(sessionId);
          route?.bufferedEvents.splice(0, replayedEventCount);
        });
      }
    }

    return attachment;
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
        deleteRouteIfEmpty(state, route);
      }
      client.sessionIds.delete(sessionId);
      return detached;
    });
  }

  async detachSession(params: SessionDetachParams): Promise<SessionDetachResult> {
    return this.#state.with(async (state) => {
      const route = state.sessions.get(params.sessionId);
      const routeClientId = routeClientIdForDetach(route, params);
      const detached = await this.#sessionManager.detachSession(params);
      if (!detached.detached || routeClientId === undefined || route === undefined) {
        return detached;
      }

      route.clientAttachmentIds.delete(routeClientId);
      state.clients.get(routeClientId)?.sessionIds.delete(params.sessionId);
      deleteRouteIfEmpty(state, route);
      return detached;
    });
  }

  async terminateSession(
    params: SessionTerminateParams,
  ): Promise<SessionTerminateResult> {
    return this.#state.with(async (state) => {
      const route = state.sessions.get(params.sessionId);
      const affectedClientIds =
        route === undefined ? [] : [...route.clientAttachmentIds.keys()];
      const terminated = await this.#sessionManager.terminateSession(params);

      if (route !== undefined) {
        state.sessions.delete(params.sessionId);
        for (const clientId of affectedClientIds) {
          state.clients.get(clientId)?.sessionIds.delete(params.sessionId);
        }
      }
      return terminated;
    });
  }

  async removeClient(clientId: string): Promise<readonly string[]> {
    return this.disconnectClient(clientId);
  }

  async disconnectClient(clientId: string): Promise<readonly string[]> {
    return this.#state.with(async (state) => {
      const client = requireClient(state, clientId);
      const detachedSessionIds = [...client.sessionIds];

      state.clients.delete(clientId);
      for (const sessionId of detachedSessionIds) {
        const route = state.sessions.get(sessionId);
        route?.clientAttachmentIds.delete(clientId);
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
      const route = getOrCreateRoute(state, sessionId);

      const activeClientIds = [...route.clientAttachmentIds.keys()].filter(
        (clientId) => state.clients.has(clientId),
      );

      if (activeClientIds.length === 0) {
        bufferSessionEvent(route, event, this.#maxBufferedEventsPerSession);
        return [];
      }

      return activeClientIds
        .map((clientId) => enqueueDelivery(state.clients.get(clientId), event))
        .filter((delivery): delivery is EnqueuedDelivery => delivery !== null);
    });

    return {
      sessionId,
      ...(await settleDeliveries(deliveries)),
    };
  }

  async broadcastSessionNotification(
    sessionId: string,
    notification: AgenCDaemonSessionNotification,
  ): Promise<AgenCSessionBroadcastResult> {
    if (notification.params.sessionId !== sessionId) {
      throw new AgenCClientMultiplexerError(
        "SESSION_NOTIFICATION_MISMATCH",
        `AgenC daemon notification session mismatch: ${notification.params.sessionId} !== ${sessionId}`,
      );
    }
    return this.broadcastSessionEvent(sessionId, notification);
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
      bufferedEvents: [],
    };
    state.sessions.set(sessionId, route);
  }
  return route;
}

function routeClientIdForDetach(
  route: MutableSessionRoute | undefined,
  params: SessionDetachParams,
): string | undefined {
  if (route === undefined) return undefined;
  if (params.attachmentId !== undefined) {
    return [...route.clientAttachmentIds.entries()].find(
      ([, attachmentId]) => attachmentId === params.attachmentId,
    )?.[0];
  }
  if (params.clientId !== undefined) {
    return route.clientAttachmentIds.has(params.clientId)
      ? params.clientId
      : undefined;
  }
  return undefined;
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

async function settleDeliveries(
  deliveries: readonly EnqueuedDelivery[],
): Promise<{
  readonly deliveredClientIds: readonly string[];
  readonly failed: readonly AgenCSessionBroadcastFailure[];
}> {
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

function bufferSessionEvent(
  route: MutableSessionRoute,
  event: JsonObject,
  maxBufferedEvents: number,
): void {
  route.bufferedEvents.push(event);
  if (route.bufferedEvents.length > maxBufferedEvents) {
    route.bufferedEvents.splice(
      0,
      route.bufferedEvents.length - maxBufferedEvents,
    );
  }
}

function deleteRouteIfEmpty(
  state: MultiplexerState,
  route: MutableSessionRoute,
): void {
  if (
    route.clientAttachmentIds.size === 0 &&
    route.bufferedEvents.length === 0
  ) {
    state.sessions.delete(route.sessionId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
