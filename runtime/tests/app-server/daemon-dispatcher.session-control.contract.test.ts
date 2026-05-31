import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import type {
  SessionSetModelParams,
  SessionSetPermissionModeParams,
} from "./protocol/index.js";

async function initialize(connection: {
  dispatch(message: Record<string, unknown>): Promise<unknown>;
}): Promise<void> {
  await connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: "init",
    method: "initialize",
    params: { protocol: { version: "1.0.0" } },
  });
}

describe("daemon session-control internal method dispatch", () => {
  it("routes session.setModel to the agent manager", async () => {
    const setSessionModel = vi.fn(async (params: SessionSetModelParams) => ({
      sessionId: params.sessionId,
      applied: true,
      summary: "Model switched.",
    }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionModel } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "set-model",
        method: "session.setModel",
        params: {
          sessionId: "session_1",
          model: "gpt-x",
          provider: "openai",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "set-model",
      result: {
        sessionId: "session_1",
        applied: true,
        summary: "Model switched.",
      },
    });
    expect(setSessionModel).toHaveBeenCalledWith({
      sessionId: "session_1",
      model: "gpt-x",
      provider: "openai",
    });
  });

  it("rejects session.setModel without model or provider", async () => {
    const setSessionModel = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionModel } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-model",
        method: "session.setModel",
        params: { sessionId: "session_1" },
      }),
    ).resolves.toMatchObject({
      id: "bad-model",
      error: { code: -32602 },
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("routes session.setPermissionMode to the agent manager", async () => {
    const setSessionPermissionMode = vi.fn(
      async (params: SessionSetPermissionModeParams) => ({
        sessionId: params.sessionId,
        applied: true,
        previousMode: "default",
        mode: params.mode,
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionPermissionMode } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "set-mode",
        method: "session.setPermissionMode",
        params: { sessionId: "session_1", mode: "plan" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "set-mode",
      result: {
        sessionId: "session_1",
        applied: true,
        previousMode: "default",
        mode: "plan",
      },
    });
    expect(setSessionPermissionMode).toHaveBeenCalledWith({
      sessionId: "session_1",
      mode: "plan",
    });
  });

  it("rejects session.setPermissionMode without a mode", async () => {
    const setSessionPermissionMode = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionPermissionMode } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-mode",
        method: "session.setPermissionMode",
        params: { sessionId: "session_1" },
      }),
    ).resolves.toMatchObject({
      id: "bad-mode",
      error: { code: -32602 },
    });
    expect(setSessionPermissionMode).not.toHaveBeenCalled();
  });
});
