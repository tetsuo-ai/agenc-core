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
import { EVENT_GAP_EVENT } from "../contracts/run-contracts.js";
import { AsyncLock } from "../utils/async-lock.js";
import {
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  type AgenCDaemonSessionNotification,
  type JsonObject,
  type SessionAttachResult,
  type SessionDetachParams,
  type SessionDetachResult,
  type SessionTerminateParams,
  type SessionTerminateResult,
} from "./protocol/index.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";

export type AgenCClientSend = (message: JsonObject) => void | Promise<void>;

export type AgenCClientMultiplexerErrorCode =
  | "CLIENT_ALREADY_REGISTERED"
  | "CLIENT_NOT_ATTACHED"
  | "CLIENT_NOT_FOUND"
  | "EVENT_BUFFER_LIMIT_EXCEEDED"
  | "EVENT_DELIVERY_LIMIT_EXCEEDED"
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
   * Per-client pending-delivery caps. Live broadcasts evict a client before an
   * enqueue would exceed either cap. Detached replay reserves the complete
   * retained batch before queueing it, so concurrent attaches and capability
   * replays cannot hide unbounded closures behind a blocked send. When omitted
   * the caps default to the detached-session buffer caps
   * ({@link maxBufferedBytesPerSession} / {@link maxBufferedEventsPerSession}),
   * which is the production wiring — the daemon never overrides them, so default
   * behavior is unchanged. They remain independently configurable so an
   * embedder can use a smaller socket backlog than detached retention budget.
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
  /** Physical delivery identity; logical clients on one socket share this key. */
  readonly deliveryKey?: string;
  readonly send: AgenCClientSend;
  /** Capabilities authenticated/recorded during this connection's initialize. */
  readonly capabilities?: JsonObject;
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
  deliveryKey: string;
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
  capabilities: Set<string>;
}

interface BufferedCapabilityEvent {
  readonly sessionId: string;
  readonly event: JsonObject;
}

interface MutableSessionRoute {
  sessionId: string;
  clientAttachmentIds: Map<string, string>;
  bufferedEvents: JsonObject[];
}

interface MultiplexerState {
  clients: Map<string, MutableClient>;
  sessions: Map<string, MutableSessionRoute>;
  capabilityBuffers: Map<string, BufferedCapabilityEvent[]>;
  /**
   * One registering client at a time may drain a capability replay buffer. This
   * prevents two phones initializing concurrently from both receiving the same
   * one-shot Ledger action before the first replay delivery settles.
   */
  capabilityReplayInFlight: Set<string>;
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
    capabilityBuffers: new Map(),
    capabilityReplayInFlight: new Set(),
  });

  constructor(options: AgenCClientMultiplexerOptions) {
    this.#sessionManager = options.sessionManager;
    this.#createClientId =
      options.createClientId ?? (() => `client_${randomUUID()}`);
    this.#maxBufferedEventsPerSession = normalizePositiveLimit(
      options.maxBufferedEventsPerSession ?? 1000,
      "maxBufferedEventsPerSession",
    );
    this.#maxBufferedBytesPerSession = normalizePositiveLimit(
      options.maxBufferedBytesPerSession ??
        DEFAULT_MAX_BUFFERED_BYTES_PER_SESSION,
      "maxBufferedBytesPerSession",
    );
    // Default pending caps to the detached-buffer caps; production leaves the
    // two bounds coupled.
    this.#maxPendingDeliveryBytesPerClient = normalizePositiveLimit(
      options.maxPendingDeliveryBytesPerClient ??
        this.#maxBufferedBytesPerSession,
      "maxPendingDeliveryBytesPerClient",
    );
    this.#maxPendingDeliveryCountPerClient = normalizePositiveLimit(
      options.maxPendingDeliveryCountPerClient ??
        this.#maxBufferedEventsPerSession,
      "maxPendingDeliveryCountPerClient",
    );
    this.#onClientEvicted = options.onClientEvicted;
  }

  async registerClient(
    options: RegisterAgenCClientOptions,
  ): Promise<AgenCClientRegistration> {
    const clientId = options.clientId ?? this.#createClientId();
    const {
      registration,
      replay,
      replayCounts,
      statusReplay,
      statusReplayEvents,
    } = await this.#state.with((state) => {
      if (state.clients.has(clientId)) {
        throw new AgenCClientMultiplexerError(
          "CLIENT_ALREADY_REGISTERED",
          `AgenC daemon client already registered: ${clientId}`,
        );
      }

      const client: MutableClient = {
        clientId,
        deliveryKey: options.deliveryKey ?? clientId,
        send: options.send,
        sessionIds: new Set(),
        deliveryQueue: Promise.resolve(),
        pendingDeliveryBytes: 0,
        pendingDeliveryCount: 0,
        evicted: false,
        capabilities: advertisedCapabilities(options.capabilities),
      };
      // Validate every one-shot replay candidate before registering the client
      // or leasing a capability. A smaller delivery cap than buffer cap must
      // fail without leaving a registered half-client or a stuck replay lease.
      for (const capability of client.capabilities) {
        if (state.capabilityReplayInFlight.has(capability)) continue;
        for (const item of state.capabilityBuffers.get(capability) ?? []) {
          assertEventFitsDeliveryLimit(
            item.event,
            this.#maxPendingDeliveryBytesPerClient,
            this.#maxPendingDeliveryCountPerClient,
          );
        }
      }
      if (
        client.capabilities.has(AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY) &&
        !state.capabilityReplayInFlight.has(
          AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
        )
      ) {
        for (const route of state.sessions.values()) {
          for (const event of route.bufferedEvents.filter(
            isMobileStatusPushEvent,
          )) {
            assertEventFitsDeliveryLimit(
              event,
              this.#maxPendingDeliveryBytesPerClient,
              this.#maxPendingDeliveryCountPerClient,
            );
          }
        }
      }
      const replayEvents: JsonObject[] = [];
      const replayCounts = new Map<string, number>();
      for (const capability of client.capabilities) {
        if (state.capabilityReplayInFlight.has(capability)) continue;
        const buffered = state.capabilityBuffers.get(capability) ?? [];
        if (buffered.length === 0) continue;
        replayCounts.set(capability, buffered.length);
        for (const item of buffered) {
          replayEvents.push(item.event);
        }
      }
      // Mobile status is a fan-out observer capability, not a Ledger-style
      // single-consumer client action. Replay only status frames from each
      // session's ordinary bounded buffer; leave transcript/tool events for a
      // later explicit session.attach. One registering observer leases this
      // replay batch at a time so concurrent phones cannot both drain it.
      const statusReplayBatch: JsonObject[] = [];
      const statusReplayEvents = new Map<string, JsonObject[]>();
      if (
        client.capabilities.has(AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY) &&
        !state.capabilityReplayInFlight.has(
          AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
        )
      ) {
        for (const route of state.sessions.values()) {
          const bufferedStatuses = route.bufferedEvents.filter(
            isMobileStatusPushEvent,
          );
          if (bufferedStatuses.length === 0) continue;
          statusReplayEvents.set(route.sessionId, bufferedStatuses);
          for (const event of bufferedStatuses) {
            statusReplayBatch.push(event);
          }
        }
      }

      // Reserve the aggregate before registering the client or leasing any
      // capability buffer. A failed hard-cap check must leave no half-client,
      // replay lease, or queued closure behind.
      assertReplayDeliveriesFitAvailable(
        client,
        [replayEvents, statusReplayBatch],
        this.#maxPendingDeliveryBytesPerClient,
        this.#maxPendingDeliveryCountPerClient,
      );
      state.clients.set(clientId, client);
      for (const capability of replayCounts.keys()) {
        state.capabilityReplayInFlight.add(capability);
      }
      if (statusReplayBatch.length > 0) {
        state.capabilityReplayInFlight.add(
          AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
        );
      }

      const replayDelivery = enqueueReplayDelivery(
        client,
        replayEvents,
        this.#maxPendingDeliveryBytesPerClient,
        this.#maxPendingDeliveryCountPerClient,
      );
      const replay = replayDelivery === null ? [] : [replayDelivery];
      const statusReplayDelivery = enqueueReplayDelivery(
        client,
        statusReplayBatch,
        this.#maxPendingDeliveryBytesPerClient,
        this.#maxPendingDeliveryCountPerClient,
      );
      const statusReplay =
        statusReplayDelivery === null ? [] : [statusReplayDelivery];
      return {
        registration: { clientId },
        replay,
        replayCounts,
        statusReplay,
        statusReplayEvents,
      };
    });

    if (replay.length > 0) {
      const replayResult = await settleDeliveries(replay);
      await this.#state.with((state) => {
        for (const capability of replayCounts.keys()) {
          state.capabilityReplayInFlight.delete(capability);
        }
        if (replayResult.failed.length === 0) {
          for (const [capability, count] of replayCounts) {
            const buffered = state.capabilityBuffers.get(capability);
            if (buffered === undefined) continue;
            buffered.splice(0, count);
            if (buffered.length === 0) {
              state.capabilityBuffers.delete(capability);
            }
          }
        }
      });
    }

    if (statusReplay.length > 0) {
      const statusReplayResult = await settleDeliveries(statusReplay);
      await this.#state.with((state) => {
        state.capabilityReplayInFlight.delete(
          AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
        );
        // All-or-nothing removal deliberately favors duplicate replay over
        // loss. Android deduplicates eventIds and turnIds after reconnect.
        if (statusReplayResult.failed.length > 0) return;
        for (const [sessionId, replayedEvents] of statusReplayEvents) {
          const route = state.sessions.get(sessionId);
          if (route === undefined) continue;
          const replayed = new Set(replayedEvents);
          route.bufferedEvents = route.bufferedEvents.filter(
            (event) => !replayed.has(event),
          );
          deleteRouteIfEmpty(state, route);
        }
      });
    }
    return registration;
  }

  async attachClientToSession(
    sessionId: string,
    clientId: string,
  ): Promise<SessionAttachResult> {
    // Replay reserves its complete bounded batch before attachment. This keeps
    // a blocked client's queued closures within the same byte/count caps as
    // live delivery and rejects before the session manager gains an attachment.
    const { attachment, replayedEvents, replay } = await this.#state.with(
      async (state) => {
        const client = requireClient(state, clientId);
        const existingRoute = state.sessions.get(sessionId);
        const replayedEvents = [...(existingRoute?.bufferedEvents ?? [])];
        assertReplayDeliveriesFitAvailable(
          client,
          [replayedEvents],
          this.#maxPendingDeliveryBytesPerClient,
          this.#maxPendingDeliveryCountPerClient,
        );
        const attachment = await this.#sessionManager.attachSession({
          sessionId,
          clientId,
        });
        const route = getOrCreateRoute(state, sessionId);

        client.sessionIds.add(sessionId);
        route.clientAttachmentIds.set(clientId, attachment.attachmentId);
        const replayDelivery = enqueueReplayDelivery(
          client,
          replayedEvents,
          this.#maxPendingDeliveryBytesPerClient,
          this.#maxPendingDeliveryCountPerClient,
        );
        const replay = replayDelivery === null ? [] : [replayDelivery];

        return { attachment, replayedEvents, replay };
      },
    );

    if (replay.length > 0) {
      const replayResult = await settleDeliveries(replay);
      if (replayResult.failed.length === 0) {
        await this.#state.with((state) => {
          const route = state.sessions.get(sessionId);
          if (route === undefined) return;
          // Remove EXACTLY the delivered events, by identity — never by
          // count. The settle above runs outside the state lock, so the
          // buffer may have shifted meanwhile (new events appended, oldest
          // evicted, a gap marker unshifted/merged at the head). A
          // positional splice would destroy never-delivered events and the
          // marker itself, silently re-hiding announced loss. A marker
          // merged during the window is a NEW object and correctly
          // survives for the next client (its retiredCount may then
          // re-announce already-delivered events — over-announcing is the
          // safe direction).
          const delivered = new Set(replayedEvents);
          route.bufferedEvents = route.bufferedEvents.filter(
            (event) => !delivered.has(event),
          );
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
      for (const [capability, buffered] of state.capabilityBuffers) {
        const retained = buffered.filter(
          (item) => item.sessionId !== params.sessionId,
        );
        if (retained.length === 0) {
          state.capabilityBuffers.delete(capability);
        } else if (retained.length !== buffered.length) {
          state.capabilityBuffers.set(capability, retained);
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
    const targetCapability = targetCapabilityFromEvent(event);
    if (targetCapability !== null) {
      return this.broadcastCapabilityEvent(
        sessionId,
        targetCapability,
        event,
      );
    }
    const evictedClientIds: string[] = [];
    const rejectedDeliveries: AgenCSessionBroadcastFailure[] = [];
    const isMobileStatus = isMobileStatusPushEvent(event);
    const { deliveries, hadLiveTargets, bufferedWithoutTarget } =
      await this.#state.with(async (state) => {
      const existingRoute = state.sessions.get(sessionId);

      const attachedClients =
        existingRoute === undefined
          ? []
          : [...existingRoute.clientAttachmentIds.keys()]
              .map((clientId) => state.clients.get(clientId))
              .filter((client): client is MutableClient => client !== undefined);

      // Status observers are initialized connection-level clients. Union them
      // with explicit session attachments by PHYSICAL delivery key, preferring
      // the attached logical client when both represent the same socket.
      const targetsByDeliveryKey = new Map<string, MutableClient>();
      if (isMobileStatus) {
        for (const client of state.clients.values()) {
          if (
            !client.evicted &&
            client.capabilities.has(AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY)
          ) {
            targetsByDeliveryKey.set(client.deliveryKey, client);
          }
        }
      }
      for (const client of attachedClients) {
        if (!client.evicted) targetsByDeliveryKey.set(client.deliveryKey, client);
      }
      const activeClients = [...targetsByDeliveryKey.values()];

      if (activeClients.length === 0) {
        // No attached client to deliver to. Only buffer (creating a route on
        // demand) when the session is still live: a terminated/unknown session
        // can never gain a client to drain the buffer, and its buffer-only
        // route is never reaped (deleteRouteIfEmpty keeps any route with
        // buffered events), so creating one here would leak `state.sessions`
        // unbounded on a long-lived daemon. Dropping late events for a dead
        // session is correct — nobody can ever replay them.
        if (existingRoute === undefined && !(await this.#isSessionLive(sessionId))) {
          return {
            deliveries: [] as EnqueuedDelivery[],
            hadLiveTargets: false,
            bufferedWithoutTarget: false,
          };
        }
        const route = existingRoute ?? getOrCreateRoute(state, sessionId);
        try {
          bufferSessionEvent(
            route,
            event,
            this.#maxBufferedEventsPerSession,
            this.#maxBufferedBytesPerSession,
          );
        } catch (error) {
          deleteRouteIfEmpty(state, route);
          throw error;
        }
        return {
          deliveries: [] as EnqueuedDelivery[],
          hadLiveTargets: false,
          bufferedWithoutTarget: true,
        };
      }

      return {
        deliveries: activeClients
        .map((client) =>
          enqueueDelivery(
            client,
            event,
            this.#maxPendingDeliveryBytesPerClient,
            this.#maxPendingDeliveryCountPerClient,
            evictedClientIds,
            rejectedDeliveries,
          ),
        )
        .filter((delivery): delivery is EnqueuedDelivery => delivery !== null),
        hadLiveTargets: true,
        bufferedWithoutTarget: false,
      };
    });
    await this.#evictSlowClients(evictedClientIds);
    const settled = await settleDeliveries(deliveries);

    // If every live status delivery failed (or was cap-evicted), retain the
    // frame in the same bounded per-session buffer used for disconnected
    // clients. A later observer registration replays it without exposing any
    // non-status transcript events.
    if (
      isMobileStatus &&
      hadLiveTargets &&
      !bufferedWithoutTarget &&
      settled.deliveredClientIds.length === 0
    ) {
      await this.#state.with(async (state) => {
        const existingRoute = state.sessions.get(sessionId);
        if (
          existingRoute === undefined &&
          !(await this.#isSessionLive(sessionId))
        ) {
          return;
        }
        const route = existingRoute ?? getOrCreateRoute(state, sessionId);
        try {
          bufferSessionEvent(
            route,
            event,
            this.#maxBufferedEventsPerSession,
            this.#maxBufferedBytesPerSession,
          );
        } catch (error) {
          deleteRouteIfEmpty(state, route);
          throw error;
        }
      });
    }

    return {
      sessionId,
      deliveredClientIds: settled.deliveredClientIds,
      failed: [...settled.failed, ...rejectedDeliveries],
    };
  }

  /**
   * Deliver a client action to initialized clients advertising an exact
   * capability, independently of transcript/session attachment. A Ledger action
   * is financial one-shot work, so exactly one deterministic client receives a
   * live delivery: the most recently registered capable client. With no live
   * target, or when that sole delivery fails, retain a bounded replay buffer for
   * the next capable reconnect rather than falling through to another phone.
   */
  async broadcastCapabilityEvent(
    sessionId: string,
    capability: string,
    event: JsonObject,
  ): Promise<AgenCSessionBroadcastResult> {
    const evictedClientIds: string[] = [];
    const rejectedDeliveries: AgenCSessionBroadcastFailure[] = [];
    const { deliveries, bufferAfterDelivery } = await this.#state.with(
      async (state) => {
        // Map iteration order is registration order. Retaining the last match
        // makes selection deterministic and prefers the newest live phone.
        let target: MutableClient | undefined;
        for (const client of state.clients.values()) {
          if (client.capabilities.has(capability) && !client.evicted) {
            target = client;
          }
        }
        if (target === undefined) {
          if (!(await this.#isSessionLive(sessionId))) return {
            deliveries: [] as EnqueuedDelivery[],
            bufferAfterDelivery: false,
          };
          const buffered = state.capabilityBuffers.get(capability) ?? [];
          bufferCapabilityEvent(
            buffered,
            { sessionId, event },
            this.#maxBufferedEventsPerSession,
            this.#maxBufferedBytesPerSession,
          );
          state.capabilityBuffers.set(capability, buffered);
          return {
            deliveries: [] as EnqueuedDelivery[],
            bufferAfterDelivery: false,
          };
        }
        const delivery = enqueueDelivery(
          target,
          event,
          this.#maxPendingDeliveryBytesPerClient,
          this.#maxPendingDeliveryCountPerClient,
          evictedClientIds,
          rejectedDeliveries,
        );
        return {
          deliveries: delivery === null ? [] : [delivery],
          // A cap-triggered eviction returns no delivery. Preserve the action
          // just like an asynchronous socket-send failure below.
          bufferAfterDelivery: delivery === null,
        };
      },
    );
    await this.#evictSlowClients(evictedClientIds);
    const result = await settleDeliveries(deliveries);
    if (bufferAfterDelivery || result.failed.length > 0) {
      await this.#state.with(async (state) => {
        if (!(await this.#isSessionLive(sessionId))) return [];
        const buffered = state.capabilityBuffers.get(capability) ?? [];
        bufferCapabilityEvent(
          buffered,
          { sessionId, event },
          this.#maxBufferedEventsPerSession,
          this.#maxBufferedBytesPerSession,
        );
        state.capabilityBuffers.set(capability, buffered);
        return [];
      });
    }
    return {
      sessionId,
      deliveredClientIds: result.deliveredClientIds,
      failed: [...result.failed, ...rejectedDeliveries],
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

interface ReplayDeliveryReservation {
  readonly bytes: number;
  readonly count: number;
}

/**
 * Validate the aggregate retained references before any replay closure is
 * queued. Per-event validation alone is insufficient: concurrent attaches can
 * otherwise chain arbitrarily many bounded arrays behind one blocked send
 * while the live pending counters still read zero.
 */
function assertReplayDeliveriesFitAvailable(
  client: MutableClient,
  batches: readonly (readonly JsonObject[])[],
  maxPendingBytes: number,
  maxPendingCount: number,
): ReplayDeliveryReservation {
  let bytes = 0;
  let count = 0;
  for (const batch of batches) {
    for (const event of batch) {
      const eventBytes = bufferedEventByteSize(event);
      if (eventBytes > maxPendingBytes || maxPendingCount < 1) {
        throw deliveryLimitError(eventBytes, maxPendingBytes);
      }
      bytes += eventBytes;
      count += 1;
      if (
        !Number.isSafeInteger(bytes) ||
        client.pendingDeliveryBytes + bytes > maxPendingBytes ||
        client.pendingDeliveryCount + count > maxPendingCount
      ) {
        throw new AgenCClientMultiplexerError(
          "EVENT_DELIVERY_LIMIT_EXCEEDED",
          "AgenC replay batch exceeds the client pending delivery byte/count limits",
        );
      }
    }
  }
  return { bytes, count };
}

/**
 * Replay payloads already live in bounded retention buffers. Reserve the whole
 * batch synchronously, then send its events in order through one queued task.
 * The reservation includes closures waiting behind an earlier blocked send.
 */
function enqueueReplayDelivery(
  client: MutableClient | undefined,
  events: readonly JsonObject[],
  maxPendingBytes: number,
  maxPendingCount: number,
): EnqueuedDelivery | null {
  if (client === undefined || client.evicted || events.length === 0) return null;
  const reservation = assertReplayDeliveriesFitAvailable(
    client,
    [events],
    maxPendingBytes,
    maxPendingCount,
  );
  client.pendingDeliveryBytes += reservation.bytes;
  client.pendingDeliveryCount += reservation.count;

  const delivered = client.deliveryQueue.then(async () => {
    try {
      if (client.evicted) {
        throw new AgenCClientMultiplexerError(
          "EVENT_DELIVERY_LIMIT_EXCEEDED",
          "AgenC replay delivery was cancelled after client eviction",
        );
      }
      for (const event of events) {
        await client.send(event);
      }
    } finally {
      client.pendingDeliveryBytes -= reservation.bytes;
      client.pendingDeliveryCount -= reservation.count;
    }
  });
  client.deliveryQueue = delivered.then(
    () => undefined,
    () => undefined,
  );
  return {
    clientId: client.clientId,
    delivered,
  };
}

/**
 * Bound on a single attached client's pending (queued-but-undelivered) delivery
 * backlog for the ONGOING broadcast path. Mirrors the detached-session
 * buffering caps: a client whose pending backlog exceeds {@link maxPendingBytes}
 * bytes OR {@link maxPendingCount} events is a stuck/backpressured slow consumer
 * and is evicted rather than allowed to pin daemon heap without limit.
 *
 * Live broadcasts evict a slow client and report the rejected delivery.
 * Detached replay uses the separate sequential path above.
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
  rejectedDeliveries: AgenCSessionBroadcastFailure[],
): EnqueuedDelivery | null {
  if (client === undefined || client.evicted) return null;

  const eventBytes = bufferedEventByteSize(event);
  if (eventBytes > maxPendingBytes || maxPendingCount < 1) {
    const error = deliveryLimitError(eventBytes, maxPendingBytes);
    client.evicted = true;
    evictedClientIds.push(client.clientId);
    rejectedDeliveries.push({
      clientId: client.clientId,
      message: error.message,
    });
    return null;
  }

  // Trip the cap when this event WOULD push the pending backlog over either
  // budget. A single oversized event was rejected above even for an idle
  // client, so neither byte nor count accounting can exceed its hard cap.
  if (
    (client.pendingDeliveryBytes + eventBytes > maxPendingBytes ||
      client.pendingDeliveryCount + 1 > maxPendingCount)
  ) {
    client.evicted = true;
    evictedClientIds.push(client.clientId);
    rejectedDeliveries.push({
      clientId: client.clientId,
      message:
        "AgenC client pending delivery limit exceeded while enqueueing an event",
    });
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

/**
 * In-band retention-gap marker announcing evicted buffered events, using the
 * frozen vocabulary (EVENT_GAP_EVENT + RunEventGap reason "retention",
 * contracts/run-contracts.ts). It is a real JSON-RPC notification so socket
 * clients cannot silently discard the loss marker while dispatching by
 * `method`. Sequence-addressed durable gaps remain authoritative via
 * `run.replay`; this notification tells a live client when it must reattach.
 *
 * Invariants: at most ONE marker per session buffer, always at the head,
 * merged (retiredCount accumulates) across evictions, and counted against both
 * hard capacities. It leaves the buffer only by being replayed — a fully-acked
 * replay splices it out with the replayed prefix, so a later eviction starts a
 * fresh marker for the next reconnecting client. After a failed (unacked)
 * replay the buffer — marker included — is retained for the next attach.
 */
function makeEventGapMarker(
  sessionId: string,
  retiredCount: number,
  coordinates: {
    readonly runId?: string;
    readonly afterSequence?: number;
    readonly firstAvailableSequence?: number;
  } = {},
): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "event.event_gap",
    params: {
      type: EVENT_GAP_EVENT,
      kind: EVENT_GAP_EVENT,
      sessionId,
      ...(coordinates.runId !== undefined ? { runId: coordinates.runId } : {}),
      ...(coordinates.afterSequence !== undefined
        ? { afterSequence: coordinates.afterSequence }
        : {}),
      ...(coordinates.firstAvailableSequence !== undefined
        ? { firstAvailableSequence: coordinates.firstAvailableSequence }
        : {}),
      reason: "retention",
      retiredCount,
      // Brand so the predicate below can never confuse a future
      // sequence-addressed RunEventGap journal event (same frozen type
      // vocabulary) with a multiplexer-owned retention marker.
      source: "multiplexer_retention",
    },
  };
}

function isBufferedEventGapMarker(event: JsonObject): boolean {
  const params = bufferedEventGapParams(event);
  return (
    event.method === "event.event_gap" &&
    params?.type === EVENT_GAP_EVENT &&
    params.reason === "retention" &&
    params.source === "multiplexer_retention"
  );
}

function bufferedEventGapParams(event: JsonObject): JsonObject | undefined {
  const params = event.params;
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as JsonObject)
    : undefined;
}

/** Merge newly retired events into the head marker (creating it if absent). */
function recordRetiredEvents(
  bufferedEvents: JsonObject[],
  sessionId: string,
  retiredEvents: readonly JsonObject[],
): void {
  const retiredCount = retiredEvents.length;
  if (retiredCount <= 0) return;
  const head = bufferedEvents[0];
  const firstReal =
    head !== undefined && isBufferedEventGapMarker(head)
      ? bufferedEvents[1]
      : head;
  const retiredSequences = retiredEvents
    .map(bufferedEventSequence)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  const previousAfter =
    head !== undefined && isBufferedEventGapMarker(head) &&
    typeof bufferedEventGapParams(head)?.afterSequence === "number"
      ? (bufferedEventGapParams(head)!.afterSequence as number)
      : undefined;
  const afterSequence =
    previousAfter ??
    (retiredSequences.length > 0 ? retiredSequences[0]! - 1 : undefined);
  const firstAvailableSequence = bufferedEventSequence(firstReal);
  const runId =
    bufferedEventRunId(firstReal) ??
    retiredEvents.map(bufferedEventRunId).find((value) => value !== undefined) ??
    (head !== undefined && isBufferedEventGapMarker(head) &&
    typeof bufferedEventGapParams(head)?.runId === "string"
      ? (bufferedEventGapParams(head)!.runId as string)
      : sessionId);
  const coordinates = {
    ...(runId !== undefined ? { runId } : {}),
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(firstAvailableSequence !== undefined
      ? { firstAvailableSequence }
      : {}),
  };
  if (head !== undefined && isBufferedEventGapMarker(head)) {
    const headParams = bufferedEventGapParams(head);
    const previous =
      typeof headParams?.retiredCount === "number" ? headParams.retiredCount : 0;
    bufferedEvents[0] = makeEventGapMarker(
      sessionId,
      previous + retiredCount,
      coordinates,
    );
    return;
  }
  bufferedEvents.unshift(
    makeEventGapMarker(sessionId, retiredCount, coordinates),
  );
}

function bufferSessionEvent(
  route: MutableSessionRoute,
  event: JsonObject,
  maxBufferedEvents: number,
  maxBufferedBytes: number,
): void {
  const eventBytes = bufferedEventByteSize(event);
  if (eventBytes > maxBufferedBytes || maxBufferedEvents < 1) {
    throw bufferLimitError(eventBytes, maxBufferedBytes);
  }
  const previous = [...route.bufferedEvents];
  route.bufferedEvents.push(event);
  while (
    !bufferWithinLimits(
      route.bufferedEvents,
      maxBufferedEvents,
      maxBufferedBytes,
    )
  ) {
    const startIndex =
      route.bufferedEvents[0] !== undefined &&
      isBufferedEventGapMarker(route.bufferedEvents[0])
        ? 1
        : 0;
    const [retired] = route.bufferedEvents.splice(startIndex, 1);
    if (retired === undefined) {
      route.bufferedEvents.splice(
        0,
        route.bufferedEvents.length,
        ...previous,
      );
      throw new AgenCClientMultiplexerError(
        "EVENT_BUFFER_LIMIT_EXCEEDED",
        "AgenC event buffer limit cannot retain its explicit gap marker",
      );
    }
    recordRetiredEvents(route.bufferedEvents, route.sessionId, [retired]);
  }
}

function advertisedCapabilities(capabilities: JsonObject | undefined): Set<string> {
  if (capabilities === undefined) return new Set();
  return new Set(
    Object.entries(capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([capability]) => capability),
  );
}

function isMobileStatusPushEvent(event: JsonObject): boolean {
  return event.method === "event.agent_status";
}

function targetCapabilityFromEvent(event: JsonObject): string | null {
  if (event.method !== "event.user_input_request") return null;
  const params = event.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const clientAction = (params as JsonObject).clientAction;
  if (
    clientAction === null ||
    typeof clientAction !== "object" ||
    Array.isArray(clientAction)
  ) {
    return null;
  }
  const targetCapability = (clientAction as JsonObject).targetCapability;
  return (clientAction as JsonObject).type === "ledger_solana_transfer_v1" &&
    typeof targetCapability === "string" &&
    targetCapability.length > 0
    ? targetCapability
    : null;
}

function bufferCapabilityEvent(
  buffered: BufferedCapabilityEvent[],
  item: BufferedCapabilityEvent,
  maxBufferedEvents: number,
  maxBufferedBytes: number,
): void {
  const eventBytes = bufferedEventByteSize(item.event);
  const total = buffered.reduce(
    (sum, item) => sum + bufferedEventByteSize(item.event),
    0,
  );
  if (
    buffered.length + 1 > maxBufferedEvents ||
    total + eventBytes > maxBufferedBytes
  ) {
    throw new AgenCClientMultiplexerError(
      "EVENT_BUFFER_LIMIT_EXCEEDED",
      "AgenC capability event buffer limit exceeded; the event was not queued",
    );
  }
  buffered.push(item);
}

/**
 * Approximate the serialized byte size of a buffered event. Buffered events
 * are JSON notifications, so the UTF-8 length of their JSON encoding is a
 * faithful proxy for the memory they pin. Values that cannot be stringified
 * are treated as maximally large so every valid byte cap rejects them.
 */
function bufferedEventByteSize(event: JsonObject): number {
  try {
    return Buffer.byteLength(JSON.stringify(event));
  } catch {
    // Non-serializable/cyclic input must fail closed against every valid cap;
    // treating it as zero would make the byte budget advisory.
    return Number.MAX_SAFE_INTEGER;
  }
}

function bufferedEventsByteSize(events: readonly JsonObject[]): number {
  return events.reduce(
    (total, event) => total + bufferedEventByteSize(event),
    0,
  );
}

function bufferWithinLimits(
  events: readonly JsonObject[],
  maxBufferedEvents: number,
  maxBufferedBytes: number,
): boolean {
  return (
    events.length <= maxBufferedEvents &&
    bufferedEventsByteSize(events) <= maxBufferedBytes
  );
}

function bufferLimitError(
  eventBytes: number,
  maxBufferedBytes: number,
): AgenCClientMultiplexerError {
  return new AgenCClientMultiplexerError(
    "EVENT_BUFFER_LIMIT_EXCEEDED",
    "AgenC event buffer limit exceeded: event requires " +
      String(eventBytes) +
      " bytes but the detached-session cap is " +
      String(maxBufferedBytes),
  );
}

function deliveryLimitError(
  eventBytes: number,
  maxPendingBytes: number,
): AgenCClientMultiplexerError {
  return new AgenCClientMultiplexerError(
    "EVENT_DELIVERY_LIMIT_EXCEEDED",
    "AgenC event delivery limit exceeded: event requires " +
      String(eventBytes) +
      " bytes but the per-client cap is " +
      String(maxPendingBytes),
  );
}

function assertEventFitsDeliveryLimit(
  event: JsonObject,
  maxPendingBytes: number,
  maxPendingCount: number,
): void {
  const eventBytes = bufferedEventByteSize(event);
  if (eventBytes > maxPendingBytes || maxPendingCount < 1) {
    throw deliveryLimitError(eventBytes, maxPendingBytes);
  }
}

function bufferedEventSequence(event: JsonObject | undefined): number | undefined {
  if (event === undefined) return undefined;
  const direct = event.sequence;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct > 0) {
    return direct;
  }
  const params = event.params;
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const nested = (params as JsonObject).sequence;
    if (
      typeof nested === "number" &&
      Number.isSafeInteger(nested) &&
      nested > 0
    ) {
      return nested;
    }
  }
  return undefined;
}

function bufferedEventRunId(event: JsonObject | undefined): string | undefined {
  if (event === undefined) return undefined;
  for (const value of [event.runId, event.agentId]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  const params = event.params;
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const object = params as JsonObject;
    for (const value of [object.runId, object.agentId]) {
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Note: a buffer holding only a gap marker deliberately keeps the route
 * alive — the announced loss must survive for the next attaching client.
 * The pin is one small object per session and clears on attach/terminate.
 */
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

function normalizePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(name + " must be a positive safe integer");
  }
  return value;
}
