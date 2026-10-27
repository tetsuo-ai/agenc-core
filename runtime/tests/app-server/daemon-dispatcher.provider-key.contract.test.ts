import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";

async function connectionFor(setSessionProviderKey: ReturnType<typeof vi.fn>) {
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { setSessionProviderKey } as never });
  const connection = dispatcher.createConnection();
  await connection.dispatch({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocol: { version: "1.33.0" } } });
  return connection;
}

describe("session provider key ingress", () => {
  it("returns only session identity, never the supplied credential", async () => {
    const setSessionProviderKey = vi.fn(async () => ({ sessionId: "session_1" }));
    const connection = await connectionFor(setSessionProviderKey);
    const result = await connection.dispatch({ jsonrpc: "2.0", id: "key", method: "session.setProviderKey",
      params: { sessionId: "session_1", provider: "deepseek", apiKey: "test-placeholder" } });
    expect(result).toEqual({ jsonrpc: "2.0", id: "key", result: { sessionId: "session_1" } });
    expect(setSessionProviderKey).toHaveBeenCalledWith({ sessionId: "session_1", provider: "deepseek", apiKey: "test-placeholder" });
    expect(JSON.stringify(result)).not.toContain("test-placeholder");
  });

  it.each(["", "test placeholder", "x".repeat(32_769)])("rejects invalid credential input without reflecting it", async (apiKey) => {
    const setSessionProviderKey = vi.fn();
    const connection = await connectionFor(setSessionProviderKey);
    const result = await connection.dispatch({ jsonrpc: "2.0", id: "invalid", method: "session.setProviderKey",
      params: { sessionId: "session_1", provider: "deepseek", apiKey } });
    expect(result).toMatchObject({ error: { code: -32602 } });
    expect(setSessionProviderKey).not.toHaveBeenCalled();
    if (apiKey) expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});
