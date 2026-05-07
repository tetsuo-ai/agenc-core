import { describe, expect, it } from "vitest";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";
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

describe("AgenC daemon session lifecycle dispatcher", () => {
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
  });

  it("reports missing SessionManager before validating new session methods", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    for (const method of [
      "session.create",
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
