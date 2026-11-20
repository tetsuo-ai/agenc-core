import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

// message.send holdToolsUntilReleased and session.releaseTools: the transport half. The turn half
// (the model request goes out, the tool call waits) is tests/session/tool-barrier.test.ts.
async function connect() {
  const agentManager = new AgenCDaemonAgentManager();
  const stream = vi.spyOn(agentManager, "streamAgentMessage").mockResolvedValue({
    messageId: "client-1", disposition: "started", acceptedAt: "2026-11-20T10:00:00.000Z",
  } as never);
  const release = vi.spyOn(agentManager, "releaseSessionTools").mockImplementation(async params => ({
    sessionId: params.sessionId, released: true,
  }));
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager });
  const connection = dispatcher.createConnection();
  const initialized = await connection.dispatch({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocol: { version: "1.38.0" } },
  });
  const dispatch = (method: string, params: JsonObject) => connection.dispatch({
    jsonrpc: "2.0", id: method, method, params,
  });
  return { initialized, dispatch, stream, release };
}

describe("holding a turn's tool calls until the client releases them", () => {
  it("advertises session.releaseTools in daemon.methods", async () => {
    const { initialized } = await connect();
    expect(initialized).toMatchObject({ result: { capabilities: { "daemon.methods": { "session.releaseTools": true } } } });
  });

  it("hands the hold to the turn under the message's client id", async () => {
    const { dispatch, stream } = await connect();
    await dispatch("message.send", { sessionId: "session-1", content: "Edit it.", clientMessageId: "client-1", holdToolsUntilReleased: true });
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]![0]).toMatchObject({ sessionId: "session-1", messageId: "client-1", toolHoldId: "client-1" });
    await dispatch("message.send", { sessionId: "session-1", content: "Edit it.", clientMessageId: "client-2" });
    expect(stream.mock.calls[1]![0]).not.toHaveProperty("toolHoldId");
  });

  it("refuses a hold without a client message id or with a value that is not true or false", async () => {
    const { dispatch, stream } = await connect();
    expect(await dispatch("message.send", { sessionId: "session-1", content: "Edit it.", holdToolsUntilReleased: true }))
      .toMatchObject({ error: { code: -32602, message: expect.stringContaining("requires clientMessageId") } });
    expect(await dispatch("message.send", { sessionId: "session-1", content: "Edit it.", clientMessageId: "c", holdToolsUntilReleased: "yes" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(stream).not.toHaveBeenCalled();
  });

  it("releases by session and client message id, and refuses either missing", async () => {
    const { dispatch, release } = await connect();
    expect(await dispatch("session.releaseTools", { sessionId: "session-1", clientMessageId: "client-1" }))
      .toMatchObject({ result: { sessionId: "session-1", released: true } });
    expect(release).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", clientMessageId: "client-1" });
    expect(await dispatch("session.releaseTools", { sessionId: "session-1" })).toMatchObject({ error: { code: -32602 } });
    expect(await dispatch("session.releaseTools", { clientMessageId: "client-1" })).toMatchObject({ error: { code: -32602 } });
  });
});
