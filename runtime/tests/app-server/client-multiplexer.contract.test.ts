import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import {
  AgenCClientMultiplexerError,
  AgenCDaemonClientMultiplexer,
} from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY,
  JSON_RPC_VERSION,
  type AgenCDaemonSessionNotification,
  type JsonObject,
} from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-client-multiplexer-workspace-",
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

async function createSession(
  sessionManager: AgenCDaemonSessionManager,
): Promise<void> {
  await sessionManager.createSession({
    agentId: "agent_1",
    cwd: await workspaces.create(),
  });
}

describe("AgenC daemon client multiplexer", () => {

  it("pushes agent status to an opted-in mobile client without session attachment", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    await createSession(sessionManager);
    await multiplexer.registerClient({
      clientId: "phone-status",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: (message) => phone.push(message),
    });
    const status = agentStatusNotification("session_1", "status-live");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", status),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["phone-status"],
      failed: [],
    });
    expect(phone).toEqual([status]);
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([]);
  });

  it("keeps ordinary session events attachment-only for a status observer", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    await createSession(sessionManager);
    await multiplexer.registerClient({
      clientId: "phone-status",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: (message) => phone.push(message),
    });
    const ordinary = sessionEventNotification("session_1", "ordinary-live");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", ordinary),
    ).resolves.toMatchObject({ deliveredClientIds: [], failed: [] });
    expect(phone).toEqual([]);
  });

  it("deduplicates an observer and attached logical client sharing one socket", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const observerFrames: JsonObject[] = [];
    const attachedFrames: JsonObject[] = [];
    await createSession(sessionManager);
    await multiplexer.registerClient({
      clientId: "initialized-socket",
      deliveryKey: "physical-socket",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: (message) => observerFrames.push(message),
    });
    await multiplexer.registerClient({
      clientId: "attached-logical-client",
      deliveryKey: "physical-socket",
      send: (message) => attachedFrames.push(message),
    });
    await multiplexer.attachClientToSession(
      "session_1",
      "attached-logical-client",
    );
    const status = agentStatusNotification("session_1", "status-dedup");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", status),
    ).resolves.toMatchObject({
      deliveredClientIds: ["attached-logical-client"],
      failed: [],
    });
    expect(observerFrames).toEqual([]);
    expect(attachedFrames).toEqual([status]);
  });

  it("replays only buffered status to an observer and leaves normal events for attach", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    const chat: JsonObject[] = [];
    await createSession(sessionManager);
    const ordinary = sessionEventNotification("session_1", "ordinary-buffered");
    const status = agentStatusNotification("session_1", "status-buffered");
    await multiplexer.broadcastSessionEvent("session_1", ordinary);
    await multiplexer.broadcastSessionEvent("session_1", status);

    await multiplexer.registerClient({
      clientId: "phone-status",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: (message) => phone.push(message),
    });
    expect(phone).toEqual([status]);

    await multiplexer.registerClient({
      clientId: "chat-client",
      send: (message) => chat.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "chat-client");
    expect(chat).toEqual([ordinary]);
  });

  it("retains failed live status delivery for the next observer reconnect", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const replacement: JsonObject[] = [];
    await createSession(sessionManager);
    await multiplexer.registerClient({
      clientId: "failing-status-phone",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: () => {
        throw new Error("status socket failed");
      },
    });
    const status = agentStatusNotification("session_1", "status-recover");
    await expect(
      multiplexer.broadcastSessionEvent("session_1", status),
    ).resolves.toMatchObject({ deliveredClientIds: [], failed: [expect.anything()] });
    await multiplexer.removeClient("failing-status-phone");

    await multiplexer.registerClient({
      clientId: "replacement-status-phone",
      capabilities: { [AGENC_PORTAL_MOBILE_STATUS_PUSH_CAPABILITY]: true },
      send: (message) => replacement.push(message),
    });
    expect(replacement).toEqual([status]);
  });

  it("attaches multiple clients to one session and broadcasts to all of them", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const clientMessages = new Map<string, JsonObject[]>();

    await createSession(sessionManager);
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

    await createSession(sessionManager);
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

    await createSession(sessionManager);
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

  it("detaches by params while preserving attachmentId precedence", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const client2Messages: JsonObject[] = [];

    await createSession(sessionManager);
    await multiplexer.registerClient({
      clientId: "client_1",
      send: () => {},
    });
    await multiplexer.registerClient({
      clientId: "client_2",
      send: (message) => client2Messages.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");
    await multiplexer.attachClientToSession("session_1", "client_2");

    await expect(
      multiplexer.detachSession({
        sessionId: "session_1",
        attachmentId: "attachment_1",
        clientId: "client_2",
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      attachmentId: "attachment_1",
      detached: true,
      remainingAttachmentIds: ["attachment_2"],
    });
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([
      "client_2",
    ]);
    await expect(multiplexer.removeClient("client_1")).resolves.toEqual([]);

    const event = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 3,
    };
    await multiplexer.broadcastSessionEvent("session_1", event);
    expect(client2Messages).toEqual([event]);
  });

  it("terminates by params and clears route/client memberships", async () => {
    const { sessionManager, multiplexer } = createHarness();

    await createSession(sessionManager);
    for (const clientId of ["client_1", "client_2"]) {
      await multiplexer.registerClient({ clientId, send: () => {} });
      await multiplexer.attachClientToSession("session_1", clientId);
    }

    await expect(
      multiplexer.terminateSession({
        sessionId: "session_1",
        reason: "done",
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      terminated: true,
      status: "closed",
      closedAt: "2026-05-01T10:00:03.000Z",
      reason: "done",
    });
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([]);
    await expect(sessionManager.getSession("session_1")).resolves.not.toHaveProperty(
      "activeAttachmentIds",
    );
    await expect(multiplexer.removeClient("client_1")).resolves.toEqual([]);
    await expect(multiplexer.removeClient("client_2")).resolves.toEqual([]);
    await expect(
      multiplexer.terminateSession({ sessionId: "session_1" }),
    ).resolves.toMatchObject({
      sessionId: "session_1",
      terminated: false,
      status: "closed",
    });
  });

  it("serializes event order independently for each client", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const received: number[] = [];

    await createSession(sessionManager);
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

  it("buffers daemon session events emitted before the first client attaches", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const received: JsonObject[] = [];

    await createSession(sessionManager);
    const event: AgenCDaemonSessionNotification = {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.message_chunk",
      params: {
        sessionId: "session_1",
        eventId: "early-turn",
        delta: "ready",
      },
    };

    await expect(
      multiplexer.broadcastSessionNotification("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: [],
      failed: [],
    });
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => received.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(received).toEqual([event]);
  });

  it("rejects typed notifications whose embedded session does not match the route", async () => {
    const { sessionManager, multiplexer } = createHarness();

    await createSession(sessionManager);
    await expect(
      multiplexer.broadcastSessionNotification("session_1", {
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_2",
          eventId: "mismatched",
          event: { type: "session.delta" },
        },
      }),
    ).rejects.toMatchObject({ code: "SESSION_NOTIFICATION_MISMATCH" });
  });

  it("rejects unknown and duplicate clients before mutating session routes", async () => {
    const { sessionManager, multiplexer } = createHarness();
    await createSession(sessionManager);
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

function agentStatusNotification(sessionId: string, eventId: string): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.agent_status",
    params: {
      sessionId,
      eventId,
      agentId: "agent_1",
      status: "idle",
      runStatus: "completed",
      turnId: "turn_1",
      message: "Task complete",
    },
  };
}

function sessionEventNotification(sessionId: string, eventId: string): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.session_event",
    params: {
      sessionId,
      eventId,
      event: { type: "agent_message", payload: { text: "done" } },
    },
  };
}
