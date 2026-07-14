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

  it("never evicts or drops events for a HEALTHY client replaying a buffer larger than the LIVE pending cap", async () => {
    // Correctness guard for the replay path: a freshly-attaching client replays
    // the WHOLE detached buffer in one synchronous batch inside the state lock,
    // and the per-delivery decrement microtasks cannot run during that
    // synchronous map. The fix makes replay BYPASS the live-broadcast eviction
    // cap (allowEvict=false) precisely so that synchronous accumulation can
    // never falsely evict a healthy client mid-replay or let the post-replay
    // splice drop an un-delivered boundary event.
    //
    // REVERT-SENSITIVITY: this only catches the cap-on-replay bug when the LIVE
    // pending cap is STRICTLY SMALLER than the detached-buffer cap. The detached
    // buffer trims itself to within its own cap before any replay, so when both
    // caps share one value the replay's running partial sums can never cross it
    // (the whole buffer already fits) — that coupling is exactly why the old
    // version of this test was a false guard. Here the detached buffer keeps a
    // multi-event run (~12 KB) that is far larger than the small live pending
    // cap (2 KB / 3 events). If replay enqueued with allowEvict=true (the v1
    // bug) the running pending backlog crosses the small live cap mid-replay and
    // the healthy client is wrongly evicted and its boundary events dropped.
    // With the shipped fix (allowEvict=false) the live cap is bypassed on replay
    // and every buffered event is delivered.
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
    // events) far exceed the 2 KB / 3-event live pending cap, while staying well
    // under the 1 MB detached-buffer cap so the detached eviction retains ALL of
    // them (no buffer trimming — every event is a replay survivor). ~1 KB each,
    // no single oversized payload.
    const newestSequence = 12;
    for (let i = 1; i <= newestSequence; i += 1) {
      await multiplexer.broadcastSessionEvent("session_1", bigEvent(i, 1000));
    }

    // A perfectly HEALTHY client (send resolves immediately) attaches and the
    // bounded buffer is replayed to it.
    const replayed: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "healthy_replay_client",
      send: (message) => {
        replayed.push(message);
        return Promise.resolve();
      },
    });
    await multiplexer.attachClientToSession(
      "session_1",
      "healthy_replay_client",
    );
    await new Promise((resolve) => setImmediate(resolve));

    // The healthy client was NOT evicted — even though the replayed run is far
    // larger than the live pending cap. Under the v1 cap-on-replay bug it WOULD
    // be evicted here (synchronous replay accumulation crosses the 2 KB cap).
    expect(evicted).not.toContain("healthy_replay_client");
    const stillAttached = await multiplexer.attachedClientIds("session_1");
    expect(stillAttached).toContain("healthy_replay_client");

    // ...and received EVERY buffered event, in order, with NO data loss. All
    // `newestSequence` events were retained by the detached buffer (it never
    // trimmed), so the replay must deliver the FULL contiguous run 1..N with the
    // newest (boundary) event present — the bug drops the boundary event and any
    // events past the point the running cap trips.
    expect(replayed.length).toBe(newestSequence);
    const replayedSequences = replayed.map(
      (event) => (event as { sequence: number }).sequence,
    );
    expect(replayedSequences[0]).toBe(1);
    expect(replayedSequences[replayedSequences.length - 1]).toBe(newestSequence);
    for (let i = 1; i < replayedSequences.length; i += 1) {
      const prev = replayedSequences[i - 1] as number;
      const cur = replayedSequences[i] as number;
      expect(cur).toBe(prev + 1);
    }

    // The buffer was fully drained on a clean replay (every retained event was
    // delivered and the buffer spliced empty), proving no event was lost AND the
    // splice did not discard an undelivered boundary event.
    await multiplexer.detachClientFromSession(
      "session_1",
      "healthy_replay_client",
    );
    // Re-attach and confirm nothing is re-replayed (buffer was fully consumed).
    const secondReplay: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "second_client",
      send: (message) => {
        secondReplay.push(message);
        return Promise.resolve();
      },
    });
    await multiplexer.attachClientToSession("session_1", "second_client");
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondReplay).toHaveLength(0);
  });
});
