import { describe, expect, it, vi } from "vitest";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";
import { adaptTranscriptEvents, type SessionTranscriptEvent } from "../../src/tui/session-transcript.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";

const sessionId = "parent-session";
const parentTurnId = "sub-parent-session-2452";
const childTurnId = "sub-child-session-0";
const childRequestId = "child-approval:occurrence:event:86";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function connectedSession(responseTurnId = parentTurnId) {
  const sessions = new AgenCDaemonSessionManager();
  await sessions.restoreSession({ sessionId, agentId: "parent-agent", cwd: process.cwd() });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const entered = deferred();
  const release = deferred();
  const approved = deferred();
  const approvals: JsonObject[] = [];
  const cancellations: JsonObject[] = [];
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    sessionManager: sessions, clientMultiplexer: multiplexer,
    agentManager: {
      streamAgentMessage: async (params: JsonObject) => {
        entered.resolve();
        await release.promise;
        return { disposition: "started", acceptedAt: params.acceptedAt, turnId: responseTurnId, terminal: { code: 0 } };
      },
      approveTool: async (params: JsonObject) => {
        approvals.push(params);
        approved.resolve();
        return { requestId: params.requestId, decision: "approved" };
      },
      cancelSessionTurn: async (params: JsonObject) => {
        cancellations.push(params);
        return { sessionId, cancelled: true };
      },
      getSessionTranscriptV2: async () => ({ schemaVersion: 2, sessionId, runId: "parent-agent", historyEpoch: "initial", asOfSequence: 0, messages: [] }),
    } as never,
  });
  const listeners = new Set<(notification: JsonObject) => void>();
  const transport = new AgenCInProcessDaemonTransport({ dispatcher, sendNotification: (notification) => {
    for (const listener of listeners) listener(notification);
  } });
  let requestId = 0;
  const client = {
    request: async (method: string, params?: JsonObject) => {
      const response = await transport.dispatch({ jsonrpc: "2.0", id: ++requestId, method, ...(params === undefined ? {} : { params }) });
      if ("error" in response) throw new Error(response.error.message);
      return response.result;
    },
    subscribeToSessionEvents: (_sessionId: string, listener: (notification: JsonObject) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as AgenCDaemonTuiClient;
  await transport.initialize();
  await client.request("session.attach", { sessionId, clientId: "tui-parent" });
  const permission = vi.fn(async () => ({ kind: "approved" as const }));
  const session = createDaemonTuiSessionFixture({
    baseSession: { conversationId: sessionId, services: { approvalResolver: { request: permission } } },
    client, sessionId, clientId: "tui-parent",
  });
  const events: SessionTranscriptEvent[] = [];
  const unsubscribe = session.subscribeToEvents((event) => events.push(event as SessionTranscriptEvent));
  const emit = (type: string, payload: JsonObject) => multiplexer.broadcastSessionNotification(sessionId,
    notificationFromDaemonEvent(sessionId, "parent-agent", { id: `${type}:${events.length}`, type, payload, statusProjection: "session_only" } as never));
  return {
    session, events, entered, release, approved, approvals, cancellations, permission, emit,
    childApproval: () => emit("request_permissions", {
      callId: "child-exec", requestId: childRequestId, turnId: childTurnId,
      sourceConversationId: "child-session", permissions: ["tool.use"], toolName: "exec_command", input: { cmd: "npm test" },
    }),
    close: async () => { release.resolve(); unsubscribe(); await transport.close(); await dispatcher.close(); },
  };
}

describe("TUI parent turn ownership while reviewing child approvals", () => {
  it("keeps approval/cancellation identities separate and clears the parent despite a pending RPC", async () => {
    const connected = await connectedSession();
    try {
      const submitted = connected.session.submit("verify through a worker", { clientMessageId: "parent-input" });
      void submitted.catch(() => {});
      await connected.entered.promise;
      await connected.emit("turn_started", { turnId: parentTurnId });
      await connected.childApproval();
      await connected.approved.promise;
      expect(connected.events).toContainEqual(expect.objectContaining({
        type: "request_permissions", payload: expect.objectContaining({ callId: childRequestId, turnId: childTurnId }),
      }));
      expect(connected.approvals).toEqual([expect.objectContaining({ sessionId, requestId: childRequestId })]);
      expect(connected.session.activeTurn?.unsafePeek()).toEqual({ turnId: parentTurnId });
      await (connected.session as typeof connected.session & {
        cancelActiveTurn(reason?: string): Promise<void>;
      }).cancelActiveTurn("interrupt parent");
      expect(connected.cancellations).toEqual([expect.objectContaining({ sessionId, expectedTurnId: parentTurnId })]);
      await connected.emit("turn_complete", { turnId: parentTurnId, lastAgentMessage: "all tests passed" });
      // These are the two authoritative inputs to App's pending-submit cleanup;
      // message.stream remains deliberately held until after both have cleared.
      expect(connected.session.activeTurn?.unsafePeek()).toBeNull();
      expect(adaptTranscriptEvents(connected.events).isStreaming).toBe(false);
      connected.release.resolve();
      await submitted;
      expect(connected.session.activeTurn?.unsafePeek()).toBeNull();
    } finally {
      await connected.close();
    }
  });

  it("does not let a stale parent terminal clear a newer parent after a child approval", async () => {
    const connected = await connectedSession();
    try {
      await connected.emit("turn_started", { turnId: parentTurnId });
      await connected.childApproval();
      await connected.emit("turn_started", { turnId: "new-parent-turn" });
      await connected.emit("turn_complete", { turnId: parentTurnId });
      expect(connected.session.activeTurn?.unsafePeek()).toEqual({ turnId: "new-parent-turn" });
      expect(adaptTranscriptEvents(connected.events).isStreaming).toBe(true);
      await connected.emit("turn_complete", { turnId: "new-parent-turn" });
      expect(connected.session.activeTurn?.unsafePeek()).toBeNull();
    } finally {
      await connected.close();
    }
  });

  it("shows an idle child's approval without inventing a parent turn", async () => {
    const connected = await connectedSession();
    try {
      await connected.childApproval();
      await drainMicrotasks(20);
      expect(connected.permission).toHaveBeenCalledOnce();
      expect(connected.session.activeTurn?.unsafePeek()).toBeNull();
    } finally {
      await connected.close();
    }
  });

  it("preserves a pending submission when a completed parent's approval arrives late", async () => {
    const connected = await connectedSession("new-parent-turn");
    try {
      await connected.emit("turn_started", { turnId: parentTurnId });
      await connected.emit("turn_complete", { turnId: parentTurnId });
      const submitted = connected.session.submit("start a new parent", { clientMessageId: "new-parent-input" });
      void submitted.catch(() => {});
      await connected.entered.promise;
      const pendingTurn = connected.session.activeTurn?.unsafePeek();
      expect(pendingTurn).not.toBeNull();
      expect(pendingTurn?.turnId).not.toBe(parentTurnId);

      await connected.emit("request_permissions", {
        callId: "old-parent-exec", requestId: "old-parent-approval", turnId: parentTurnId,
        permissions: ["tool.use"], toolName: "exec_command", input: { cmd: "npm test" },
      });
      await connected.approved.promise;
      expect(connected.approvals).toEqual([expect.objectContaining({ requestId: "old-parent-approval" })]);
      expect(connected.session.activeTurn?.unsafePeek()).toEqual(pendingTurn);
      await connected.emit("turn_complete", { turnId: parentTurnId });
      expect(connected.session.activeTurn?.unsafePeek()).toEqual(pendingTurn);

      await connected.emit("turn_started", { turnId: "new-parent-turn" });
      await connected.emit("turn_complete", { turnId: "new-parent-turn" });
      expect(connected.session.activeTurn?.unsafePeek()).toBeNull();
      connected.release.resolve();
      await submitted;
    } finally {
      await connected.close();
    }
  });
});
