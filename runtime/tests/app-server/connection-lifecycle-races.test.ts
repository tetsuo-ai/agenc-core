import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlledPromise, settleWithinMicrotasks } from "../helpers/controlled-async.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

const dispatchers: AgenCDaemonJsonRpcDispatcher[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
});

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocol: { version: "1.9.0" }, ...params } : params };
}

function harness(
  initializeAuthenticator?: () => Promise<boolean>,
  runner?: AgenCBackgroundAgentRunner,
) {
  const sessions = new AgenCDaemonSessionManager();
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const agentManager = new AgenCDaemonAgentManager({ sessionManager: sessions, runner });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager,
    sessionManager: sessions,
    clientMultiplexer: multiplexer,
    initializeAuthenticator,
  });
  dispatchers.push(dispatcher);
  const connection = dispatcher.createConnection({ sendNotification: () => {} });
  return { sessions, multiplexer, dispatcher, connection, agentManager };
}

describe("daemon connection lifecycle races", () => {
  it("does not initialize or register a capability client after close during authentication", async () => {
    const authenticated = createControlledPromise<boolean>();
    const entered = createControlledPromise<void>();
    const h = harness(() => { entered.resolve(); return authenticated.promise; });
    const register = vi.spyOn(h.multiplexer, "registerClient");
    const initializing = h.connection.dispatch(request("init", "initialize", {
      capabilities: { "portal.ledger.solana.sign.v1": true },
    }));
    await entered.promise;
    await h.dispatcher.closeConnection(h.connection);
    authenticated.resolve(true);
    await expect(initializing).resolves.toMatchObject({ error: { data: { code: "CONNECTION_CLOSED" } } });
    expect(h.connection.initialized).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("admits only one initialize handshake while authentication is pending", async () => {
    const authenticated = createControlledPromise<boolean>();
    const entered = createControlledPromise<void>();
    const authenticate = vi.fn(() => { entered.resolve(); return authenticated.promise; });
    const h = harness(authenticate);
    const first = h.connection.dispatch(request("first", "initialize"));
    await entered.promise;
    const second = h.connection.dispatch(request("second", "initialize"));
    const outcome = await settleWithinMicrotasks(second);
    expect(outcome).toMatchObject({ status: "fulfilled", value: { error: { data: { code: "CONNECTION_ALREADY_INITIALIZED" } } } });
    authenticated.resolve(true);
    await expect(first).resolves.toHaveProperty("result");
    expect(authenticate).toHaveBeenCalledTimes(1);
    await h.connection.close();
  });

  it("rolls back registration that completes after its connection closes", async () => {
    const h = harness();
    await h.connection.dispatch(request("init", "initialize"));
    const session = await h.sessions.createSession({ cwd: process.cwd() });
    const registered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const original = h.multiplexer.registerClient.bind(h.multiplexer);
    vi.spyOn(h.multiplexer, "registerClient").mockImplementation(async (options) => {
      const result = await original(options);
      registered.resolve();
      await release.promise;
      return result;
    });
    const attaching = h.connection.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "late-client",
    }));
    await registered.promise;
    await h.connection.close();
    expect(h.connection.trackedClientIds).toEqual([]);
    await expect(h.multiplexer.removeClient("late-client")).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    release.resolve();
    await expect(attaching).resolves.toMatchObject({ error: { data: { code: "CONNECTION_CLOSED" } } });
    expect(h.connection.trackedClientIds).toEqual([]);
    await expect(h.multiplexer.attachedClientIds(session.sessionId)).resolves.toEqual([]);
    await expect(h.multiplexer.removeClient("late-client")).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
  });

  it("does not remove a reconnect's reused client id when an old attach unwinds", async () => {
    const h = harness();
    await h.connection.dispatch(request("init", "initialize"));
    const session = await h.sessions.createSession({ cwd: process.cwd() });
    const registered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const original = h.multiplexer.registerClient.bind(h.multiplexer);
    vi.spyOn(h.multiplexer, "registerClient").mockImplementationOnce(async (options) => {
      const result = await original(options);
      registered.resolve();
      await release.promise;
      return result;
    });
    const attaching = h.connection.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "reused-client",
    }));
    await registered.promise;
    await h.connection.close();
    const reconnect = h.dispatcher.createConnection({ sendNotification: () => {} });
    await reconnect.dispatch(request("init", "initialize"));
    await expect(reconnect.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "reused-client",
    }))).resolves.toHaveProperty("result");
    release.resolve();
    await expect(attaching).resolves.toHaveProperty("error");
    await expect(h.multiplexer.attachedClientIds(session.sessionId)).resolves.toEqual(["reused-client"]);
    await reconnect.close();
  });

  it("rejects new work after close and coalesces concurrent cleanup", async () => {
    const h = harness();
    await h.connection.dispatch(request("init", "initialize"));
    const session = await h.sessions.createSession({ cwd: process.cwd() });
    await h.connection.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "client",
    }));
    const remove = vi.spyOn(h.multiplexer, "removeClient");
    const create = vi.spyOn(h.sessions, "createSession");
    await Promise.all([h.connection.close(), h.dispatcher.closeConnection(h.connection)]);
    await expect(h.connection.dispatch(request("late", "session.create", { cwd: process.cwd() })))
      .resolves.toMatchObject({ error: { data: { code: "CONNECTION_CLOSED" } } });
    expect(create).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(h.connection.trackedClientIds).toEqual([]);
  });

  it("does not detach a reconnect when a previously tracked agent attachment rolls back", async () => {
    const entered = createControlledPromise<void>();
    const release = Promise.withResolvers<void>();
    const snapshot = { status: "running" as const, lastActiveAt: "2026-05-01T12:00:00.000Z" };
    const getAgentSnapshot = vi.fn(async () => snapshot);
    const h = harness(undefined, {
      startAgent: async () => ({ agentId: "agent-rollback", status: "running", startedAt: snapshot.lastActiveAt }),
      getAgentSnapshot,
    });
    await h.connection.dispatch(request("init", "initialize"));
    const created = await h.agentManager.createAgent({
      cwd: process.cwd(), objective: "verify attachment rollback ownership",
      runtimeOptions: resolveAgentRuntimeOptions({}),
    });
    const sessionId = created.sessionId!;
    await expect(h.connection.dispatch(request("first-attach", "session.attach", {
      sessionId, clientId: "reused-client",
    }))).resolves.toHaveProperty("result");
    getAgentSnapshot
      .mockImplementationOnce(async () => snapshot)
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("runtime snapshot failed after disconnect");
      });
    const attaching = h.connection.dispatch(request("agent-attach", "agent.attach", {
      agentId: created.agentId, clientId: "reused-client",
    }));
    await entered.promise;
    await h.connection.close();
    const reconnect = h.dispatcher.createConnection({ sendNotification: () => {} });
    try {
      await reconnect.dispatch(request("init", "initialize"));
      await expect(reconnect.dispatch(request("reconnect-attach", "session.attach", {
        sessionId, clientId: "reused-client",
      }))).resolves.toHaveProperty("result");
      release.resolve();
      await expect(attaching).resolves.toHaveProperty("error");
      await expect(h.multiplexer.attachedClientIds(sessionId)).resolves.toEqual(["reused-client"]);
      expect((await h.sessions.getSession(sessionId))?.activeAttachmentIds).toHaveLength(1);
    } finally {
      release.resolve();
      await attaching;
      await reconnect.close();
    }
  });

  it("keeps delayed eviction bound to the original physical connection", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const evicted = vi.fn();
    const multiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions, maxPendingDeliveryBytesPerClient: 64,
      onClientEvicted: evicted,
    });
    const session = await sessions.createSession({ cwd: process.cwd() });
    await multiplexer.registerClient({ clientId: "reused-client", deliveryKey: "old-connection", send: () => {} });
    await multiplexer.attachClientToSession(session.sessionId, "reused-client");
    const entered = createControlledPromise<void>();
    const release = Promise.withResolvers<void>();
    const disconnect = multiplexer.disconnectClient.bind(multiplexer);
    vi.spyOn(multiplexer, "disconnectClient").mockImplementationOnce(async (clientId, deliveryKey) => {
      entered.resolve();
      await release.promise;
      return disconnect(clientId, deliveryKey);
    });
    const broadcast = multiplexer.broadcastSessionEvent(session.sessionId, { text: "x".repeat(128) });
    await entered.promise;
    try {
      await disconnect("reused-client", "old-connection");
      await multiplexer.registerClient({ clientId: "reused-client", deliveryKey: "new-connection", send: () => {} });
      await multiplexer.attachClientToSession(session.sessionId, "reused-client");
      release.resolve();
      await broadcast;
      await expect(multiplexer.attachedClientIds(session.sessionId)).resolves.toEqual(["reused-client"]);
      expect(evicted).toHaveBeenCalledExactlyOnceWith("reused-client", "old-connection");
    } finally {
      release.resolve();
      await broadcast;
      await multiplexer.removeClient("reused-client").catch(() => {});
    }
  });
});

describe("session termination routing", () => {
  it("allows finalizers to use routing without blocking all daemon clients", async () => {
    let multiplexer: AgenCDaemonClientMultiplexer;
    const sessions = new AgenCDaemonSessionManager({
      onSessionTerminated: async (sessionId) => {
        await multiplexer.broadcastSessionEvent(sessionId, {
          jsonrpc: "2.0", method: "event.closed", params: { sessionId },
        });
      },
    });
    multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
    const session = await sessions.createSession({ cwd: process.cwd() });
    await multiplexer.registerClient({ clientId: "client", send: () => {} });
    await multiplexer.attachClientToSession(session.sessionId, "client");
    const result = await settleWithinMicrotasks(multiplexer.terminateSession({ sessionId: session.sessionId }));
    expect(result).toMatchObject({ status: "fulfilled", value: { terminated: true } });
    await expect(multiplexer.attachedClientIds(session.sessionId)).resolves.toEqual([]);
  });
});
