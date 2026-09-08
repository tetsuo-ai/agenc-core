import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

const contexts: Awaited<ReturnType<typeof messageConnection>>[] = [];

async function messageConnection(createMessageId?: () => string) {
  const manager = new AgenCDaemonAgentManager();
  const submit = vi.spyOn(manager, "streamAgentMessage").mockImplementation(async params => ({
    disposition: "started", acceptedAt: params.acceptedAt,
  }));
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: manager, createMessageId });
  const connection = dispatcher.createConnection({ overloadLimits: { requestBurst: 5_000 } });
  expect(await connection.dispatch({
    jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocol: { version: "1.2.0" } },
  })).toHaveProperty("result");
  const context = { manager, submit, dispatcher, connection };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.connection.close();
    await context.dispatcher.close();
  }
  vi.restoreAllMocks();
});

describe("daemon fallback message identities", () => {
  it("generates 4,000 distinct IDs across dispatcher instances with a frozen clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const connections = [await messageConnection(), await messageConnection()];
    const identities: string[] = [];
    for (let index = 0; index < 4_000; index += 1) {
      const context = connections[index % connections.length]!;
      const method = index % 4 < 2 ? "message.send" : "message.stream";
      const response = await context.connection.dispatch({
        jsonrpc: "2.0", id: `request-${index}`, method,
        params: { sessionId: "session-identities", content: "same content" },
      });
      expect(response).not.toHaveProperty("error");
      const result = response.result as JsonObject;
      expect(result.messageId).toEqual(expect.stringMatching(/^message_/));
      identities.push(result.messageId as string);
      expect(context.submit.mock.lastCall?.[0]).toMatchObject({
        messageId: result.messageId, streamId: result.messageId,
      });
      if (method === "message.stream") expect(result.streamId).toBe(result.messageId);
    }
    expect(new Set(identities).size).toBe(4_000);
  });

  it("keeps injected, caller-supplied and explicit stream identities unchanged", async () => {
    const generator = vi.fn(() => "injected-message");
    const { connection, submit } = await messageConnection(generator);
    const supplied = await connection.dispatch({
      jsonrpc: "2.0", id: "supplied", method: "message.send",
      params: { sessionId: "session-explicit", content: "first", clientMessageId: "caller-message" },
    });
    expect(supplied).toMatchObject({ result: { messageId: "caller-message" } });
    expect(generator).not.toHaveBeenCalled();
    const generated = await connection.dispatch({
      jsonrpc: "2.0", id: "generated", method: "message.stream",
      params: { sessionId: "session-explicit", content: "second", streamId: "caller-stream" },
    });
    expect(generated).toMatchObject({ result: { messageId: "injected-message", streamId: "caller-stream" } });
    expect(generator).toHaveBeenCalledOnce();
    expect(submit.mock.lastCall?.[0]).toMatchObject({ messageId: "injected-message", streamId: "caller-stream" });
  });

  it("cancels one fallback request without changing the other generated stream identity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { manager, connection, submit } = await messageConnection();
    const releases: (() => void)[] = [];
    submit.mockImplementation(params => new Promise(resolve => {
      releases.push(() => resolve({ disposition: "started", acceptedAt: params.acceptedAt }));
    }));
    const cancel = vi.spyOn(manager, "cancelSessionTurn").mockResolvedValue({
      sessionId: "session-cancelled", cancelled: true,
    });
    const pending = [
      connection.dispatch({
        jsonrpc: "2.0", id: "cancelled", method: "message.send",
        params: { sessionId: "session-cancelled", content: "cancel me" },
      }),
      connection.dispatch({
        jsonrpc: "2.0", id: "survivor", method: "message.stream",
        params: { sessionId: "session-survivor", content: "keep running" },
      }),
    ];
    try {
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      const identities = submit.mock.calls.map(([params]) => params.messageId);
      expect(new Set(identities).size).toBe(2);
      expect(await connection.dispatch({
        jsonrpc: "2.0", id: "cancel", method: "request.cancel", params: { requestId: "cancelled" },
      })).toMatchObject({ result: { cancelled: true } });
      expect(cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-cancelled", reason: "request.cancel" });
      for (const release of releases) release();
      const [cancelled, survivor] = await Promise.all(pending);
      expect(cancelled).toHaveProperty("error");
      expect(survivor).toMatchObject({ result: { messageId: identities[1], streamId: identities[1] } });
    } finally {
      for (const release of releases) release();
      await Promise.allSettled(pending);
    }
  });
});
