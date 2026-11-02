import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
} from "./protocol/index.js";
import type {
  ElicitationPendingParams,
  ElicitationRespondParams,
} from "./protocol/index.js";

describe("daemon elicitation response dispatch", () => {
  it("routes elicitation.respond to the agent manager", async () => {
    const respondToElicitation = vi.fn(
      async (params: ElicitationRespondParams) => ({
        requestId: params.requestId,
        resolved: true,
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { respondToElicitation } as never,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocol: { version: "1.0.0" } },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "reply",
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "turn_1",
          kind: "request_user_input",
          response: {
            answers: { choice: { answers: ["Yes"] } },
          },
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "reply",
      result: { requestId: "turn_1", resolved: true },
    });
    expect(respondToElicitation).toHaveBeenCalledWith({
      sessionId: "session_1",
      requestId: "turn_1",
      kind: "request_user_input",
      response: {
        answers: { choice: { answers: ["Yes"] } },
      },
    });
  });

  it("routes elicitation.pending to the agent manager for a 1.36 client", async () => {
    const pendingElicitations = vi.fn(async (params: ElicitationPendingParams) => ({
      sessionId: params.sessionId,
      asOfSequence: 41,
      pending: [
        {
          eventId: "event:40",
          sequence: 40,
          kind: "mcp" as const,
          requestId: 7,
          serverName: "profile",
          turnId: "turn_1",
        },
      ],
    }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { respondToElicitation: vi.fn(), pendingElicitations } as never,
    });
    const connection = dispatcher.createConnection();
    const initialized = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocol: { version: "1.36.0" } },
    });
    expect(initialized).toMatchObject({
      result: {
        capabilities: {
          [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: expect.objectContaining({
            "elicitation.pending": true,
          }),
        },
      },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "pending",
        method: "elicitation.pending",
        params: { sessionId: "session_1" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "pending",
      result: {
        sessionId: "session_1",
        asOfSequence: 41,
        pending: [
          {
            eventId: "event:40",
            sequence: 40,
            kind: "mcp",
            requestId: 7,
            serverName: "profile",
            turnId: "turn_1",
          },
        ],
      },
    });
    expect(pendingElicitations).toHaveBeenCalledWith({ sessionId: "session_1" });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad",
        method: "elicitation.pending",
        params: { sessionId: "session_1", includeAnswered: true },
      }),
    ).resolves.toMatchObject({ id: "bad", error: expect.any(Object) });
  });

  it("validates MCP responses require serverName", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { respondToElicitation: vi.fn() } as never,
    });
    const connection = dispatcher.createConnection();
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: { protocol: { version: "1.0.0" } },
    });

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "reply",
        method: "elicitation.respond",
        params: {
          sessionId: "session_1",
          requestId: "mcp_1",
          kind: "mcp",
          response: { action: "accept", content: {} },
        },
      }),
    ).resolves.toMatchObject({
      error: {
        data: { code: "INVALID_ARGUMENT" },
      },
    });
  });
});
