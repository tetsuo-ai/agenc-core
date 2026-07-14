import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  JSON_RPC_VERSION,
  type AgenCDaemonSessionNotification,
  type JsonObject,
} from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-disconnect-resilience-workspace-",
);

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

function createHarness(maxBufferedEventsPerSession = 1000): {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
} {
  const sessionManager = new AgenCDaemonSessionManager({
    createSessionId: sequence(["session_1"]),
    createAttachmentId: sequence(["attachment_1", "attachment_2"]),
    now: sequence([
      "2026-05-01T10:00:00.000Z",
      "2026-05-01T10:00:01.000Z",
      "2026-05-01T10:00:02.000Z",
    ]),
  });
  const multiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
    maxBufferedEventsPerSession,
  });
  return { sessionManager, multiplexer };
}

describe("AgenC daemon disconnect resilience", () => {
  it("keeps the session alive and replays buffered events on reattach", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const replayed: JsonObject[] = [];

    const cwd = await workspaces.create();
    await sessionManager.createSession({ agentId: "agent_1", cwd });
    await multiplexer.registerClient({ clientId: "client_1", send: () => {} });
    await multiplexer.attachClientToSession("session_1", "client_1");

    await expect(multiplexer.disconnectClient("client_1")).resolves.toEqual([
      "session_1",
    ]);
    await expect(sessionManager.getSession("session_1")).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T10:00:00.000Z",
      cwd,
    });

    const event = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
      text: "still running",
    };
    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: [],
      failed: [],
    });

    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => replayed.push(message),
    });
    await expect(
      multiplexer.attachClientToSession("session_1", "client_1"),
    ).resolves.toMatchObject({
      attachmentId: "attachment_2",
      activeAttachmentIds: ["attachment_2"],
    });

    expect(replayed).toEqual([event]);
    await expect(sessionManager.getSession("session_1")).resolves.toMatchObject({
      sessionId: "session_1",
      status: "idle",
      activeAttachmentIds: ["attachment_2"],
    });
  });

  it("bounds buffered events and preserves their order for replay", async () => {
    const { sessionManager, multiplexer } = createHarness(2);
    const replayedSequences: number[] = [];

    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    await multiplexer.registerClient({ clientId: "client_1", send: () => {} });
    await multiplexer.attachClientToSession("session_1", "client_1");
    await multiplexer.disconnectClient("client_1");

    for (const sequence of [1, 2, 3]) {
      await multiplexer.broadcastSessionNotification("session_1", {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          eventId: `event_${sequence}`,
          sequence,
          event: {
            type: "session.delta",
            sequence,
          },
        },
      } satisfies AgenCDaemonSessionNotification);
    }

    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => {
        const params = message.params;
        if (typeof params === "object" && params !== null && "sequence" in params) {
          replayedSequences.push(Number(params.sequence));
        }
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(replayedSequences).toEqual([2, 3]);
  });
});
