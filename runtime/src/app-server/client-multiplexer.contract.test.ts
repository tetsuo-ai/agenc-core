import { describe, expect, it } from "vitest";
import {
  AgenCClientMultiplexerError,
  AgenCDaemonClientMultiplexer,
} from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type { JsonObject } from "./protocol/index.js";

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

function createHarness(): {
  readonly sessionManager: AgenCDaemonSessionManager;
  readonly multiplexer: AgenCDaemonClientMultiplexer;
} {
  const sessionManager = new AgenCDaemonSessionManager({
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
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager });
  return { sessionManager, multiplexer };
}

describe("AgenC daemon client multiplexer", () => {
  it("attaches multiple clients to one session and broadcasts to all of them", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const clientMessages = new Map<string, JsonObject[]>();

    await sessionManager.createSession({ agentId: "agent_1" });
    for (const clientId of ["client_1", "client_2"]) {
      clientMessages.set(clientId, []);
      await multiplexer.registerClient({
        clientId,
        send: (message) => {
          clientMessages.get(clientId)?.push(message);
        },
      });
      await multiplexer.attachClientToSession("session_1", clientId);
    }

    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([
      "client_1",
      "client_2",
    ]);
    await expect(sessionManager.getSession("session_1")).resolves.toMatchObject({
      activeAttachmentIds: ["attachment_1", "attachment_2"],
    });

    const event = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
      text: "ready",
    };
    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["client_1", "client_2"],
      failed: [],
    });
    expect(clientMessages.get("client_1")).toEqual([event]);
    expect(clientMessages.get("client_2")).toEqual([event]);
  });

  it("keeps per-client delivery failures isolated during broadcast", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const deliveredToClient2: JsonObject[] = [];

    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "client_1",
      send: () => {
        throw new Error("client sink failed");
      },
    });
    await multiplexer.registerClient({
      clientId: "client_2",
      send: (message) => {
        deliveredToClient2.push(message);
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_1");
    await multiplexer.attachClientToSession("session_1", "client_2");

    const event = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
    };
    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["client_2"],
      failed: [{ clientId: "client_1", message: "client sink failed" }],
    });
    expect(deliveredToClient2).toEqual([event]);
  });

  it("detaches one client without disturbing the remaining session route", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const client1Messages: JsonObject[] = [];
    const client2Messages: JsonObject[] = [];

    await sessionManager.createSession({ agentId: "agent_1" });
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

    await expect(
      multiplexer.detachClientFromSession("session_1", "client_1"),
    ).resolves.toEqual({
      sessionId: "session_1",
      attachmentId: "attachment_1",
      detached: true,
      remainingAttachmentIds: ["attachment_2"],
    });
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([
      "client_2",
    ]);

    const event = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 2,
    };
    await multiplexer.broadcastSessionEvent("session_1", event);
    expect(client1Messages).toEqual([]);
    expect(client2Messages).toEqual([event]);
  });

  it("serializes event order independently for each client", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const received: number[] = [];

    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "client_1",
      send: async (message) => {
        await Promise.resolve();
        received.push(Number(message.sequence));
      },
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    await Promise.all([
      multiplexer.broadcastSessionEvent("session_1", {
        type: "session.delta",
        sessionId: "session_1",
        sequence: 1,
      }),
      multiplexer.broadcastSessionEvent("session_1", {
        type: "session.delta",
        sessionId: "session_1",
        sequence: 2,
      }),
    ]);

    expect(received).toEqual([1, 2]);
  });

  it("rejects unknown and duplicate clients before mutating session routes", async () => {
    const { sessionManager, multiplexer } = createHarness();
    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "client_1",
      send: () => {},
    });

    await expect(
      multiplexer.registerClient({ clientId: "client_1", send: () => {} }),
    ).rejects.toBeInstanceOf(AgenCClientMultiplexerError);
    await expect(
      multiplexer.attachClientToSession("session_1", "client_missing"),
    ).rejects.toMatchObject({
      code: "CLIENT_NOT_FOUND",
    });
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual(
      [],
    );
  });
});
