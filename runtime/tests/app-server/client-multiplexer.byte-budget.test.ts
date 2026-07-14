import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type { JsonObject } from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-client-multiplexer-byte-budget-workspace-",
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

function createHarness(
  maxBufferedBytesPerSession: number,
): {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
} {
  const sessionManager = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1"]),
    createAttachmentId: sequence(["attachment_1"]),
    now: sequence([
      "2026-05-01T10:00:00.000Z",
      "2026-05-01T10:00:01.000Z",
      "2026-05-01T10:00:02.000Z",
    ]),
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
    // Generous count cap so the BYTE budget is the binding constraint.
    maxBufferedEventsPerSession: 100_000,
    maxBufferedBytesPerSession,
  });
  return { sessionManager, multiplexer };
}

function bigEvent(sequenceNumber: number, payloadBytes: number): JsonObject {
  return {
    type: "session.delta",
    sessionId: "session_1",
    sequence: sequenceNumber,
    text: "x".repeat(payloadBytes),
  };
}

describe("client multiplexer buffered byte budget", () => {
  it("evicts oldest buffered events once the byte budget is exceeded", async () => {
    // Budget fits roughly four ~1KB payloads.
    const { sessionManager, multiplexer } = createHarness(4 * 1100);
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    // No client attached: every event is buffered. Push far more bytes than
    // the budget so eviction must kick in.
    for (let i = 1; i <= 50; i += 1) {
      await multiplexer.broadcastSessionEvent("session_1", bigEvent(i, 1000));
    }

    // Attach a client; the (bounded) buffer is replayed to it.
    const replayed: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => {
        replayed.push(message);
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    // Far fewer than 50 events survived the byte budget.
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.length).toBeLessThan(10);

    // The survivors are the most recent events (oldest evicted from the head).
    const lastReplayed = replayed[replayed.length - 1] as {
      sequence: number;
    };
    expect(lastReplayed.sequence).toBe(50);
    const firstReplayed = replayed[0] as { sequence: number };
    expect(firstReplayed.sequence).toBeGreaterThan(40);

    // Total replayed bytes stay within ~one event of the budget.
    const replayedBytes = replayed.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    expect(replayedBytes).toBeLessThanOrEqual(4 * 1100 + 1100);
  });

  it("always retains at least the most recent event even when it alone exceeds the budget", async () => {
    const { sessionManager, multiplexer } = createHarness(1024);
    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    // A single payload far larger than the whole budget.
    await multiplexer.broadcastSessionEvent("session_1", bigEvent(1, 100_000));

    const replayed: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => {
        replayed.push(message);
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(replayed).toHaveLength(1);
    expect((replayed[0] as { sequence: number }).sequence).toBe(1);
  });
});
