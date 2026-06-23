import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../auth/backend.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

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

function request(
  id: string,
  method: string,
  params?: JsonObject,
): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

async function initialize(connection: {
  dispatch(message: JsonObject): Promise<JsonObject>;
}): Promise<void> {
  await expect(
    connection.dispatch(
      request("init", "initialize", { protocol: { version: "1.0.0" } }),
    ),
  ).resolves.toMatchObject({
    result: { type: "initialized", protocolVersion: "1.0.0" },
  });
}

function makeAuthBackend(): AuthBackend {
  return {
    login: () => ({ authenticated: true, provider: "local" }),
    whoami: () => ({ authenticated: true, provider: "local" }),
    logout: () => ({ authenticated: false }),
    vendKey: () => {
      throw new Error("not expected");
    },
    inferAgencModel: () => {
      throw new Error("not expected");
    },
    getSubscriptionTier: () => "free",
  };
}

function daemonMethodCapabilities(
  response: JsonObject,
): Record<string, boolean> {
  const result = response.result as { capabilities?: Record<string, unknown> };
  const capabilities = result.capabilities ?? {};
  return capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY] as Record<
    string,
    boolean
  >;
}

describe("AgenC daemon session lifecycle dispatcher", () => {
  it("advertises configured daemon method capabilities during initialize", async () => {
    const minimalDispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const minimalConnection = minimalDispatcher.createConnection();

    const minimalInitialize = await minimalConnection.dispatch(
      request("minimal-init", "initialize", {
        protocol: { version: "1.0.0" },
      }),
    );
    const minimalMethods = daemonMethodCapabilities(minimalInitialize);
    expect(minimalMethods).toMatchObject({
      initialize: true,
      "request.cancel": true,
      "commandExec.start": true,
      "health.ping": true,
      "session.create": false,
      "session.list": false,
      "session.attach": false,
      "session.detach": false,
      "session.terminate": false,
      "daemon.reload": false,
      "auth.login": false,
      "auth.whoami": false,
      "auth.logout": false,
    });

    const configuredDispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      authBackend: makeAuthBackend(),
      daemonControl: {
        reloadConfig: () => ({
          reloaded: true,
          configReloadedAt: "2026-05-01T09:00:00.000Z",
          mcpServer: { status: "disabled" },
        }),
      },
      initializeAuthenticator: () => true,
      sessionManager: new AgenCDaemonSessionManager(),
    });
    const configuredConnection = configuredDispatcher.createConnection();

    const configuredInitialize = await configuredConnection.dispatch(
      request("configured-init", "initialize", {
        protocol: { version: "1.0.0" },
        authCookie: "cookie",
      }),
    );
    const configuredMethods = daemonMethodCapabilities(configuredInitialize);
    expect(configuredMethods).toMatchObject({
      "session.create": true,
      "session.list": true,
      "session.attach": true,
      "session.detach": true,
      "session.terminate": true,
      "daemon.reload": true,
      "auth.login": true,
      "auth.whoami": true,
      "auth.logout": true,
    });
  });

  it("untrackClientId removes one co-located client without dropping the others", () => {
    // A single connection can track MULTIPLE clients (trackedClientIds is a set
    // keyed by the clientId a peer supplies). When one co-located client is
    // evicted as a slow consumer, the daemon must scope teardown to JUST that
    // client and only destroy the whole connection when the evicted client is
    // its SOLE tracked client. This is the per-connection seam that makes that
    // scoping correct: untrackClientId removes one client and reports whether
    // the connection still tracks any. Revert-sensitive — without it (or if the
    // daemon tore down the whole connection) the healthy co-located client would
    // be collaterally disconnected.
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();

    connection.trackClientId("client_a");
    connection.trackClientId("client_b");
    expect([...connection.trackedClientIds].sort()).toEqual([
      "client_a",
      "client_b",
    ]);

    // Untrack one of two co-located clients: NOT the sole client, the other
    // healthy client remains tracked (connection must be kept alive).
    expect(connection.untrackClientId("client_a")).toBe(false);
    expect([...connection.trackedClientIds]).toEqual(["client_b"]);

    // Untrack the last client: now sole — connection may be torn down.
    expect(connection.untrackClientId("client_b")).toBe(true);
    expect([...connection.trackedClientIds]).toEqual([]);

    // Untracking an unknown client is a no-op and reports the empty state.
    expect(connection.untrackClientId("client_x")).toBe(true);
  });

  it("scopes slow-consumer teardown to the evicted client and keeps the connection + co-located client alive", async () => {
    // Integration coverage for the EXACT regression site in daemon-cli's
    // destroyEvictedClientConnection wiring: when the multiplexer evicts ONE
    // slow consumer that shares a transport connection with a healthy co-located
    // client, only the evicted client must be torn down — the connection and the
    // healthy client must survive. This reconstructs that wiring faithfully:
    //   * a REAL multiplexer whose onClientEvicted drives a copy of daemon-cli's
    //     destroyEvictedClientConnection,
    //   * a REAL dispatcher connection that tracks BOTH clientIds via the genuine
    //     trackClientId/untrackClientId/trackedClientIds API,
    //   * eviction triggered by a REAL broadcastSessionEvent against a stuck slow
    //     consumer (its send never settles), with an independent healthy client.
    // The scoping decision flows multiplexer eviction -> onClientEvicted ->
    // destroyEvictedClientConnection -> connection.untrackClientId. It is
    // revert-sensitive to untrackClientId's `size === 0` return: if that returns
    // true unconditionally (v1's whole-connection teardown) the connection is
    // closed and the healthy co-located client is collaterally removed.
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: () => "session_1",
    });

    // Reconstruct daemon-cli's connection registry + teardown seam.
    const connections = new Map<string, AgenCDaemonJsonRpcConnection>();
    const closedConnectionKeys: string[] = [];
    let destroyEvictedClientConnection:
      | ((clientId: string) => void)
      | undefined;

    const multiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager,
      // Small live pending caps so a couple of ~1KB events trip the slow
      // consumer; the detached-buffer cap stays generous and irrelevant here.
      maxBufferedBytesPerSession: 8 * 1024 * 1024,
      maxPendingDeliveryBytesPerClient: 2 * 1024,
      maxPendingDeliveryCountPerClient: 1000,
      onClientEvicted: (clientId) => {
        destroyEvictedClientConnection?.(clientId);
      },
    });

    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      clientMultiplexer: multiplexer,
      sessionManager,
    });

    const closeConnection = (connectionKey: string): void => {
      const connection = connections.get(connectionKey);
      connections.delete(connectionKey);
      closedConnectionKeys.push(connectionKey);
      for (const clientId of connection?.trackedClientIds ?? []) {
        void multiplexer.removeClient(clientId).catch(() => {});
      }
    };
    // Byte-for-byte the daemon-cli scoping decision under test.
    destroyEvictedClientConnection = (clientId: string): void => {
      for (const [connectionKey, connection] of connections) {
        if (!connection.trackedClientIds.includes(clientId)) {
          continue;
        }
        const wasSoleClient = connection.untrackClientId(clientId);
        if (wasSoleClient) {
          closeConnection(connectionKey);
        }
        return;
      }
    };

    // ONE transport connection carrying TWO co-located tracked clients. Each
    // clientId is a distinct multiplexer client with its OWN send closure, so
    // their pending-backlog accounting is independent (the slow one stalls, the
    // healthy one drains).
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    connections.set("conn_1", connection);
    await sessionManager.createSession({ agentId: "agent_1" });

    let slowSendCount = 0;
    await multiplexer.registerClient({
      clientId: "slow_client",
      send: () => {
        slowSendCount += 1;
        return new Promise<void>(() => {
          /* never resolves: backpressured/stuck socket */
        });
      },
    });
    await multiplexer.attachClientToSession("session_1", "slow_client");
    connection.trackClientId("slow_client");

    const healthyReceived: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "healthy_client",
      send: (message) => {
        healthyReceived.push(message);
        return Promise.resolve();
      },
    });
    await multiplexer.attachClientToSession("session_1", "healthy_client");
    connection.trackClientId("healthy_client");

    expect([...connection.trackedClientIds].sort()).toEqual([
      "healthy_client",
      "slow_client",
    ]);

    // Drive large events: the slow client's first delivery never settles so its
    // pending backlog climbs past the 2KB cap and the multiplexer evicts it,
    // firing onClientEvicted -> destroyEvictedClientConnection. Yield between
    // broadcasts so the healthy client's deliveries drain.
    for (let i = 1; i <= 50; i += 1) {
      void multiplexer.broadcastSessionEvent("session_1", {
        type: "session.delta",
        sessionId: "session_1",
        sequence: i,
        text: "x".repeat(1000),
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));

    // The slow client was evicted from the multiplexer route AND untracked from
    // the connection — but the connection itself was NOT closed.
    expect(slowSendCount).toBeGreaterThan(0);
    expect(closedConnectionKeys).toEqual([]);
    expect(connections.has("conn_1")).toBe(true);
    expect([...connection.trackedClientIds]).toEqual(["healthy_client"]);

    const attached = await multiplexer.attachedClientIds("session_1");
    expect(attached).toEqual(["healthy_client"]);

    // The healthy co-located client SURVIVED: still registered, still attached,
    // and still receiving broadcasts after the slow client was torn down.
    healthyReceived.length = 0;
    await multiplexer.broadcastSessionEvent("session_1", {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1000,
      text: "post-eviction",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(healthyReceived).toEqual([
      {
        type: "session.delta",
        sessionId: "session_1",
        sequence: 1000,
        text: "post-eviction",
      },
    ]);
  });

  it("requires initialization before daemon.reload", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      initializeAuthenticator: () => true,
      daemonControl: {
        reloadConfig: () => ({
          reloaded: true,
          configReloadedAt: "2026-05-01T09:00:00.000Z",
          mcpServer: { status: "disabled" },
        }),
      },
    });
    const connection = dispatcher.createConnection();

    await expect(
      connection.dispatch(request("reload", "daemon.reload")),
    ).resolves.toMatchObject({
      error: { data: { code: "CONNECTION_NOT_INITIALIZED" } },
    });
  });

  it("routes daemon.reload through authenticated daemon control", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      initializeAuthenticator: (params) => params.authCookie === "cookie",
      daemonControl: {
        reloadConfig: () => ({
          reloaded: true,
          configReloadedAt: "2026-05-01T09:00:00.000Z",
          mcpServer: {
            status: "listening",
            url: "http://127.0.0.1:4567/mcp",
          },
        }),
      },
    });
    const connection = dispatcher.createConnection();
    await expect(
      connection.dispatch(
        request("init", "initialize", {
          protocol: { version: "1.0.0" },
          authCookie: "cookie",
        }),
      ),
    ).resolves.toMatchObject({
      result: { type: "initialized", protocolVersion: "1.0.0" },
    });

    await expect(
      connection.dispatch(request("reload", "daemon.reload")),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "reload",
      result: {
        reloaded: true,
        configReloadedAt: "2026-05-01T09:00:00.000Z",
        mcpServer: {
          status: "listening",
          url: "http://127.0.0.1:4567/mcp",
        },
      },
    });
  });

  it("rejects daemon.reload when daemon control lacks an authenticated transport", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      daemonControl: {
        reloadConfig: () => ({
          reloaded: true,
          configReloadedAt: "2026-05-01T09:00:00.000Z",
          mcpServer: { status: "disabled" },
        }),
      },
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(request("reload", "daemon.reload")),
    ).resolves.toMatchObject({
      error: { data: { code: "DAEMON_RELOAD_AUTHENTICATION_REQUIRED" } },
    });
  });

  it("reports daemon.reload as unimplemented without daemon control", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      initializeAuthenticator: () => true,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(request("reload", "daemon.reload")),
    ).resolves.toMatchObject({
      error: { code: -32601 },
    });
  });

  it("routes session.create through a minimal initialized dispatcher", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_default"]),
      now: sequence(["2026-05-01T09:00:00.000Z"]),
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(request("create-default", "session.create")),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "create-default",
      result: {
        sessionId: "session_default",
        agentId: "agent_default",
        status: "idle",
        createdAt: "2026-05-01T09:00:00.000Z",
      },
    });
  });

  it("routes create, attach, detach, and terminate while reconciling multiplexer routes", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
        "2026-05-01T10:00:03.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      clientMultiplexer,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("create", "session.create", {
          agentId: "agent_1",
          cwd: "/workspace/project",
          initialPrompt: "inspect",
          metadata: { source: "dispatcher-test" },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_1",
        agentId: "agent_1",
        cwd: "/workspace/project",
        metadata: { source: "dispatcher-test" },
      },
    });
    await expect(
      connection.dispatch(
        request("attach-one", "session.attach", {
          sessionId: "session_1",
          clientId: "client_1",
        }),
      ),
    ).resolves.toMatchObject({
      result: { attachmentId: "attachment_1", clientId: "client_1" },
    });
    await expect(clientMultiplexer.attachedClientIds("session_1")).resolves.toEqual(
      ["client_1"],
    );

    await expect(
      connection.dispatch(
        request("detach-one", "session.detach", {
          sessionId: "session_1",
          clientId: "client_1",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "detach-one",
      result: {
        sessionId: "session_1",
        attachmentId: "attachment_1",
        detached: true,
        remainingAttachmentIds: [],
      },
    });
    await expect(clientMultiplexer.attachedClientIds("session_1")).resolves.toEqual(
      [],
    );

    await connection.dispatch(
      request("attach-two", "session.attach", {
        sessionId: "session_1",
        clientId: "client_2",
      }),
    );
    await expect(
      connection.dispatch(
        request("terminate", "session.terminate", {
          sessionId: "session_1",
          reason: "done",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "terminate",
      result: {
        sessionId: "session_1",
        terminated: true,
        status: "closed",
        closedAt: "2026-05-01T10:00:03.000Z",
        reason: "done",
      },
    });
    await expect(clientMultiplexer.attachedClientIds("session_1")).resolves.toEqual(
      [],
    );
    await expect(sessions.getSession("session_1")).resolves.not.toHaveProperty(
      "activeAttachmentIds",
    );
    await expect(clientMultiplexer.removeClient("client_2")).resolves.toEqual([]);
    await expect(
      connection.dispatch(
        request("terminate-again", "session.terminate", {
          sessionId: "session_1",
        }),
      ),
    ).resolves.toMatchObject({
      result: { sessionId: "session_1", terminated: false, status: "closed" },
    });
  });

  it("falls back to SessionManager for detach and terminate without a multiplexer", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T11:00:00.000Z",
        "2026-05-01T11:00:01.000Z",
        "2026-05-01T11:00:02.000Z",
        "2026-05-01T11:00:03.000Z",
      ]),
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await connection.dispatch(request("create", "session.create", {}));
    await connection.dispatch(
      request("attach", "session.attach", {
        sessionId: "session_1",
        clientId: "direct_client",
      }),
    );
    await expect(
      connection.dispatch(
        request("detach", "session.detach", {
          sessionId: "session_1",
          clientId: "direct_client",
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_1",
        attachmentId: "attachment_1",
        detached: true,
        remainingAttachmentIds: [],
      },
    });

    await connection.dispatch(
      request("reattach", "session.attach", {
        sessionId: "session_1",
        clientId: "direct_client",
      }),
    );
    await expect(
      connection.dispatch(
        request("terminate", "session.terminate", {
          sessionId: "session_1",
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_1",
        terminated: true,
        status: "closed",
        closedAt: "2026-05-01T11:00:03.000Z",
      },
    });
  });

  it("cleans mux routes by attachmentId and preserves attachmentId precedence", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T12:00:00.000Z",
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const deliveredToClient2: JsonObject[] = [];
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      clientMultiplexer,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection({
      sendNotification: (message) => deliveredToClient2.push(message),
    });
    await initialize(connection);

    await connection.dispatch(request("create", "session.create", {}));
    await connection.dispatch(
      request("attach-one", "session.attach", {
        sessionId: "session_1",
        clientId: "client_1",
      }),
    );
    await connection.dispatch(
      request("attach-two", "session.attach", {
        sessionId: "session_1",
        clientId: "client_2",
      }),
    );

    await expect(
      connection.dispatch(
        request("detach-conflict", "session.detach", {
          sessionId: "session_1",
          attachmentId: "attachment_1",
          clientId: "client_2",
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        sessionId: "session_1",
        attachmentId: "attachment_1",
        detached: true,
        remainingAttachmentIds: ["attachment_2"],
      },
    });
    await expect(clientMultiplexer.attachedClientIds("session_1")).resolves.toEqual(
      ["client_2"],
    );
    await expect(clientMultiplexer.removeClient("client_1")).resolves.toEqual([]);
    await clientMultiplexer.broadcastSessionEvent("session_1", {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
      clientId: "client_2",
    });
    expect(deliveredToClient2).toEqual([
      {
        type: "session.delta",
        sessionId: "session_1",
        sequence: 1,
        clientId: "client_2",
      },
    ]);
  });

  it("routes session.mcp.addServer through the active daemon agent runtime", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_mcp",
      agentId: "agent_mcp",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "use MCP",
    });
    const addMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 1,
    }));
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        addMcpServer,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_mcp",
      objective: "use MCP",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_mcp"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("add-mcp", "session.mcp.addServer", {
          sessionId: "session_mcp",
          config: {
            name: "audit-ping",
            transport: "stdio",
            command: "node",
            args: [".agenc/mcp/audit-ping.mjs"],
            enabled: true,
          },
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "add-mcp",
      result: {
        sessionId: "session_mcp",
        serverName: "audit-ping",
        success: true,
        toolCount: 1,
      },
    });
    expect(addMcpServer).toHaveBeenCalledWith("agent_mcp", {
      sessionId: "session_mcp",
      config: {
        name: "audit-ping",
        transport: "stdio",
        command: "node",
        args: [".agenc/mcp/audit-ping.mjs"],
        enabled: true,
      },
    });
  });

  it("routes session.mcp.reconnect/enable/disable through the active daemon agent runtime", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({
      sessionId: "session_mcp",
      agentId: "agent_mcp",
      status: "waiting",
      createdAt: "2026-05-01T12:00:00.000Z",
      initialPrompt: "use MCP",
    });
    const reconnectMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 3,
    }));
    const enableMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 3,
    }));
    const disableMcpServer = vi.fn(async () => ({
      serverName: "audit-ping",
      success: true,
      toolCount: 0,
    }));
    const agentManager = new AgenCDaemonAgentManager({
      sessionManager: sessions,
      runner: {
        startAgent: async () => ({
          agentId: "unused",
          startedAt: "2026-05-01T12:00:00.000Z",
          status: "running",
        }),
        reconnectMcpServer,
        enableMcpServer,
        disableMcpServer,
      },
    });
    await agentManager.restoreAgent({
      agentId: "agent_mcp",
      objective: "use MCP",
      startedAt: "2026-05-01T12:00:00.000Z",
      lastActiveAt: "2026-05-01T12:05:00.000Z",
      sessionIds: ["session_mcp"],
      runtimeAvailable: true,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("reconnect-mcp", "session.mcp.reconnectServer", {
          sessionId: "session_mcp",
          serverName: "audit-ping",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "reconnect-mcp",
      result: {
        sessionId: "session_mcp",
        serverName: "audit-ping",
        success: true,
        toolCount: 3,
      },
    });
    expect(reconnectMcpServer).toHaveBeenCalledWith("agent_mcp", {
      sessionId: "session_mcp",
      serverName: "audit-ping",
    });

    await expect(
      connection.dispatch(
        request("enable-mcp", "session.mcp.enableServer", {
          sessionId: "session_mcp",
          serverName: "audit-ping",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "enable-mcp",
      result: {
        sessionId: "session_mcp",
        serverName: "audit-ping",
        success: true,
        toolCount: 3,
      },
    });
    expect(enableMcpServer).toHaveBeenCalledWith("agent_mcp", {
      sessionId: "session_mcp",
      serverName: "audit-ping",
    });

    await expect(
      connection.dispatch(
        request("disable-mcp", "session.mcp.disableServer", {
          sessionId: "session_mcp",
          serverName: "audit-ping",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "disable-mcp",
      result: {
        sessionId: "session_mcp",
        serverName: "audit-ping",
        success: true,
        toolCount: 0,
      },
    });
    expect(disableMcpServer).toHaveBeenCalledWith("agent_mcp", {
      sessionId: "session_mcp",
      serverName: "audit-ping",
    });
  });

  it("rejects session.mcp.reconnectServer when serverName is missing", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({ sessionManager: sessions }),
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    const response = await connection.dispatch(
      request("bad-reconnect", "session.mcp.reconnectServer", {
        sessionId: "session_mcp",
      }),
    );
    expect(response).toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "bad-reconnect",
      error: expect.objectContaining({
        message: expect.stringContaining("serverName"),
      }),
    });
  });

  it("preserves unrelated routes when detach targets an unowned client on another session", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T13:00:00.000Z",
        "2026-05-01T13:00:01.000Z",
        "2026-05-01T13:00:02.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      clientMultiplexer,
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(connection);

    await connection.dispatch(request("create-one", "session.create", {}));
    await connection.dispatch(request("create-two", "session.create", {}));
    await connection.dispatch(
      request("attach-one", "session.attach", {
        sessionId: "session_1",
        clientId: "client_1",
      }),
    );

    await expect(
      connection.dispatch(
        request("detach-wrong-session", "session.detach", {
          sessionId: "session_2",
          clientId: "client_1",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "detach-wrong-session",
      result: {
        sessionId: "session_2",
        detached: false,
        remainingAttachmentIds: [],
      },
    });
    await expect(clientMultiplexer.attachedClientIds("session_1")).resolves.toEqual(
      ["client_1"],
    );
  });

  it("validates newly routed session lifecycle params", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("bad-create-extra", "session.create", { unknown: true }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.create does not accept param 'unknown'",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-create-metadata", "session.create", {
          metadata: [] as unknown as JsonObject,
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.create param 'metadata' must be an object",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-detach-missing-target", "session.detach", {
          sessionId: "session_1",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.detach requires attachmentId or clientId",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-detach-empty-target", "session.detach", {
          sessionId: "session_1",
          attachmentId: "attachment_1",
          clientId: "",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.detach param 'clientId' must be non-empty",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-detach-extra", "session.detach", {
          sessionId: "session_1",
          clientId: "client_1",
          extra: true,
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.detach does not accept param 'extra'",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-terminate-session", "session.terminate", {
          reason: "done",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.terminate requires sessionId",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-mcp-missing-config", "session.mcp.addServer", {
          sessionId: "session_1",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "session.mcp.addServer requires config",
      },
    });
    await expect(
      connection.dispatch(
        request("bad-mcp-transport", "session.mcp.addServer", {
          sessionId: "session_1",
          config: {
            name: "audit-ping",
            transport: "ftp",
          },
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message:
          "session.mcp.addServer.config transport must be stdio, sse, http, websocket, or ws",
      },
    });
  });

  it("reports missing SessionManager before validating new session methods", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    for (const method of [
      "session.create",
      "session.list",
      "session.attach",
      "session.detach",
      "session.terminate",
    ]) {
      await expect(
        connection.dispatch(request(method, method, { invalid: true })),
      ).resolves.toEqual({
        jsonrpc: JSON_RPC_VERSION,
        id: method,
        error: {
          code: -32601,
          message: `daemon method is not implemented yet: ${method}`,
        },
      });
    }
  });

  it("reports missing optional permission surface before validating params", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("permission-list", "permission.list", {
          agentId: "agent_1",
          sessionId: "session_1",
        }),
      ),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "permission-list",
      error: {
        code: -32601,
        message: "daemon method is not implemented yet: permission.list",
      },
    });
  });

  it("maps session lifecycle errors to invalid params instead of internal errors", async () => {
    const sessions = new AgenCDaemonSessionManager();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      sessionManager: sessions,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch(
        request("attach-missing", "session.attach", {
          sessionId: "session_missing",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        data: { code: "SESSION_NOT_FOUND" },
      },
    });
    await expect(
      connection.dispatch(
        request("terminate-missing", "session.terminate", {
          sessionId: "session_missing",
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        data: { code: "SESSION_NOT_FOUND" },
      },
    });
  });
});
