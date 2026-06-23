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
  readonly maxBufferedBytesPerSession?: number;
  /**
   * Live-broadcast per-client pending-backlog caps. These gate the slow-consumer
   * eviction on the ONGOING broadcast path (an already-attached client falling
   * behind); they do NOT apply to the one-shot replay hand-off, which never
   * evicts. When omitted they default to the detached-session buffer caps
   * ({@link maxBufferedBytesPerSession} / {@link maxBufferedEventsPerSession}),
   * which is the production wiring — the daemon never overrides them, so default
   * behavior is unchanged. They exist as an independent seam because the live
   * pending cap and the detached-buffer cap are conceptually distinct bounds:
   * the detached buffer trims itself to within its cap before any replay, so a
   * cap-on-replay regression is only observable when the live pending cap is set
   * STRICTLY SMALLER than the detached-buffer cap (a legitimately-buffered
   * multi-event replay then exceeds the live pending cap). Tests use that to
   * exercise the replay-vs-live boundary; production leaves them coupled.
   */
  readonly maxPendingDeliveryBytesPerClient?: number;
  readonly maxPendingDeliveryCountPerClient?: number;
  /**
   * Optional hook fired when an attached client is evicted because its pending
   * (queued-but-undelivered) delivery backlog exceeded the per-client cap — see
   * {@link AgenCClientMultiplexerOptions.maxBufferedBytesPerSession}. The
   * multiplexer holds only a `send` closure, not the underlying socket, so it
   * cannot tear down the transport itself; the daemon supplies this callback to
   * `socket.destroy()` the slow consumer. The client has already been removed
   * from the multiplexer and detached from its sessions by the time this fires.
   * It can reconnect later through the normal detached-buffer/replay path.
   */
  readonly onClientEvicted?: (clientId: string) => void;
}

/**
 * Default byte budget for events buffered while a session has no attached
 * client. The 1000-event count cap alone does not bound memory: a handful of
 * large payloads (e.g. tool output, transcripts) can each be many MB, so a
 * detached session could pin hundreds of MB under the count cap. This cap
 * evicts the oldest events once buffered bytes exceed the budget.
 */
const DEFAULT_MAX_BUFFERED_BYTES_PER_SESSION = 8 * 1024 * 1024;

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
  /**
   * Approximate bytes of events enqueued for delivery to this attached client
   * but not yet flushed (the per-delivery promise has not settled). `send` is
   * ultimately a socket write that resolves only when the OS write callback
   * fires, so a backpressured/stuck client leaves these promises pending and
   * pins their payloads in daemon heap. A healthy, fast client drains its queue
   * promptly, so this stays near zero. When it crosses the cap the client is
   * evicted as a slow consumer. Pairs with {@link pendingDeliveryCount}.
   */
  pendingDeliveryBytes: number;
  /** Count analog of {@link pendingDeliveryBytes}. */
  pendingDeliveryCount: number;
  /**
   * Set once the client trips the pending-backlog cap. No further events are
   * enqueued for it and it is removed/detached as a slow consumer.
   */
  evicted: boolean;
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
  readonly #maxBufferedBytesPerSession: number;
  readonly #maxPendingDeliveryBytesPerClient: number;
  readonly #maxPendingDeliveryCountPerClient: number;
  readonly #onClientEvicted?: (clientId: string) => void;
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
    this.#maxBufferedBytesPerSession =
      options.maxBufferedBytesPerSession ??
      DEFAULT_MAX_BUFFERED_BYTES_PER_SESSION;
    // Default the live pending caps to the detached-buffer caps so production
    // (which never overrides them) keeps the exact prior behavior.
    this.#maxPendingDeliveryBytesPerClient =
      options.maxPendingDeliveryBytesPerClient ??
      this.#maxBufferedBytesPerSession;
    this.#maxPendingDeliveryCountPerClient =
      options.maxPendingDeliveryCountPerClient ??
      this.#maxBufferedEventsPerSession;
    this.#onClientEvicted = options.onClientEvicted;
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
        pendingDeliveryBytes: 0,
        pendingDeliveryCount: 0,
        evicted: false,
      });
      return { clientId };
    });
  }

  async attachClientToSession(
    sessionId: string,
    clientId: string,
  ): Promise<SessionAttachResult> {
    // Replay never evicts (allowEvict=false below), so nothing is ever pushed
    // here; the array only satisfies the shared enqueueDelivery signature.
    const replayEvictedClientIds: string[] = [];
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
          .map((event) =>
            enqueueDelivery(
              client,
              event,
              this.#maxBufferedBytesPerSession,
              this.#maxBufferedEventsPerSession,
              replayEvictedClientIds,
              // REPLAY is a bounded one-shot hand-off: never evict, never drop.
              false,
            ),
          )
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

  /**
   * Tear down clients flagged by {@link enqueueDelivery} as slow consumers whose
   * pending delivery backlog exceeded the per-client cap. Each is removed from
   * the multiplexer and detached from its sessions (same internal cleanup as
   * {@link disconnectClient}), then surfaced via the `onClientEvicted` callback
   * so the transport can `socket.destroy()` the stuck connection. The client can
   * reconnect later through the normal detached-buffer/replay path.
   */
  async #evictSlowClients(clientIds: readonly string[]): Promise<void> {
    if (clientIds.length === 0) return;
    for (const clientId of clientIds) {
      try {
        await this.disconnectClient(clientId);
      } catch {
        // Client may already be gone (concurrent disconnect); ignore.
      }
      this.#onClientEvicted?.(clientId);
    }
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
    const evictedClientIds: string[] = [];
    const deliveries = await this.#state.with(async (state) => {
      const existingRoute = state.sessions.get(sessionId);

      const activeClientIds =
        existingRoute === undefined
          ? []
          : [...existingRoute.clientAttachmentIds.keys()].filter((clientId) =>
              state.clients.has(clientId),
            );

      if (activeClientIds.length === 0) {
        // No attached client to deliver to. Only buffer (creating a route on
        // demand) when the session is still live: a terminated/unknown session
        // can never gain a client to drain the buffer, and its buffer-only
        // route is never reaped (deleteRouteIfEmpty keeps any route with
        // buffered events), so creating one here would leak `state.sessions`
        // unbounded on a long-lived daemon. Dropping late events for a dead
        // session is correct — nobody can ever replay them.
        if (existingRoute === undefined && !(await this.#isSessionLive(sessionId))) {
          return [];
        }
        const route = existingRoute ?? getOrCreateRoute(state, sessionId);
        bufferSessionEvent(
          route,
          event,
          this.#maxBufferedEventsPerSession,
          this.#maxBufferedBytesPerSession,
        );
        return [];
      }

      return activeClientIds
        .map((clientId) =>
          enqueueDelivery(
            state.clients.get(clientId),
            event,
            this.#maxPendingDeliveryBytesPerClient,
            this.#maxPendingDeliveryCountPerClient,
            evictedClientIds,
            // Live broadcast: enforce the per-client backlog cap.
            true,
          ),
        )
        .filter((delivery): delivery is EnqueuedDelivery => delivery !== null);
    });

    await this.#evictSlowClients(evictedClientIds);

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

  /**
   * Whether the session manager still owns an open session for `sessionId`.
   * A `null` summary means the session is unknown; a `closed` status means it
   * was terminated. In both cases no client can ever attach to drain a buffer,
   * so the multiplexer must not create a buffer-only route for it.
   */
  async #isSessionLive(sessionId: string): Promise<boolean> {
    const summary = await this.#sessionManager.getSession(sessionId);
    return summary !== null && summary.status !== "closed";
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

/**
 * Bound on a single attached client's pending (queued-but-undelivered) delivery
 * backlog for the ONGOING broadcast path. Mirrors the detached-session
 * buffering caps: a client whose pending backlog exceeds {@link maxPendingBytes}
 * bytes OR {@link maxPendingCount} events is a stuck/backpressured slow consumer
 * and is evicted rather than allowed to pin daemon heap without limit.
 *
 * `allowEvict` gates the cap. It is TRUE only for the live broadcast path
 * (an already-attached client falling behind). It is FALSE for the one-shot
 * REPLAY path in {@link AgenCDaemonClientMultiplexer.attachClientToSession},
 * which maps this function SYNCHRONOUSLY over the detached buffer inside the
 * state lock: the per-delivery decrement microtasks cannot run during that
 * synchronous map, so the pending counters would only ever accumulate across
 * the batch and a perfectly healthy client replaying a buffer near the 8 MB
 * detached cap would be falsely evicted mid-replay (and its un-delivered
 * boundary event then spliced away and lost). The replay batch is already
 * bounded by the detached-buffer cap and is a controlled hand-off to a freshly
 * attaching client, so it must never trip eviction or drop an event — when
 * `allowEvict` is false this function performs the original unbounded enqueue
 * (no cap, no counter bookkeeping).
 *
 * When the broadcast path trips the cap, the client's id is pushed onto
 * `evictedClientIds`; the caller (outside the lock-managed section) tears it
 * down via {@link AgenCDaemonClientMultiplexer.evictSlowClients}. Once flagged
 * `evicted` the client accepts no further events. Healthy fast clients drain
 * their queue promptly, so their counters stay near zero and never trip the cap.
 */
function enqueueDelivery(
  client: MutableClient | undefined,
  event: JsonObject,
  maxPendingBytes: number,
  maxPendingCount: number,
  evictedClientIds: string[],
  allowEvict: boolean,
): EnqueuedDelivery | null {
  if (client === undefined || client.evicted) return null;

  if (!allowEvict) {
    // REPLAY path: original unbounded enqueue. No cap and no pending-counter
    // bookkeeping (those counters track the live broadcast backlog only), so a
    // healthy client's bounded one-shot replay is never evicted and no buffered
    // event is ever dropped.
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

  const eventBytes = bufferedEventByteSize(event);
  // Trip the cap when this event WOULD push the pending backlog over either
  // budget. Always allow the very first pending event through (count 0) so a
  // single oversized payload is still delivered to an otherwise-idle client
  // rather than evicting it for one event, mirroring the byte-budget path's
  // "retain at least the most recent event" rule.
  if (
    client.pendingDeliveryCount > 0 &&
    (client.pendingDeliveryBytes + eventBytes > maxPendingBytes ||
      client.pendingDeliveryCount + 1 > maxPendingCount)
  ) {
    client.evicted = true;
    evictedClientIds.push(client.clientId);
    return null;
  }

  client.pendingDeliveryBytes += eventBytes;
  client.pendingDeliveryCount += 1;

  const delivered = client.deliveryQueue.then(() =>
    Promise.resolve(client.send(event)),
  );
  // Decrement the pending counters once THIS delivery settles (success or
  // failure) so a healthy client's backlog drains back toward zero. Bound to a
  // local `client` reference so it is unaffected by later re-registration.
  const settleAccounting = (): void => {
    client.pendingDeliveryBytes -= eventBytes;
    client.pendingDeliveryCount -= 1;
  };
  delivered.then(settleAccounting, settleAccounting);
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
  maxBufferedBytes: number,
): void {
  route.bufferedEvents.push(event);
  if (route.bufferedEvents.length > maxBufferedEvents) {
    route.bufferedEvents.splice(
      0,
      route.bufferedEvents.length - maxBufferedEvents,
    );
  }
  evictBufferedEventsByBytes(route.bufferedEvents, maxBufferedBytes);
}

/**
 * Approximate the serialized byte size of a buffered event. Buffered events
 * are JSON notifications, so the UTF-8 length of their JSON encoding is a
 * faithful proxy for the memory they pin. Falls back to 0 for values that
 * cannot be stringified so eviction never throws.
 */
function bufferedEventByteSize(event: JsonObject): number {
  try {
    return Buffer.byteLength(JSON.stringify(event));
  } catch {
    return 0;
  }
}

/**
 * Drops the oldest buffered events in-place until the total approximate byte
 * size is within `maxBufferedBytes`. Always retains at least the most recent
 * event so a single oversized payload is still replayable rather than silently
 * lost. Pairs with the count cap in {@link bufferSessionEvent}.
 */
function evictBufferedEventsByBytes(
  bufferedEvents: JsonObject[],
  maxBufferedBytes: number,
): void {
  if (maxBufferedBytes <= 0 || bufferedEvents.length === 0) return;
  let total = 0;
  for (const event of bufferedEvents) {
    total += bufferedEventByteSize(event);
  }
  while (total > maxBufferedBytes && bufferedEvents.length > 1) {
    const removed = bufferedEvents.shift();
    if (removed === undefined) break;
    total -= bufferedEventByteSize(removed);
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
