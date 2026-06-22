import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import type {
  SessionHooksSetDisabledParams,
  SessionHooksStatusParams,
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

describe("daemon session.hooks.* internal method dispatch", () => {
  it("routes session.hooks.status to the agent manager", async () => {
    const getSessionHooksStatus = vi.fn(
      async (params: SessionHooksStatusParams) => ({
        sessionId: params.sessionId,
        available: true,
        sourcePath: "/home/agent/.agenc/config.toml",
        disabled: false,
        issues: [],
        hooks: [
          {
            event: "PreToolUse",
            command: { type: "command", command: "echo hi" },
            source: "config",
            sourcePath: "/home/agent/.agenc/config.toml",
            enabled: true,
            index: 0,
          },
        ],
        diagnostics: [],
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { getSessionHooksStatus } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "hooks-status",
        method: "session.hooks.status",
        params: { sessionId: "session_1" },
      }),
    ).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: "hooks-status",
      result: {
        sessionId: "session_1",
        available: true,
        hooks: [{ event: "PreToolUse", index: 0 }],
      },
    });
    expect(getSessionHooksStatus).toHaveBeenCalledWith({
      sessionId: "session_1",
    });
  });

  it("rejects session.hooks.status without a sessionId", async () => {
    const getSessionHooksStatus = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { getSessionHooksStatus } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-status",
        method: "session.hooks.status",
        params: {},
      }),
    ).resolves.toMatchObject({
      id: "bad-status",
      error: { code: -32602 },
    });
    expect(getSessionHooksStatus).not.toHaveBeenCalled();
  });

  it("routes session.hooks.setDisabled to the agent manager", async () => {
    const setSessionHooksDisabled = vi.fn(
      async (params: SessionHooksSetDisabledParams) => ({
        sessionId: params.sessionId,
        applied: true,
        disabled: params.disabled,
      }),
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionHooksDisabled } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "hooks-disable",
        method: "session.hooks.setDisabled",
        params: { sessionId: "session_1", disabled: true },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "hooks-disable",
      result: { sessionId: "session_1", applied: true, disabled: true },
    });
    expect(setSessionHooksDisabled).toHaveBeenCalledWith({
      sessionId: "session_1",
      disabled: true,
    });
  });

  it("rejects session.hooks.setDisabled with a non-boolean disabled", async () => {
    const setSessionHooksDisabled = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionHooksDisabled } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "bad-disable",
        method: "session.hooks.setDisabled",
        params: { sessionId: "session_1", disabled: "yes" },
      }),
    ).resolves.toMatchObject({
      id: "bad-disable",
      error: { code: -32602 },
    });
    expect(setSessionHooksDisabled).not.toHaveBeenCalled();
  });

  it("rejects session.hooks.setDisabled without a sessionId", async () => {
    const setSessionHooksDisabled = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionHooksDisabled } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "no-session",
        method: "session.hooks.setDisabled",
        params: { disabled: true },
      }),
    ).resolves.toMatchObject({
      id: "no-session",
      error: { code: -32602 },
    });
    expect(setSessionHooksDisabled).not.toHaveBeenCalled();
  });

  it("reports missing optional hook surface before validating params", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {} as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    for (const method of [
      "session.hooks.status",
      "session.hooks.setDisabled",
    ]) {
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: method,
          method,
          params: {},
        }),
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
});
