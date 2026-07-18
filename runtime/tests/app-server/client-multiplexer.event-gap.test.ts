// M4 event-gap markers: the detached-session replay buffer must ANNOUNCE
// eviction instead of hiding it. On count-cap or byte-budget eviction the
// multiplexer folds the loss into a single in-band marker (frozen vocabulary
// EVENT_GAP_EVENT / reason "retention", contracts/run-contracts.ts) at the
// buffer head, so a reconnecting client sees "N events were retired" rather
// than a transcript with silent holes.

import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { EVENT_GAP_EVENT } from "../../src/contracts/run-contracts.js";
import type { JsonObject } from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-client-multiplexer-event-gap-workspace-",
);

afterEach(async () => {
  await workspaces.cleanup();
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test sequence exhausted");
    index += 1;
    return value;
  };
}

function createHarness(options: {
  readonly maxBufferedEventsPerSession?: number;
  readonly maxBufferedBytesPerSession?: number;
}): {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
} {
  const sessionManager = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1"]),
    createAttachmentId: () => `attachment_${Math.random().toString(36).slice(2)}`,
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
    ...options,
  });
  return { sessionManager, multiplexer };
}

function smallEvent(sequenceNumber: number): JsonObject {
  return { type: "session.delta", sessionId: "session_1", sequence: sequenceNumber };
}

function bigEvent(sequenceNumber: number, payloadBytes: number): JsonObject {
  return { ...smallEvent(sequenceNumber), text: "x".repeat(payloadBytes) };
}

function isGapMarker(event: JsonObject): boolean {
  return event.type === EVENT_GAP_EVENT && event.reason === "retention";
}

async function attachAndCollect(
  multiplexer: AgenCDaemonClientMultiplexer,
  clientId: string,
): Promise<JsonObject[]> {
  const replayed: JsonObject[] = [];
  await multiplexer.registerClient({
    clientId,
    send: (message) => {
      replayed.push(message as JsonObject);
    },
  });
  await multiplexer.attachClientToSession("session_1", clientId);
  return replayed;
}

describe("client multiplexer event-gap markers", () => {
  it("announces count-cap eviction with a single merged head marker", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 5,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 12; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    const replayed = await attachAndCollect(multiplexer, "client_1");
    // One marker + the 5 newest real events, in order.
    expect(replayed).toHaveLength(6);
    expect(isGapMarker(replayed[0]!)).toBe(true);
    expect(replayed[0]).toMatchObject({
      sessionId: "session_1",
      retiredCount: 7,
    });
    expect(
      replayed.slice(1).map((event) => (event as { sequence: number }).sequence),
    ).toEqual([8, 9, 10, 11, 12]);
    // Exactly one marker in the whole stream.
    expect(replayed.filter(isGapMarker)).toHaveLength(1);
  });

  it("announces byte-budget eviction and never evicts the marker itself", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 100_000,
      maxBufferedBytesPerSession: 4 * 1100,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 50; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", bigEvent(index, 1000));
    }
    const replayed = await attachAndCollect(multiplexer, "client_1");
    const markers = replayed.filter(isGapMarker);
    expect(markers).toHaveLength(1);
    expect(isGapMarker(replayed[0]!)).toBe(true);
    const survivors = replayed.slice(1) as { sequence: number }[];
    expect(survivors.length).toBeGreaterThan(0);
    // Newest events survive; retiredCount accounts for every dropped event.
    expect(survivors[survivors.length - 1]!.sequence).toBe(50);
    expect((replayed[0] as { retiredCount: number }).retiredCount).toBe(
      50 - survivors.length,
    );
  });

  it("keeps the newest real event even when it alone exceeds the byte budget", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedBytesPerSession: 1024,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(1, 5000));
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(2, 100_000));
    const replayed = await attachAndCollect(multiplexer, "client_1");
    // Event 1 was evicted (announced); oversized event 2 is retained.
    expect(replayed).toHaveLength(2);
    expect(isGapMarker(replayed[0]!)).toBe(true);
    expect(replayed[0]).toMatchObject({ retiredCount: 1 });
    expect((replayed[1] as { sequence: number }).sequence).toBe(2);
  });

  it("produces no marker when nothing was evicted", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 10,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 3; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    const replayed = await attachAndCollect(multiplexer, "client_1");
    expect(replayed).toHaveLength(3);
    expect(replayed.some(isGapMarker)).toBe(false);
  });

  it("a fully-acked replay consumes the marker; later eviction starts fresh", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 2,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 5; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    const first = await attachAndCollect(multiplexer, "client_1");
    expect(first[0]).toMatchObject({ retiredCount: 3 });
    await multiplexer.disconnectClient("client_1");
    // New detached window: 3 more events, 1 evicted — the fresh marker must
    // count ONLY the new loss (the old one was delivered and acknowledged).
    for (let index = 6; index <= 8; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    const second = await attachAndCollect(multiplexer, "client_2");
    expect(second).toHaveLength(3);
    expect(second[0]).toMatchObject({ retiredCount: 1 });
    expect(
      second.slice(1).map((event) => (event as { sequence: number }).sequence),
    ).toEqual([7, 8]);
  });

  it("announces loss even when eviction races an in-flight replay (identity splice)", async () => {
    // The fully-acked replay cleanup must remove EXACTLY the delivered
    // events. If it spliced by count, evictions during the unlocked replay
    // window (which unshift/merge the head marker) would shift the buffer
    // so the splice destroys the marker and never-delivered events —
    // silently re-hiding announced loss.
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 3,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 3; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    // Client A's sends stall until released, holding the replay in flight.
    let releaseSends = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });
    const deliveredToA: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_a",
      send: async (message) => {
        await gate;
        deliveredToA.push(message as JsonObject);
      },
    });
    const attachInFlight = multiplexer.attachClientToSession(
      "session_1",
      "client_a",
    );
    // Detach A mid-replay so new broadcasts buffer (and evict) again.
    await new Promise((resolve) => setImmediate(resolve));
    await multiplexer.disconnectClient("client_a");
    for (let index = 4; index <= 7; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    // Release A's replay: it fully acks, triggering the buffer cleanup
    // while the buffer now holds [marker, e5, e6, e7].
    releaseSends();
    await attachInFlight;
    expect(deliveredToA).toHaveLength(3);
    // The next client must still see the announced loss and every
    // never-delivered event.
    const replayed = await attachAndCollect(multiplexer, "client_b");
    expect(replayed).toHaveLength(4);
    expect(isGapMarker(replayed[0]!)).toBe(true);
    expect(replayed[0]).toMatchObject({ retiredCount: 4 });
    expect(
      replayed.slice(1).map((event) => (event as { sequence: number }).sequence),
    ).toEqual([5, 6, 7]);
  });

  it("retains the marker for the next client after a failed (unacked) replay", async () => {
    const { sessionManager, multiplexer } = createHarness({
      maxBufferedEventsPerSession: 2,
    });
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    for (let index = 1; index <= 4; index += 1) {
      await multiplexer.broadcastSessionEvent("session_1", smallEvent(index));
    }
    await multiplexer.registerClient({
      clientId: "client_lost",
      send: () => {
        throw new Error("client lost before acknowledging replay");
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_lost");
    await multiplexer.disconnectClient("client_lost");
    // The buffer (marker included) was NOT spliced: the next client still
    // sees the announced loss.
    const replayed = await attachAndCollect(multiplexer, "client_2");
    expect(replayed).toHaveLength(3);
    expect(replayed[0]).toMatchObject({ retiredCount: 2 });
    expect(
      replayed.slice(1).map((event) => (event as { sequence: number }).sequence),
    ).toEqual([3, 4]);
  });
});
