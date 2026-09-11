import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

describe.each(["message.send", "message.stream"])("%s cancellation failure isolation", (method) => {
  it.each(["request.cancel", "disconnect"])(
    "keeps a late legacy interruption failure contained after %s", async (trigger) => {
      const entered = Promise.withResolvers<void>();
      const releaseStream = Promise.withResolvers<void>();
      const releaseCancellation = Promise.withResolvers<void>();
      const sessions = new AgenCDaemonSessionManager();
      const session = await sessions.createSession({ cwd: process.cwd() });
      const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
      const cancelSessionTurn = vi.fn(async () => {
        await releaseCancellation.promise;
        throw new Error("runner was retired before legacy interruption completed");
      });
      const dispatcher = new AgenCDaemonJsonRpcDispatcher({
        sessionManager: sessions, clientMultiplexer: multiplexer,
        agentManager: {
          streamAgentMessage: async (params: JsonObject) => {
            entered.resolve();
            await releaseStream.promise;
            return { disposition: "started", acceptedAt: params.acceptedAt, terminal: { code: 0 } };
          },
          cancelSessionTurn,
        } as never,
      });
      const transport = new AgenCInProcessDaemonTransport({ dispatcher, sendNotification: () => {} });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      let sending: ReturnType<typeof transport.dispatch> | undefined;
      try {
        await transport.initialize();
        await transport.dispatch({
          jsonrpc: "2.0", id: "attach", method: "session.attach",
          params: { sessionId: session.sessionId, clientId: "legacy-client" },
        });
        // Omitting clientMessageId preserves the supported legacy interruption
        // path even when this peer negotiates the current protocol version.
        sending = transport.dispatch({
          jsonrpc: "2.0", id: "sending", method,
          params: { sessionId: session.sessionId, content: "held submission" },
        });
        await entered.promise;
        if (trigger === "disconnect") {
          await transport.close();
        } else {
          await expect(transport.dispatch({
            jsonrpc: "2.0", id: "cancel", method: "request.cancel", params: { requestId: "sending" },
          })).resolves.toMatchObject({ result: { cancelled: true } });
        }
        await expect(sending).resolves.toHaveProperty("error");
        expect(cancelSessionTurn).toHaveBeenCalledOnce();
        releaseCancellation.resolve();
        await setImmediate();
        expect(unhandled).toEqual([]);
        const peer = new AgenCInProcessDaemonTransport({ dispatcher });
        try {
          await expect(peer.initialize()).resolves.toHaveProperty("result");
          await expect(peer.dispatch({ jsonrpc: "2.0", id: "ping", method: "health.ping", params: {} }))
            .resolves.toHaveProperty("result");
        } finally {
          await peer.close();
        }
      } finally {
        releaseCancellation.resolve();
        releaseStream.resolve();
        await sending;
        await transport.close();
        await dispatcher.close();
        await setImmediate();
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );
});
