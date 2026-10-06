import { describe, expect, it } from "vitest";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { daemonEventFromUnboundSessionEvent, notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import { ApprovalStore } from "../../src/permissions/approval-cache.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { APPROVED_FOR_SESSION, DENIED, type ReviewDecision } from "../../src/permissions/review-decision.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";
import { DaemonApprovalRequests } from "../../src/tui/daemon-approval-requests.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

async function connectedApprovals(conversationId = "approval-parent") {
  const sessionId = "approval-parent";
  const sessions = new AgenCDaemonSessionManager();
  await sessions.restoreSession({ sessionId, agentId: sessionId, cwd: process.cwd() });
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const broker = new LiveApprovalBroker();
  const sentDecisions: JsonObject[] = [];
  let snapshot: JsonObject = { sessionId };
  let nextApprovalFailure: "before" | "after" | undefined;
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    sessionManager: sessions, clientMultiplexer: multiplexer,
    agentManager: {
      approveTool: async (params: JsonObject) => {
        sentDecisions.push(params);
        const failure = nextApprovalFailure;
        nextApprovalFailure = undefined;
        if (failure === "before") throw new Error("approval delivery failed");
        const decision = params.scope === "session" ? APPROVED_FOR_SESSION : { kind: "approved" as const };
        expect(broker.resolve(sessionId, params.requestId as string, decision)).toBe(true);
        if (failure === "after") throw new Error("approval reply lost after settlement");
        return { requestId: params.requestId, decision: decision.kind };
      },
      getSessionTranscriptV2: async () => ({ schemaVersion: 2, sessionId, runId: sessionId, historyEpoch: "initial", asOfSequence: 0, messages: [] }),
      snapshotSession: async () => snapshot,
    } as never,
  });
  const notifications: JsonObject[] = [];
  const listeners = new Set<(event: JsonObject) => void>();
  const transport = new AgenCInProcessDaemonTransport({ dispatcher, sendNotification: (event) => {
    notifications.push(event);
    for (const listener of listeners) listener(event);
  } });
  let rpcId = 0;
  const client = {
    request: async (method: string, params?: JsonObject) => {
      const response = await transport.dispatch({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
      if ("error" in response) throw new Error(response.error.message);
      return response.result;
    },
    subscribeToSessionEvents: (_id: string, listener: (event: JsonObject) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as AgenCDaemonTuiClient;
  await transport.initialize();
  await client.request("session.attach", { sessionId, clientId: "approval-tui" });
  const prompts: Array<{ ctx: ApprovalCtx; resolve: (decision: ReviewDecision) => void }> = [];
  const tui = createDaemonTuiSessionFixture({
    baseSession: { conversationId, services: { approvalResolver: { request: (ctx) => new Promise(resolve => {
      prompts.push({ ctx, resolve });
      ctx.signal?.addEventListener("abort", () => resolve(DENIED), { once: true });
    }) } } },
    client, sessionId, clientId: "approval-tui",
  });
  const unsubscribe = tui.subscribeToEvents(() => {});
  const publish = (event: Parameters<typeof notificationFromDaemonEvent>[2]) => {
    void multiplexer.broadcastSessionNotification(sessionId, notificationFromDaemonEvent(sessionId, sessionId, event));
  };
  const store = new ApprovalStore<unknown>();
  const turns = new Map<string, string>();
  const makeSession = (conversationId: string) => {
    const eventLog = new EventLog();
    turns.set(conversationId, `turn:${conversationId}`);
    return {
      conversationId, eventLog, rolloutStore: {}, abortController: new AbortController(),
      services: { toolApprovals: store },
      activeTurn: { unsafePeek: () => ({ turnId: turns.get(conversationId) }) },
      emit: (event: Parameters<EventLog["emit"]>[0]) => eventLog.emit(event),
      onBeforeDurableClose: () => () => {},
    } as unknown as Session;
  };
  const parent = makeSession(sessionId);
  const unpublish = parent.eventLog.subscribe(event => {
    const projected = daemonEventFromUnboundSessionEvent(event);
    if (projected !== null) publish(projected);
  });
  const unregister = broker.register(parent, { isActive: () => true, onEvent: publish });
  const child = makeSession("approval-child");
  registerChildApprovalSession(child, parent);
  const request = (owner: Session, callId: string, timeout: number) => requestApproval({
    ctx: {
      callId, toolName: "wait_agent", turnId: turns.get(owner.conversationId)!,
      invocation: {
        session: owner, callId, toolName: { name: "wait_agent" }, source: "direct",
        payload: { kind: "function", arguments: JSON.stringify({ timeout_ms: timeout }) },
        turn: { subId: turns.get(owner.conversationId), cwd: process.cwd(), sandboxPolicy: { value: "workspace_write" }, approvalPolicy: { value: "on_request" } },
      } as never,
    },
    args: { timeout_ms: timeout }, resolver: parent.services.approvalResolver!,
  });
  return { parent, child, tui, prompts, notifications, sentDecisions, request, publish,
    setSnapshot: (next: JsonObject) => { snapshot = next; },
    setTurn: (owner: Session, turnId: string) => { turns.set(owner.conversationId, turnId); },
    publishCompletion: (callId: string, turnId: string) => publish({
      id: `complete:${turnId}`, type: "tool_call_completed", turnId,
      payload: { callId, toolName: "wait_agent", result: "done", isError: false },
    }),
    failNextApproval: (failure: "before" | "after") => { nextApprovalFailure = failure; },
    replay: async (notification: JsonObject) => multiplexer.broadcastSessionNotification(sessionId, notification as never),
    close: async () => { unsubscribe(); unregister(); unpublish(); await transport.close(); await dispatcher.close(); },
  };
}

describe("TUI canonical approval occurrence settlement", () => {
  it.each([undefined, "approval-child"])("settles an untimed permission notification only within its invocation owner (%s)", async sourceConversationId => {
    const f = await connectedApprovals();
    try {
      const source = sourceConversationId === undefined ? {} : { sourceConversationId };
      f.publish({ id: "untimed-request", type: "request_permissions", payload: {
        requestId: "untimed-occurrence", callId: "shared-call", toolName: "wait_agent", permissions: [], ...source,
      } });
      f.publish({ id: "another-owner-request", type: "request_permissions", payload: {
        requestId: "another-owner-occurrence", callId: "shared-call", toolName: "wait_agent", permissions: [],
        sourceConversationId: "another-child",
      } });
      f.publish({ id: "newer-turn-request", type: "request_permissions", turnId: "newer-turn", payload: {
        requestId: "newer-turn-occurrence", callId: "shared-call", toolName: "wait_agent", permissions: [], ...source,
      } });
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(3);
      const notification = f.notifications.find(event => event.method === "event.permission_request" &&
        (event.params as JsonObject).requestId === "untimed-occurrence")!;
      expect(notification.params).not.toHaveProperty("turnId");
      f.publish({ id: "untimed-completion", type: "tool_call_completed", turnId: "completed-turn", payload: {
        callId: "shared-call", toolName: "wait_agent", result: "done", isError: false, ...source,
      } });
      await drainMicrotasks(30);
      expect(f.prompts.map(prompt => prompt.ctx.signal?.aborted)).toEqual([true, false, false]);
      await f.replay(notification);
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(3);
      expect(f.sentDecisions).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("retains a generic session request's envelope turn when its payload omits it", async () => {
    const f = await connectedApprovals();
    try {
      await f.replay({ jsonrpc: "2.0", method: "event.session_event", params: {
        sessionId: "approval-parent", eventId: "generic-permission-request", turnId: "current-turn",
        event: { id: "generic-permission-request", type: "request_permissions", payload: {
          callId: "generic-occurrence", toolCallId: "reused-call", toolName: "wait_agent", permissions: [],
        } },
      } });
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(1);
      f.publishCompletion("reused-call", "older-turn");
      await drainMicrotasks(30);
      expect(f.prompts[0]!.ctx.signal?.aborted).toBe(false);
      f.publishCompletion("reused-call", "current-turn");
      await drainMicrotasks(30);
      expect(f.prompts[0]!.ctx.signal?.aborted).toBe(true);
      expect(f.sentDecisions).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("preserves full snapshots for the captured daemon session and rejects another owner", async () => {
    const f = await connectedApprovals("local-conversation-alias");
    try {
      const snapshot = { sessionId: "approval-parent", nativeWorkers: [{ taskId: "native-worker" }] };
      f.setSnapshot(snapshot);
      await expect(f.tui.getDaemonSessionSnapshot!()).resolves.toEqual(snapshot);
      f.setSnapshot({ ...snapshot, sessionId: "another-session" });
      await expect(f.tui.getDaemonSessionSnapshot!()).rejects.toThrow("different session");
    } finally { await f.close(); }
  });

  it("does not dismiss a reused call ID when an older turn's completion is replayed", async () => {
    const f = await connectedApprovals();
    try {
      const first = f.request(f.parent, "reused-call", 180000);
      await drainMicrotasks(30);
      f.prompts[0]!.resolve(APPROVED_FOR_SESSION);
      await first;
      f.setTurn(f.parent, "next-parent-turn");
      const next = f.request(f.parent, "reused-call", 120000);
      await drainMicrotasks(30);
      f.publishCompletion("reused-call", "turn:approval-parent");
      await drainMicrotasks(30);
      expect(f.prompts[1]!.ctx.signal?.aborted).toBe(false);
      // Native completion puts turnId on the wire envelope, not payload.
      const terminal = f.notifications.find(event => event.method === "event.session_event" && (event.params as JsonObject).turnId === "turn:approval-parent")!;
      expect(((terminal.params as JsonObject).event as JsonObject).payload).not.toHaveProperty("turnId");
      f.publishCompletion("reused-call", "next-parent-turn");
      await drainMicrotasks(30);
      expect(f.prompts[1]!.ctx.signal?.aborted).toBe(true);
      f.parent.abortController.abort();
      await expect(next).resolves.toMatchObject({ decision: { kind: "abort" } });
      expect(f.sentDecisions).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not create another card when queued work arrives after approval-state closure", async () => {
    const approvals = new DaemonApprovalRequests(1000);
    const current = approvals.begin({ callId: "current", toolCallId: "call-1" })!;
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; }).then(() =>
      approvals.begin({ callId: "queued", toolCallId: "call-2" }));
    approvals.close();
    release();
    await expect(queued).resolves.toBeUndefined();
    expect(current.signal.aborted).toBe(true);
  });

  it.each(["before", "after"] as const)("replays failed delivery only when failure occurs %s canonical settlement", async (failure) => {
    const f = await connectedApprovals();
    try {
      const requested = f.request(f.parent, "retry-wait", 180000);
      await drainMicrotasks(30);
      f.failNextApproval(failure);
      f.prompts[0]!.resolve(APPROVED_FOR_SESSION);
      await drainMicrotasks(40);
      const notification = f.notifications.find(event => event.method === "event.permission_request")!;
      await f.replay(notification);
      await drainMicrotasks(30);
      if (failure === "before") {
        expect(f.prompts).toHaveLength(2);
        f.prompts[1]!.resolve(APPROVED_FOR_SESSION);
      } else {
        expect(f.prompts).toHaveLength(1);
      }
      await expect(requested).resolves.toMatchObject({ source: "resolver" });
      expect(f.sentDecisions).toHaveLength(failure === "before" ? 2 : 1);
    } finally { await f.close(); }
  });

  it.each(["parent", "child"] as const)("dismisses cached %s approvals and never reopens settled occurrences", async (ownerName) => {
    const f = await connectedApprovals();
    try {
      const owner = f[ownerName];
      const first = f.request(owner, "first-wait", 180000);
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(1);
      f.prompts[0]!.resolve(APPROVED_FOR_SESSION);
      await expect(first).resolves.toMatchObject({ source: "resolver" });

      const stillPending = f.request(owner, "different-wait", 120000);
      const cached = f.request(owner, "cached-wait", 180000);
      await expect(cached).resolves.toMatchObject({ source: "cache" });
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(3);
      expect(f.prompts[1]!.ctx.signal?.aborted).toBe(false);
      expect(f.prompts[2]!.ctx.signal?.aborted).toBe(true);
      expect(f.sentDecisions).toHaveLength(1);

      const cachedRequest = f.notifications.find(event => event.method === "event.permission_request" && (event.params as JsonObject).callId === "cached-wait")!;
      const cachedDecision = f.notifications.find(event => event.method === "event.session_event" && ((event.params as JsonObject).event as JsonObject).type === "permission_decision" && (((event.params as JsonObject).event as JsonObject).payload as JsonObject).callId === "cached-wait")!;
      await f.replay(cachedRequest);
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(3);

      // The same invocation may request another scope. An old occurrence's
      // decision cannot settle the new permission request even with equal callId.
      const newScope = f.request(owner, "cached-wait", 60000);
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(4);
      await f.replay(cachedDecision);
      expect(f.prompts[3]!.ctx.signal?.aborted).toBe(false);
      f.prompts[1]!.resolve(APPROVED_FOR_SESSION);
      f.prompts[3]!.resolve(APPROVED_FOR_SESSION);
      await Promise.all([stillPending, newScope]);
      expect(f.sentDecisions).toHaveLength(3);
    } finally { await f.close(); }
  });

  it("uses tool completion as a fallback without dismissing another owner's same call ID", async () => {
    const f = await connectedApprovals();
    try {
      const parentRequest = f.request(f.parent, "shared-call", 180000);
      const childRequest = f.request(f.child, "shared-call", 120000);
      await drainMicrotasks(30);
      expect(f.prompts).toHaveLength(2);
      f.parent.emit({ id: "shared-call-complete", msg: {
        type: "tool_call_completed", payload: { callId: "shared-call", toolName: "wait_agent", result: "done", isError: false },
      } });
      await drainMicrotasks(30);
      expect(f.prompts[0]!.ctx.signal?.aborted).toBe(true);
      expect(f.prompts[1]!.ctx.signal?.aborted).toBe(false);
      const parentNotification = f.notifications.find(event => event.method === "event.permission_request" && !(event.params as JsonObject).sourceConversationId)!;
      await f.replay(parentNotification);
      expect(f.prompts).toHaveLength(2);
      f.prompts[1]!.resolve(APPROVED_FOR_SESSION);
      await expect(childRequest).resolves.toMatchObject({ source: "resolver" });
      expect(f.sentDecisions).toHaveLength(1);
      // The injected completion represents a missed server-side settlement;
      // close the structural broker's outstanding request during fixture teardown.
      f.parent.abortController.abort();
      await expect(parentRequest).resolves.toMatchObject({ decision: { kind: "abort" } });
    } finally { await f.close(); }
  });
});
