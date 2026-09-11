import { describe, expect, it } from "vitest";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";

describe("capability replay ownership", () => {
  it.each([false, true])(
    "retains an undelivered action when termination shifts replay (partial buffer: %s)",
    async (partial) => {
      const sessions = new AgenCDaemonSessionManager();
      const original = await sessions.createSession({ cwd: process.cwd() });
      const next = await sessions.createSession({ cwd: process.cwd() });
      const multiplexer = new AgenCDaemonClientMultiplexer({
        sessionManager: sessions,
        maxBufferedEventsPerSession: 3,
      });
      const capability = "portal.ledger.solana.sign.v1";
      const first = { actionId: "first" };
      const pending = { actionId: "pending" };
      const surviving = { actionId: "surviving" };
      await multiplexer.broadcastCapabilityEvent(original.sessionId, capability, first);
      if (partial) await multiplexer.broadcastCapabilityEvent(next.sessionId, capability, surviving);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const received: JsonObject[] = [];
      const registering = multiplexer.registerClient({
        clientId: "original-phone", capabilities: { [capability]: true },
        send: async (event) => {
          received.push(event);
          entered.resolve();
          await release.promise;
        },
      });
      try {
        await entered.promise;
        await multiplexer.disconnectClient("original-phone");
        await multiplexer.terminateSession({ sessionId: original.sessionId });
        await multiplexer.broadcastCapabilityEvent(next.sessionId, capability, pending);
        release.resolve();
        await registering;
        const replacement: JsonObject[] = [];
        await multiplexer.registerClient({
          clientId: "replacement-phone", capabilities: { [capability]: true },
          send: (event) => { replacement.push(event); },
        });
        expect(received).toEqual(partial ? [first, surviving] : [first]);
        expect(replacement).toEqual([pending]);
        const later: JsonObject[] = [];
        await multiplexer.registerClient({
          clientId: "later-phone", capabilities: { [capability]: true },
          send: (event) => { later.push(event); },
        });
        expect(later).toEqual([]);
      } finally {
        release.resolve();
        await registering;
        await Promise.all([
          multiplexer.terminateSession({ sessionId: original.sessionId }),
          multiplexer.terminateSession({ sessionId: next.sessionId }),
        ]);
      }
    },
  );
});
