import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonHealthService } from "./health.js";
import { AGENC_DAEMON_METHODS } from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type { JsonObject } from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture("agenc-daemon-f03-workspace-");

afterEach(async () => {
  await workspaces.cleanup();
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

describe("AgenC daemon F-03 contract coverage", () => {
  it("covers protocol, multi-client delivery, disconnect replay, and health stats together", async () => {
    expect(AGENC_DAEMON_METHODS).toEqual(
      expect.arrayContaining([
        "session.create",
        "session.attach",
        "session.detach",
        "session.terminate",
        "health.ping",
        "health.ready",
        "health.stats",
      ]),
    );

    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence([
        "attachment_1",
        "attachment_2",
        "attachment_3",
      ]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
        "2026-05-01T10:00:03.000Z",
      ]),
    });
    const multiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const health = new AgenCDaemonHealthService({
      startedAtMs: 1000,
      nowMs: () => 2000,
      sessionCounter: sessions,
      memoryUsage: () => ({
        rss: 10,
        heapTotal: 20,
        heapUsed: 30,
        external: 40,
        arrayBuffers: 50,
      }),
    });

    await sessions.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    const client1Messages: JsonObject[] = [];
    const client2Messages: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => client1Messages.push(message),
    });
    await multiplexer.registerClient({
      clientId: "client_2",
      send: (message) => client2Messages.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");
    await multiplexer.attachClientToSession("session_1", "client_2");

    const liveEvent = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
    };
    await expect(
      multiplexer.broadcastSessionEvent("session_1", liveEvent),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["client_1", "client_2"],
      failed: [],
    });
    expect(client1Messages).toEqual([liveEvent]);
    expect(client2Messages).toEqual([liveEvent]);

    await multiplexer.disconnectClient("client_1");
    await multiplexer.disconnectClient("client_2");
    const bufferedEvent = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 2,
    };
    await multiplexer.broadcastSessionEvent("session_1", bufferedEvent);

    const replayedMessages: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_2",
      send: (message) => replayedMessages.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_2");
    expect(replayedMessages).toEqual([bufferedEvent]);

    await expect(health.stats()).resolves.toMatchObject({
      uptimeMs: 1000,
      sessions: { active: 1, closed: 0, total: 1 },
      memory: {
        rss: 10,
        heapTotal: 20,
        heapUsed: 30,
        external: 40,
        arrayBuffers: 50,
      },
    });
  });
});
