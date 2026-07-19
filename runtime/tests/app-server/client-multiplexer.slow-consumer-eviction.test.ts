import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type { JsonObject } from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-client-multiplexer-slow-consumer-workspace-",
);

afterEach(async () => {
  await workspaces.cleanup();
});

// Harness with default (auto-generated) session/attachment ids and a real clock
// so tests that attach/detach/re-attach many times do not exhaust fixed
// sequences. Only the byte budget is pinned, which is all these tests assert on.
function createUnsequencedHarness(
  maxBufferedBytesPerSession: number,
  options: {
    readonly maxPendingDeliveryBytesPerClient?: number;
    readonly maxPendingDeliveryCountPerClient?: number;
    readonly maxBufferedEventsPerSession?: number;
  } = {},
): {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
  readonly evicted: string[];
} {
  const sessionManager = new AgenCDaemonSessionManager({
    createSessionId: () => "session_1",
  });
  const evicted: string[] = [];
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
    maxBufferedEventsPerSession: options.maxBufferedEventsPerSession ?? 100_000,
    maxBufferedBytesPerSession,
    ...(options.maxPendingDeliveryBytesPerClient !== undefined
      ? {
          maxPendingDeliveryBytesPerClient:
            options.maxPendingDeliveryBytesPerClient,
        }
      : {}),
    ...(options.maxPendingDeliveryCountPerClient !== undefined
      ? {
          maxPendingDeliveryCountPerClient:
            options.maxPendingDeliveryCountPerClient,
        }
      : {}),
    onClientEvicted: (clientId) => {
      evicted.push(clientId);
    },
  });
  return { sessionManager, multiplexer, evicted };
}

function bigEvent(sequenceNumber: number, payloadBytes: number): JsonObject {
  return {
    type: "session.delta",
    sessionId: "session_1",
    sequence: sequenceNumber,
    text: "x".repeat(payloadBytes),
  };
}

describe("client multiplexer slow-consumer eviction", () => {
  it("bounds a stuck attached client's pending backlog and evicts it, while a healthy client still receives everything", async () => {
    // Budget fits roughly ~8 of the ~1KB payloads below.
    const { sessionManager, multiplexer, evicted } =
      createUnsequencedHarness(8 * 1100);
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    // SLOW client: every send returns a promise that never settles, modelling a
    // backpressured / stuck socket whose OS write callback never fires. Count
    // how many events were actually handed to it before eviction.
    let slowSendCount = 0;
    await multiplexer.registerClient({
      clientId: "slow_client",
      send: () => {
        slowSendCount += 1;
        return new Promise<void>(() => {
          /* never resolves */
        });
      },
    });
    await multiplexer.attachClientToSession("session_1", "slow_client");

    // HEALTHY client: send resolves immediately, so its queue drains and its
    // pending counters return to ~zero between events.
    const healthyReceived: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "healthy_client",
      send: (message) => {
        healthyReceived.push(message);
        return Promise.resolve();
      },
    });
    await multiplexer.attachClientToSession("session_1", "healthy_client");

    // Drive many large events. Do NOT await each broadcast: the slow client's
    // first delivery never settles, so a broadcast that targets it never
    // resolves. A real producer emits faster than the stuck consumer drains but
    // yields the event loop between emits (its own delivery to the HEALTHY
    // client resolves), so we yield between broadcasts. That lets the healthy
    // client's queue drain (its pending counters return to ~zero) while the
    // slow client's keep climbing toward the cap.
    const totalEvents = 200;
    const broadcasts: Promise<unknown>[] = [];
    for (let i = 1; i <= totalEvents; i += 1) {
      broadcasts.push(
        multiplexer.broadcastSessionEvent("session_1", bigEvent(i, 1000)),
      );
      // Yield so the healthy client's just-enqueued delivery settles and
      // decrements before the next event is enqueued.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Let any trailing eviction/teardown microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));

    // (b) The slow client was EVICTED as a slow consumer and REMOVED from the
    // session route. Both are revert-sensitive: the old unbounded code has no
    // eviction path, so it never reports an eviction and never drops the client
    // from the route.
    expect(evicted).toContain("slow_client");
    expect(evicted).not.toContain("healthy_client");
    const stillAttached = await multiplexer.attachedClientIds("session_1");
    expect(stillAttached).not.toContain("slow_client");
    expect(stillAttached).toContain("healthy_client");

    // (a) The slow client's pending backlog is BOUNDED — it does NOT grow with
    // the event count. Capture how many events had reached the slow client at
    // eviction, then drive MANY more broadcasts: a bounded backlog means the
    // slow client receives ZERO further events (it is gone from the route), so
    // its send count stays flat. Against the old unbounded code the slow client
    // is never evicted, so every additional broadcast still enqueues to it and
    // the count keeps climbing with the event count.
    const slowSendCountAtEviction = slowSendCount;
    for (let i = totalEvents + 1; i <= totalEvents * 3; i += 1) {
      void multiplexer.broadcastSessionEvent("session_1", bigEvent(i, 1000));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    // Flat: no growth after eviction (bounded). Old code: would keep growing.
    expect(slowSendCount).toBe(slowSendCountAtEviction);
    // And the backlog that ever reached the slow client was a small bound near
    // budget/event-size, not proportional to the ~600 broadcasts driven total.
    expect(slowSendCount).toBeGreaterThan(0);
    expect(slowSendCount).toBeLessThan(20);

    // The healthy client, attached at the same time, still received EVERY one
    // of the first `totalEvents` events in order — its fast queue never tripped
    // the cap. (It keeps receiving the post-eviction events too, but we only
    // assert the controlled window.)
    expect(healthyReceived.length).toBeGreaterThanOrEqual(totalEvents);
    expect((healthyReceived[0] as { sequence: number }).sequence).toBe(1);
    for (let i = 0; i < totalEvents; i += 1) {
      expect((healthyReceived[i] as { sequence: number }).sequence).toBe(i + 1);
    }

    // Avoid unhandled-rejection noise from the broadcasts that target the
    // never-settling slow client: they stay pending, which is expected.
    void broadcasts;
  });

  it("rejects a retained replay batch larger than the client pending cap before attaching", async () => {
    // A retained buffer may use a larger budget than one client's socket
    // backlog. The aggregate replay must fail before session attachment rather
    // than hiding a large queued closure behind per-event accounting.
    const detachedBufferCap = 1024 * 1024; // generous: keep the whole run
    const { sessionManager, multiplexer, evicted } = createUnsequencedHarness(
      detachedBufferCap,
      {
        // Live pending caps STRICTLY SMALLER than the buffered run below.
        maxPendingDeliveryBytesPerClient: 2 * 1024,
        maxPendingDeliveryCountPerClient: 3,
      },
    );
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    // Buffer a contiguous multi-event run whose TOTAL bytes (~12 KB over 12
    // events) far exceed the 2 KB / 3-event pending cap, while staying well
    // under the 1 MB detached-buffer cap so the detached eviction retains ALL of
    // them (no buffer trimming — every event is a replay survivor). ~1 KB each,
    // no single oversized payload.
    const newestSequence = 12;
    for (let i = 1; i <= newestSequence; i += 1) {
      await multiplexer.broadcastSessionEvent("session_1", bigEvent(i, 1000));
    }

    // A perfectly healthy client is still not permission to exceed its
    // configured pending backlog.
    const replayed: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "healthy_replay_client",
      send: (message) => {
        replayed.push(message);
        return Promise.resolve();
      },
    });
    await expect(
      multiplexer.attachClientToSession(
        "session_1",
        "healthy_replay_client",
      ),
    ).rejects.toMatchObject({ code: "EVENT_DELIVERY_LIMIT_EXCEEDED" });
    expect(evicted).not.toContain("healthy_replay_client");
    const stillAttached = await multiplexer.attachedClientIds("session_1");
    expect(stillAttached).not.toContain("healthy_replay_client");
    expect(replayed).toHaveLength(0);
  });

  it("reserves a blocked replay batch so a concurrent attach cannot queue another", async () => {
    const { sessionManager, multiplexer } = createUnsequencedHarness(
      1024 * 1024,
      {
        maxPendingDeliveryBytesPerClient: 8 * 1024,
        maxPendingDeliveryCountPerClient: 3,
      },
    );
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(1, 1000));
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(2, 1000));

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await multiplexer.registerClient({
      clientId: "blocked_replay_client",
      send: () => blocked,
    });

    const firstAttach = multiplexer.attachClientToSession(
      "session_1",
      "blocked_replay_client",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      multiplexer.attachClientToSession(
        "session_1",
        "blocked_replay_client",
      ),
    ).rejects.toMatchObject({ code: "EVENT_DELIVERY_LIMIT_EXCEEDED" });

    release();
    await firstAttach;
  });

  it("rejects oversized live and replay events without exceeding either pending cap", async () => {
    const { sessionManager, multiplexer, evicted } = createUnsequencedHarness(
      1024 * 1024,
      {
        maxPendingDeliveryBytesPerClient: 1024,
        maxPendingDeliveryCountPerClient: 2,
      },
    );
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    let liveSends = 0;
    await multiplexer.registerClient({
      clientId: "live_client",
      send: () => {
        liveSends += 1;
      },
    });
    await multiplexer.attachClientToSession("session_1", "live_client");
    const liveResult = await multiplexer.broadcastSessionEvent(
      "session_1",
      bigEvent(1, 5000),
    );
    expect(liveSends).toBe(0);
    expect(evicted).toContain("live_client");
    expect(liveResult.failed).toMatchObject([
      {
        clientId: "live_client",
        message: expect.stringMatching(/delivery limit/i),
      },
    ]);

    // With no client attached, the same event fits the detached 1 MB buffer.
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(2, 5000));
    let replaySends = 0;
    await multiplexer.registerClient({
      clientId: "replay_client",
      send: () => {
        replaySends += 1;
      },
    });
    await expect(
      multiplexer.attachClientToSession("session_1", "replay_client"),
    ).rejects.toMatchObject({ code: "EVENT_DELIVERY_LIMIT_EXCEEDED" });
    expect(replaySends).toBe(0);
    expect(evicted).not.toContain("replay_client");
  });
});
