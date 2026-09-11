import { describe, expect, it, vi } from "vitest";
import { createAgencClient, type AgencTransport, type MessageContent } from "../../../packages/agenc-sdk/src/index.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import type { AgenCDaemonSessionNotification, JsonObject } from "../../src/app-server/protocol/index.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";

const sessionId = "sdk-validation-session";
const clientMessageId = "reused-message";
const turnId = "original-turn";

function userMessage(content?: MessageContent): AgenCDaemonSessionNotification {
  return { jsonrpc: "2.0", method: "event.session_event", params: {
    sessionId, eventId: "user-marker", event: { id: "user-marker", type: "user_message", payload: {
      messageId: clientMessageId, ...(content === undefined ? {} : { message: content }),
    } },
  } };
}

function status(terminal = false): AgenCDaemonSessionNotification {
  return { jsonrpc: "2.0", method: "event.agent_status", params: {
    sessionId, eventId: terminal ? "terminal-event" : "start-event", turnId,
    status: terminal ? "idle" : "running", ...(terminal ? { runStatus: "completed", message: "notification result" } : {}),
  } };
}

const permission: AgenCDaemonSessionNotification = {
  jsonrpc: "2.0", method: "event.permission_request", params: {
    sessionId, eventId: "permission-event", requestId: "permission-1", turnId, permissions: [],
  },
};

async function connectedDaemon(stream: (params: JsonObject) => Promise<unknown>) {
  const sessions = new AgenCDaemonSessionManager();
  await sessions.restoreSession({ sessionId, agentId: "agent_1", cwd: process.cwd() });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const approved = Promise.withResolvers<void>();
  const approve = vi.fn(async () => {
    approved.resolve();
    return { requestId: "permission-1", decision: "approved" };
  });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    sessionManager: sessions, clientMultiplexer: multiplexer,
    agentManager: {
      streamAgentMessage: stream, approveTool: approve,
      getSessionTranscriptV2: async () => ({
        schemaVersion: 2, sessionId, runId: "run_1", historyEpoch: "initial", asOfSequence: 0, messages: [],
      }),
    } as never,
  });
  let deliver: (notification: JsonObject) => void = () => {};
  let paused = false;
  const delayed: JsonObject[] = [];
  const transport = new AgenCInProcessDaemonTransport({
    dispatcher,
    sendNotification: (notification) => {
      const wireNotification = JSON.parse(JSON.stringify(notification)) as JsonObject;
      if (paused) delayed.push(wireNotification);
      else deliver(wireNotification);
    },
  });
  const onPermissionRequest = vi.fn(async () => ({ behavior: "allow" as const }));
  const client = createAgencClient({
    transport: transport as unknown as AgencTransport,
    clientId: "sdk-validation-client", onPermissionRequest,
  });
  deliver = (notification) => client.dispatchNotification(notification);
  await client.initialize();
  const session = await client.resumeSession(sessionId);
  return {
    client, session, approve, approved, onPermissionRequest,
    emit: (notification: AgenCDaemonSessionNotification) => multiplexer.broadcastSessionNotification(sessionId, notification),
    pause: () => { paused = true; },
    flush: () => { paused = false; for (const notification of delayed.splice(0)) deliver(notification); },
    close: async () => { await client.close(); await dispatcher.close(); },
  };
}

describe("SDK submission validation against delayed session notifications", () => {
  it.each(["null prototype", "undefined property", "post-dispatch mutation"] as const)(
    "preserves live approvals for structured content with %s across JSON framing",
    async (representation) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let submittedContent: unknown;
      const daemon = await connectedDaemon(async (params) => {
        submittedContent = params.content;
        entered.resolve();
        await release.promise;
        return { disposition: "started", acceptedAt: params.acceptedAt, turnId, terminal: { code: 0 } };
      });
      const block: { type: "text"; text: string; optional?: undefined } = representation === "null prototype"
        ? Object.assign(Object.create(null), { type: "text", text: "hello" })
        : { type: "text", text: "hello", ...(representation === "undefined property" ? { optional: undefined } : {}) };
      try {
        const run = daemon.session.prompt([block], { clientMessageId, includeUsage: false });
        await entered.promise;
        if (representation === "post-dispatch mutation") block.text = "changed after sending";
        await daemon.emit(userMessage([{ type: "text", text: "hello" }]));
        await daemon.emit(status());
        await daemon.emit(permission);
        await drainMicrotasks(20);
        expect(daemon.onPermissionRequest).toHaveBeenCalledOnce();
        await daemon.approved.promise;
        expect(submittedContent).toEqual([{ type: "text", text: "hello" }]);
        release.resolve();
        await expect(run.result()).resolves.toMatchObject({ exitCode: 0 });
        await run.accepted;
      } finally {
        release.resolve();
        await daemon.close();
      }
    },
  );

  it("does not grant a replayed approval for a conflicting reused submission ID", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const daemon = await connectedDaemon(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("submission content conflicts");
    });
    try {
      daemon.pause();
      await daemon.emit(userMessage("original content"));
      await daemon.emit(status());
      await daemon.emit(permission);
      await daemon.emit(status(true));
      const run = daemon.session.prompt("different content", { clientMessageId, includeUsage: false });
      const accepted = run.accepted.catch((error: unknown) => error);
      const result = run.result().catch((error: unknown) => error);
      await entered.promise;
      daemon.flush();
      await drainMicrotasks(20);
      expect(daemon.onPermissionRequest).not.toHaveBeenCalled();
      expect(daemon.approve).not.toHaveBeenCalled();
      release.resolve();
      expect(await accepted).toMatchObject({ message: "submission content conflicts" });
      expect(await result).toMatchObject({ message: "submission content conflicts" });
    } finally {
      release.resolve();
      await daemon.close();
    }
  });

  it("keeps an identity-only terminal provisional when the RPC later rejects", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const daemon = await connectedDaemon(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("submission rejected");
    });
    try {
      const run = daemon.session.prompt("content", { clientMessageId, includeUsage: false });
      const accepted = run.accepted.catch((error: unknown) => error);
      const result = run.result().catch((error: unknown) => error);
      let settled = false;
      void run.result().then(() => { settled = true; }, () => { settled = true; });
      await entered.promise;
      await daemon.emit(userMessage());
      await daemon.emit(status());
      await daemon.emit(status(true));
      await drainMicrotasks(20);
      expect(settled).toBe(false);
      release.resolve();
      expect(await accepted).toMatchObject({ message: "submission rejected" });
      expect(await result).toMatchObject({ message: "submission rejected" });
    } finally {
      release.resolve();
      await daemon.close();
    }
  });

  it("answers live approvals before the RPC completes and validates its matching terminal", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const daemon = await connectedDaemon(async (params) => {
      entered.resolve();
      await release.promise;
      return { disposition: "started", acceptedAt: params.acceptedAt, turnId, terminal: { code: 0, message: "RPC fallback result" } };
    });
    try {
      const run = daemon.session.prompt("content", { clientMessageId, includeUsage: false });
      let settled = false;
      void run.result().then(() => { settled = true; }, () => { settled = true; });
      await entered.promise;
      await daemon.emit(userMessage("content"));
      await daemon.emit(status());
      await daemon.emit(permission);
      await daemon.approved.promise;
      expect(daemon.approve).toHaveBeenCalledOnce();
      await daemon.emit(status(true));
      await drainMicrotasks(20);
      expect(settled).toBe(false);
      release.resolve();
      await expect(run.accepted).resolves.toMatchObject({ clientMessageId, turnId });
      // Preserve the established event-derived result after validating admission;
      // the RPC terminal supplies a fallback when the matching event is absent.
      await expect(run.result()).resolves.toMatchObject({ exitCode: 0, finalMessage: "notification result" });
    } finally {
      release.resolve();
      await daemon.close();
    }
  });

  it("suppresses a late approval and settles provisional prompt handles when the client closes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<{ behavior: "allow" }>();
    const daemon = await connectedDaemon(async (params) => {
      entered.resolve();
      await release.promise;
      return { disposition: "started", acceptedAt: params.acceptedAt, turnId, terminal: { code: 0 } };
    });
    daemon.onPermissionRequest.mockImplementationOnce(() => decision.promise);
    try {
      const run = daemon.session.prompt("content", { clientMessageId, includeUsage: false });
      const accepted = run.accepted.catch((error: unknown) => error);
      const result = run.result().catch((error: unknown) => error);
      await entered.promise;
      await daemon.emit(userMessage("content"));
      await daemon.emit(status());
      await daemon.emit(permission);
      expect(daemon.onPermissionRequest).toHaveBeenCalledOnce();
      await daemon.emit(status(true));
      decision.resolve({ behavior: "allow" });
      await drainMicrotasks(20);
      expect(daemon.approve).not.toHaveBeenCalled();
      await daemon.client.close();
      expect(await accepted).toMatchObject({ message: "AgenC SDK client is closed" });
      expect(await result).toMatchObject({ message: "AgenC SDK client is closed" });
    } finally {
      decision.resolve({ behavior: "allow" });
      release.resolve();
      await daemon.close();
    }
  });
});
