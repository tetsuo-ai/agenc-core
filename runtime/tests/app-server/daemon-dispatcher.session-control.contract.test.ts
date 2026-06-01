import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import type {
  SessionApplyConfigParams,
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

  it("routes session.applyConfig to the agent manager", async () => {
    const applyConfigToSession = vi.fn(
      async (params: SessionApplyConfigParams) => ({
        sessionId: params.sessionId,
        applied: true,
        summary: "profile fast applied: reasoning effort ->high",
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { applyConfigToSession } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "apply-config",
        method: "session.applyConfig",
        params: { sessionId: "session_1", profile: "fast" },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "apply-config",
      result: {
        sessionId: "session_1",
        applied: true,
        summary: "profile fast applied: reasoning effort ->high",
      },
    });
    expect(applyConfigToSession).toHaveBeenCalledWith({
      sessionId: "session_1",
      profile: "fast",
    });
  });

  it("routes session.applyConfig with reload flag", async () => {
    const applyConfigToSession = vi.fn(
      async (params: SessionApplyConfigParams) => ({
        sessionId: params.sessionId,
        applied: true,
        summary: "config reload applied: config reloaded from disk",
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { applyConfigToSession } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "apply-reload",
      method: "session.applyConfig",
      params: { sessionId: "session_1", reload: true },
    });
    expect(applyConfigToSession).toHaveBeenCalledWith({
      sessionId: "session_1",
      reload: true,
    });
  });

  it("rejects session.applyConfig without a sessionId", async () => {
    const applyConfigToSession = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { applyConfigToSession } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-apply",
        method: "session.applyConfig",
        params: { profile: "fast" },
      }),
    ).resolves.toMatchObject({
      id: "bad-apply",
      error: { code: -32602 },
    });
    expect(applyConfigToSession).not.toHaveBeenCalled();
  });

  it("rejects session.applyConfig with a non-boolean reload", async () => {
    const applyConfigToSession = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { applyConfigToSession } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-reload",
        method: "session.applyConfig",
        params: { sessionId: "session_1", reload: "yes" },
      }),
    ).resolves.toMatchObject({
      id: "bad-reload",
      error: { code: -32602 },
    });
    expect(applyConfigToSession).not.toHaveBeenCalled();
  });
});
