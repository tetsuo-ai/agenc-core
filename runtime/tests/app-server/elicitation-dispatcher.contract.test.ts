import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import type { ElicitationRespondParams } from "./protocol/index.js";

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
