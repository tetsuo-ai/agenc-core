import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  MAX_SESSION_SHELL_COMMAND_UTF8_BYTES,
  MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES,
  MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES,
  type SessionShellExecuteParams,
  type SessionShellExecuteResult,
} from "./protocol/index.js";

async function initialize(
  connection: {
    dispatch(message: Record<string, unknown>): Promise<unknown>;
  },
  version: string,
): Promise<unknown> {
  return connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: `init-${version}`,
    method: "initialize",
    params: { protocol: { version } },
  });
}

const successResult: SessionShellExecuteResult = {
  commandId: "command_1",
  content: "ready\n",
  stdout: "ready\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  truncated: false,
  isError: false,
};

describe("daemon session.shell.execute internal method dispatch", () => {
  it("advertises and dispatches the method only for protocol 1.9", async () => {
    const executeSessionShell = vi.fn(
      async (
        _params: SessionShellExecuteParams,
        _signal: AbortSignal,
      ): Promise<SessionShellExecuteResult> => successResult,
    );
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { executeSessionShell } as never,
    });

    const oldConnection = dispatcher.createConnection();
    await expect(initialize(oldConnection, "1.8.0")).resolves.toMatchObject({
      result: {
        capabilities: {
          [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: {
            "session.shell.execute": false,
          },
        },
      },
    });
    await expect(
      oldConnection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "old-shell",
        method: "session.shell.execute",
        params: {
          sessionId: "session_1",
          commandId: "command_1",
          command: "printf ready",
        },
      }),
    ).resolves.toMatchObject({ error: { code: -32601 } });

    const connection = dispatcher.createConnection();
    await expect(initialize(connection, "1.9.0")).resolves.toMatchObject({
      result: {
        capabilities: {
          [AGENC_DAEMON_METHOD_CAPABILITIES_KEY]: {
            "session.shell.execute": true,
          },
        },
      },
    });
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "shell",
        method: "session.shell.execute",
        params: {
          sessionId: "session_1",
          commandId: "command_1",
          command: "printf ready",
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "shell",
      result: successResult,
    });
    expect(executeSessionShell).toHaveBeenCalledTimes(1);
    expect(executeSessionShell).toHaveBeenCalledWith(
      {
        sessionId: "session_1",
        commandId: "command_1",
        command: "printf ready",
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects missing, oversized, and authority-bearing parameters", async () => {
    const executeSessionShell = vi.fn(async () => successResult);
    const connection = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { executeSessionShell } as never,
    }).createConnection();
    await initialize(connection, "1.9.0");

    const valid = {
      sessionId: "session_1",
      commandId: "command_1",
      command: "printf ready",
    };
    const malformed = [
      {},
      { ...valid, sessionId: "" },
      { ...valid, commandId: " " },
      { ...valid, command: "\t" },
      {
        ...valid,
        sessionId: "x".repeat(MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES + 1),
      },
      {
        ...valid,
        commandId: "😀".repeat(
          Math.floor(MAX_SESSION_SHELL_IDENTIFIER_UTF8_BYTES / 4) + 1,
        ),
      },
      {
        ...valid,
        command: "x".repeat(MAX_SESSION_SHELL_COMMAND_UTF8_BYTES + 1),
      },
      { ...valid, cwd: "/tmp" },
      { ...valid, shell: "/bin/sh" },
      { ...valid, env: { PATH: "/tmp" } },
      { ...valid, tool: "Bash" },
      { ...valid, bypass: true },
    ];

    for (const [index, params] of malformed.entries()) {
      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: `malformed-${index}`,
          method: "session.shell.execute",
          params,
        }),
      ).resolves.toMatchObject({ error: { code: -32602 } });
    }
    expect(executeSessionShell).not.toHaveBeenCalled();
  });

  it("rejects malformed or unbounded manager results", async () => {
    const malformedResults: readonly unknown[] = [
      null,
      { ...successResult, commandId: "other" },
      { ...successResult, unexpected: true },
      { ...successResult, stdout: 12 },
      { ...successResult, exitCode: Number.NaN },
      { ...successResult, timedOut: "false" },
      {
        ...successResult,
        content: "x".repeat(MAX_SESSION_SHELL_RESULT_TEXT_UTF8_BYTES + 1),
      },
    ];

    for (const [index, result] of malformedResults.entries()) {
      const executeSessionShell = vi.fn(async () => result);
      const connection = new AgenCDaemonJsonRpcDispatcher({
        agentManager: { executeSessionShell } as never,
      }).createConnection();
      await initialize(connection, "1.9.0");

      await expect(
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION,
          id: `bad-result-${index}`,
          method: "session.shell.execute",
          params: {
            sessionId: "session_1",
            commandId: "command_1",
            command: "printf ready",
          },
        }),
      ).resolves.toMatchObject({ error: { code: -32603 } });
    }
  });

  it("cancels an in-flight session shell request", async () => {
    let observedSignal: AbortSignal | undefined;
    const executeSessionShell = vi.fn(
      async (
        _params: SessionShellExecuteParams,
        signal: AbortSignal,
      ): Promise<SessionShellExecuteResult> => {
        observedSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return successResult;
      },
    );
    const connection = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { executeSessionShell } as never,
    }).createConnection();
    await initialize(connection, "1.9.0");

    const pending = connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "shell-cancelled",
      method: "session.shell.execute",
      params: {
        sessionId: "session_1",
        commandId: "command_1",
        command: "sleep 30",
      },
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "cancel",
        method: "request.cancel",
        params: { requestId: "shell-cancelled", reason: "operator" },
      }),
    ).resolves.toMatchObject({ result: { cancelled: true } });
    await expect(pending).resolves.toMatchObject({
      error: {
        code: -32000,
        data: {
          code: "REQUEST_CANCELLED",
          requestId: "shell-cancelled",
          reason: "operator",
        },
      },
    });
    expect(observedSignal?.aborted).toBe(true);
  });
});
