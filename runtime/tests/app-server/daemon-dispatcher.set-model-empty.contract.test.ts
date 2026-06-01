import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";

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

// GAP #13c regression: an empty-string model or provider passed the
// `=== undefined` guard and slipped past the "at least one" gate, staging an
// empty model. The validator must now reject empty strings up front.
describe("daemon session.setModel empty-string rejection (GAP #13c)", () => {
  it("rejects session.setModel with an empty model string", async () => {
    const setSessionModel = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionModel } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "empty-model",
        method: "session.setModel",
        params: { sessionId: "session_1", model: "" },
      }),
    ).resolves.toMatchObject({
      id: "empty-model",
      error: { code: -32602 },
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("rejects session.setModel with an empty provider string", async () => {
    const setSessionModel = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionModel } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "empty-provider",
        method: "session.setModel",
        params: { sessionId: "session_1", provider: "" },
      }),
    ).resolves.toMatchObject({
      id: "empty-provider",
      error: { code: -32602 },
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("rejects session.setModel when both model and provider are empty", async () => {
    const setSessionModel = vi.fn();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { setSessionModel } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);

    await expect(
      connection.dispatch({
        jsonrpc: JSON_RPC_VERSION,
        id: "empty-both",
        method: "session.setModel",
        params: { sessionId: "session_1", model: "", provider: "" },
      }),
    ).resolves.toMatchObject({
      id: "empty-both",
      error: { code: -32602 },
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("still accepts a non-empty model with an absent provider", async () => {
    const setSessionModel = vi.fn(async () => ({
      sessionId: "session_1",
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
        id: "ok-model",
        method: "session.setModel",
        params: { sessionId: "session_1", model: "gpt-x" },
      }),
    ).resolves.toMatchObject({
      id: "ok-model",
      result: { applied: true },
    });
    expect(setSessionModel).toHaveBeenCalledWith({
      sessionId: "session_1",
      model: "gpt-x",
    });
  });
});
