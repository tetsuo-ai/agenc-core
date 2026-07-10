import { describe, expect, it } from "vitest";
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
  it("routes Ledger client actions by initialized capability without session attachment", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    const tui: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "phone",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => phone.push(message),
    });
    await multiplexer.registerClient({
      clientId: "tui",
      send: (message) => tui.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "tui");
    const event = ledgerActionNotification("session_1", "intent-live");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["phone"],
      failed: [],
    });
    expect(phone).toEqual([event]);
    expect(tui).toEqual([]);
    await expect(multiplexer.attachedClientIds("session_1")).resolves.toEqual([
      "tui",
    ]);
  });

  it("routes a live Ledger action only to the most recently registered capable phone", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const olderPhone: JsonObject[] = [];
    const newerPhone: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "phone-older",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => olderPhone.push(message),
    });
    await multiplexer.registerClient({
      clientId: "phone-newer",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => newerPhone.push(message),
    });
    const event = ledgerActionNotification("session_1", "intent-exclusive");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: ["phone-newer"],
      failed: [],
    });
    expect(olderPhone).toEqual([]);
    expect(newerPhone).toEqual([event]);
  });

  it("buffers a failed sole Ledger delivery for the next capable reconnect", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const replacementPhone: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
    await multiplexer.registerClient({
      clientId: "phone-failing",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: () => {
        throw new Error("phone socket failed");
      },
    });
    const event = ledgerActionNotification("session_1", "intent-recover");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: [],
      failed: [{ clientId: "phone-failing", message: "phone socket failed" }],
    });

    await multiplexer.registerClient({
      clientId: "phone-reconnected",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => replacementPhone.push(message),
    });
    expect(replacementPhone).toEqual([event]);

    const laterPhone: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "phone-later",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => laterPhone.push(message),
    });
    expect(laterPhone).toEqual([]);
  });

  it("replays a bounded Ledger action when a capable phone initializes later", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
    const event = ledgerActionNotification("session_1", "intent-replay");

    await expect(
      multiplexer.broadcastSessionEvent("session_1", event),
    ).resolves.toMatchObject({ deliveredClientIds: [] });
    await multiplexer.registerClient({
      clientId: "phone",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => phone.push(message),
    });

    expect(phone).toEqual([event]);
  });

  it("leases a buffered Ledger replay to only one concurrently initializing phone", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const firstPhone: JsonObject[] = [];
    const secondPhone: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
    const event = ledgerActionNotification("session_1", "intent-replay-lease");
    await multiplexer.broadcastSessionEvent("session_1", event);

    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRegistration = multiplexer.registerClient({
      clientId: "phone-replay-first",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: async (message) => {
        firstPhone.push(message);
        markFirstStarted();
        await firstMayFinish;
      },
    });
    await firstStarted;

    await multiplexer.registerClient({
      clientId: "phone-replay-second",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => secondPhone.push(message),
    });
    expect(firstPhone).toEqual([event]);
    expect(secondPhone).toEqual([]);

    releaseFirst();
    await firstRegistration;
    const laterPhone: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "phone-replay-later",
      capabilities: { "portal.ledger.solana.sign.v1": true },
      send: (message) => laterPhone.push(message),
    });
    expect(laterPhone).toEqual([]);
  });

  it("pushes agent status to an opted-in mobile client without session attachment", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const phone: JsonObject[] = [];
    await sessionManager.createSession({ agentId: "agent_1" });
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
    await sessionManager.createSession({ agentId: "agent_1" });
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
    await sessionManager.createSession({ agentId: "agent_1" });
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
    await sessionManager.createSession({ agentId: "agent_1" });
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
    await sessionManager.createSession({ agentId: "agent_1" });
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

  it("detaches by params while preserving attachmentId precedence", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const client2Messages: JsonObject[] = [];

    await sessionManager.createSession({ agentId: "agent_1" });
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

    await sessionManager.createSession({ agentId: "agent_1" });
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

  it("buffers daemon session events emitted before the first client attaches", async () => {
    const { sessionManager, multiplexer } = createHarness();
    const received: JsonObject[] = [];

    await sessionManager.createSession({ agentId: "agent_1" });
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

    await sessionManager.createSession({ agentId: "agent_1" });
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

function ledgerActionNotification(
  sessionId: string,
  intentId: string,
): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.user_input_request",
    params: {
      sessionId,
      eventId: `event-${intentId}`,
      requestId: `request-${intentId}`,
      callId: `call-${intentId}`,
      turnId: "turn-1",
      questions: [],
      clientAction: {
        type: "ledger_solana_transfer_v1",
        source: "agenc-core",
        targetCapability: "portal.ledger.solana.sign.v1",
        network: "mainnet-beta",
        intentId,
        responseNonce: `response-nonce-${intentId}`,
        to: "11111111111111111111111111111111",
        lamports: "1",
        expiresAt: "2026-07-10T10:10:00.000Z",
      },
    },
  };
}

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
