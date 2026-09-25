import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import type { AgenCDaemonSessionNotification, JsonObject } from "../../src/app-server/protocol/index.js";
import { createAgencClient, type AgencTransport } from "../../../packages/agenc-sdk/src/index.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

const sessionId = "submission-ownership-session";
async function connectedDaemon(stream: (params: JsonObject) => Promise<unknown>) {
  const sessions = new AgenCDaemonSessionManager();
  await sessions.restoreSession({ sessionId, agentId: "agent_1", cwd: process.cwd() });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const approvals: JsonObject[] = [];
  const submissions: JsonObject[] = [];
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    sessionManager: sessions,
    clientMultiplexer: multiplexer,
    agentManager: {
      streamAgentMessage: async (params: JsonObject) => {
        submissions.push(params);
        return stream(params);
      },
      approveTool: async (params: JsonObject) => {
        approvals.push(params);
        return { requestId: params.requestId, decision: "approved" };
      },
      getSessionTranscriptV2: async () => ({
        schemaVersion: 2, sessionId, runId: "run_1", historyEpoch: "initial",
        asOfSequence: 0, messages: [],
      }),
    } as never,
  });
  const listeners = new Set<(notification: JsonObject) => void>();
  const transport = new AgenCInProcessDaemonTransport({
    dispatcher,
    sendNotification: (notification) => {
      for (const listener of listeners) listener(notification);
    },
  });
  let nextRequestId = 0;
  const tuiClient = {
    async request(method: string, params?: JsonObject) {
      const response = await transport.dispatch({
        jsonrpc: "2.0", id: ++nextRequestId, method, ...(params === undefined ? {} : { params }),
      });
      if ("error" in response) throw new Error(response.error.message);
      return response.result;
    },
    subscribeToSessionEvents(_sessionId: string, listener: (notification: JsonObject) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as AgenCDaemonTuiClient;
  return {
    transport, multiplexer, listeners, tuiClient, submissions, approvals,
    close: async () => { await transport.close(); await dispatcher.close(); },
  };
}

describe("connected client submission ownership", () => {
  it.each(["conflict", "duplicate"] as const)(
    "does not treat attach replay as admission of an SDK %s submission",
    async (outcome) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const daemon = await connectedDaemon(async (params) => {
        entered.resolve();
        await release.promise;
        if (outcome === "conflict") throw new Error("submission content conflicts");
        return {
          disposition: "duplicate", duplicateState: "completed", acceptedAt: params.acceptedAt,
          turnId: "original-turn", terminal: { code: 0, message: "canonical duplicate result" },
        };
      });
      const permission = vi.fn(() => ({ behavior: "allow" as const }));
      const client = createAgencClient({
        transport: daemon.transport as unknown as AgencTransport,
        clientId: "sdk-owner", onPermissionRequest: permission,
      });
      daemon.listeners.add((notification) => client.dispatchNotification(notification));
      try {
        await client.initialize();
        const notifications: AgenCDaemonSessionNotification[] = [
          { jsonrpc: "2.0", method: "event.session_event", params: {
            sessionId, eventId: "old-user", event: { id: "old-user", type: "user_message", payload: { messageId: "reused-message", message: "original content" } },
          } },
          { jsonrpc: "2.0", method: "event.agent_status", params: { sessionId, eventId: "old-start", turnId: "original-turn", status: "running" } },
          { jsonrpc: "2.0", method: "event.permission_request", params: { sessionId, eventId: "old-permission", requestId: "old-permission", turnId: "original-turn", permissions: [] } },
          { jsonrpc: "2.0", method: "event.agent_status", params: { sessionId, eventId: "old-terminal", turnId: "original-turn", status: "idle", runStatus: "completed", message: "stale replay result" } },
        ];
        for (const notification of notifications) {
          await daemon.multiplexer.broadcastSessionNotification(sessionId, notification);
        }
        const run = client.runPrompt(sessionId, outcome === "conflict" ? "different content" : "original content", {
          clientMessageId: "reused-message", includeUsage: false,
        });
        let settled = false;
        void run.result().then(() => { settled = true; }, () => { settled = true; });
        await entered.promise;
        expect(permission).not.toHaveBeenCalled();
        expect(daemon.approvals).toEqual([]);
        expect(settled).toBe(false);
        release.resolve();
        if (outcome === "conflict") {
          await expect(run.accepted).rejects.toThrow("submission content conflicts");
          await expect(run.result()).rejects.toThrow("submission content conflicts");
        } else {
          await expect(run.result()).resolves.toMatchObject({ finalMessage: "canonical duplicate result" });
          await expect(run.accepted).resolves.toMatchObject({ clientMessageId: "reused-message" });
        }
      } finally {
        release.resolve();
        await client.close();
        await daemon.close();
      }
    },
  );
});
