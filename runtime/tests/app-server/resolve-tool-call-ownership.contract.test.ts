import { describe, expect, it, vi } from "vitest";

import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";

// An operator review lifts a session's mutation gate. Only a local client
// attached to that session, on the same connection, may submit it, and the
// recorded reviewer comes from the connection, never from the request body.

async function daemonWithTwoSessions() {
  const sessions = new AgenCDaemonSessionManager();
  await sessions.restoreSession({ sessionId: "session_a", agentId: "conv-a", cwd: process.cwd() });
  await sessions.restoreSession({ sessionId: "session_b", agentId: "conv-b", cwd: process.cwd() });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const resolveSessionToolCall = vi.fn(async (params: { sessionId: string }) => ({
    sessionId: params.sessionId,
    resolved: [{ toolCallId: "call_1", toolName: "mcp.lane.lane_hang" }],
    remaining: 0,
  }));
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    sessionManager: sessions,
    clientMultiplexer: multiplexer,
    agentManager: { resolveSessionToolCall } as never,
  });
  let requestId = 0;
  const connect = async (options: { attachTo?: string; clientId?: string; peerUid?: number } = {}) => {
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    if (options.peerUid !== undefined) {
      connection.markDaemonSocketIdentity({ transport: "daemon", verifiedBy: "peerUid", peerUid: options.peerUid });
    }
    await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION, id: `init-${++requestId}`, method: "initialize",
      params: { protocol: { version: "1.0.0" } },
    });
    if (options.attachTo !== undefined) {
      const attached = await connection.dispatch({
        jsonrpc: JSON_RPC_VERSION, id: `attach-${++requestId}`, method: "session.attach",
        params: { sessionId: options.attachTo, clientId: options.clientId ?? `client-${options.attachTo}` },
      });
      expect(attached).toMatchObject({ result: { sessionId: options.attachTo } });
    }
    return {
      resolve: (
        sessionId: string,
        extra: Record<string, unknown> = {},
        evidence: Record<string, unknown> = { attestation: "operator" },
      ) =>
        connection.dispatch({
          jsonrpc: JSON_RPC_VERSION, id: `resolve-${++requestId}`, method: "session.resolveToolCall",
          params: { sessionId, toolCallId: "call_1", disposition: "confirmed_no_effect", ...evidence, ...extra },
        }),
    };
  };
  return { connect, resolveSessionToolCall, close: () => dispatcher.close() };
}

describe("session.resolveToolCall ownership", () => {
  it("lets each of two clients resolve only the session it is attached to", async () => {
    const daemon = await daemonWithTwoSessions();
    try {
      const first = await daemon.connect({ attachTo: "session_a", clientId: "desktop-a" });
      const second = await daemon.connect({ attachTo: "session_b", clientId: "desktop-b" });

      await expect(first.resolve("session_b")).resolves.toMatchObject({
        error: { data: { code: "SESSION_NOT_ATTACHED" } },
      });
      await expect(second.resolve("session_a")).resolves.toMatchObject({
        error: { data: { code: "SESSION_NOT_ATTACHED" } },
      });
      expect(daemon.resolveSessionToolCall).not.toHaveBeenCalled();

      await expect(first.resolve("session_a")).resolves.toMatchObject({ result: { sessionId: "session_a" } });
      await expect(second.resolve("session_b")).resolves.toMatchObject({ result: { sessionId: "session_b" } });
      expect(daemon.resolveSessionToolCall.mock.calls.map(([params]) => params.sessionId))
        .toEqual(["session_a", "session_b"]);
    } finally {
      await daemon.close();
    }
  });

  it("refuses a connection that has not attached to any session", async () => {
    const daemon = await daemonWithTwoSessions();
    try {
      const bystander = await daemon.connect();
      await expect(bystander.resolve("session_a")).resolves.toMatchObject({
        error: { data: { code: "SESSION_NOT_ATTACHED" } },
      });
      await expect(bystander.resolve("session_a", {}, { evidenceRef: "ticket:1", evidenceSha256: "a".repeat(64) }))
        .resolves.toMatchObject({ error: { data: { code: "SESSION_NOT_ATTACHED" } } });
      expect(daemon.resolveSessionToolCall).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
    }
  });

  it("records the reviewer from the connection identity, not from the request", async () => {
    const daemon = await daemonWithTwoSessions();
    try {
      const owner = await daemon.connect({ attachTo: "session_a", clientId: "desktop-a", peerUid: 1000 });
      await owner.resolve("session_a", { reviewer: "someone-else" });
      const unverified = await daemon.connect({ attachTo: "session_b", clientId: "tui-b" });
      await unverified.resolve("session_b", { reviewer: "root" });
      expect(daemon.resolveSessionToolCall.mock.calls.map(([params]) => (params as { reviewer?: string }).reviewer))
        .toEqual(["local-user:uid=1000:client=desktop-a", "local-client:tui-b"]);
    } finally {
      await daemon.close();
    }
  });
});
