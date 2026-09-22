import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import type { BackgroundAgentDaemonEvent } from "../../src/app-server/background-agent-runner/shared.js";

// A client renders a forwarded child approval on the parent's session. It
// must be able to say which sub-agent is asking, including a nested one the
// parent never saw spawn, without walking the child's own event stream.

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sessionFixture(
  conversationId: string,
  spawn?: { readonly parent: string; readonly nickname: string; readonly path: string },
): Session {
  const eventLog = new EventLog();
  const closeListeners = new Set<() => void | Promise<void>>();
  let sequence = 0;
  const session = {
    conversationId,
    eventLog,
    abortController: new AbortController(),
    permissionModeRegistry: new PermissionModeRegistry({
      mode: "default", additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    }),
    services: { admissionRequired: false },
    rolloutStore: {},
    sessionConfiguration: spawn === undefined ? {} : {
      sessionSource: {
        kind: "subagent",
        source: {
          kind: "thread_spawn",
          parentThreadId: spawn.parent,
          depth: spawn.path.split("/").length - 2,
          agentPath: spawn.path,
          agentNickname: spawn.nickname,
        },
      },
    },
    userStops: 0,
    markStoppedByUser: () => { (session as unknown as { userStops: number }).userStops += 1; },
    emit: (event: Parameters<EventLog["emit"]>[0]) => {
      const canonical = { ...event, eventId: `${conversationId}:${++sequence}`, seq: sequence };
      eventLog.emit(canonical);
      return canonical;
    },
    onBeforeDurableClose: (listener: () => void | Promise<void>) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    shutdown: async () => {
      session.abortController.abort();
      for (const listener of closeListeners) await listener();
    },
  } as unknown as Session;
  cleanups.push(() => session.shutdown());
  return session;
}

function ask(owner: Session, requesting: Session, command: string) {
  const ctx: ApprovalCtx = {
    callId: "call_1", toolName: "exec_command", turnId: `sub-${requesting.conversationId}-0`,
    invocation: {
      callId: "call_1", session: requesting,
      payload: { kind: "function", name: "exec_command", arguments: JSON.stringify({ cmd: command }) },
      turn: { subId: `sub-${requesting.conversationId}-0` },
    } as ApprovalCtx["invocation"],
  };
  return requestApproval({ ctx, resolver: owner.services.approvalResolver, args: { command } });
}

describe("forwarded child approval attribution", () => {
  it("names the requesting sub-agent on the forwarded request, its decision and the pending listing", async () => {
    const broker = new LiveApprovalBroker();
    const parent = sessionFixture("conv-parent");
    const events: BackgroundAgentDaemonEvent[] = [];
    cleanups.push(broker.register(parent, { isActive: () => true, onEvent: (event) => events.push(event) }));
    const child = sessionFixture("child-1", { parent: "conv-parent", nickname: "Braindance", path: "/root/echo_probe" });
    registerChildApprovalSession(child, parent);
    const grandchild = sessionFixture("grandchild-1", { parent: "child-1", nickname: "Ghost", path: "/root/echo_probe/inner" });
    registerChildApprovalSession(grandchild, child);

    const childDecision = ask(parent, child, "echo SUBAGENT_OK");
    const nestedDecision = ask(parent, grandchild, "echo NESTED_OK");
    await Promise.resolve();

    const requests = events.filter((event) => event.type === "request_permissions");
    expect(requests).toHaveLength(2);
    const [childRequest, nestedRequest] = requests.map((event) =>
      notificationFromDaemonEvent("conv-parent", "conv-parent", event).params as Record<string, unknown>);
    expect(childRequest).toMatchObject({
      sessionId: "conv-parent",
      turnId: "sub-child-1-0",
      sourceConversationId: "child-1",
      sourceAgentNickname: "Braindance",
      sourceAgentPath: "/root/echo_probe",
    });
    expect(nestedRequest).toMatchObject({
      sourceConversationId: "grandchild-1",
      sourceAgentNickname: "Ghost",
      sourceAgentPath: "/root/echo_probe/inner",
    });

    // A client that reconnects mid-approval rebuilds the card from the listing.
    expect(broker.list("conv-parent")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "child-1", sourceAgentNickname: "Braindance", sourceAgentPath: "/root/echo_probe" }),
      expect.objectContaining({ sessionId: "grandchild-1", sourceAgentNickname: "Ghost", sourceAgentPath: "/root/echo_probe/inner" }),
    ]));

    const childRequestId = String(childRequest!.requestId);
    expect(broker.resolve("conv-parent", childRequestId, { kind: "denied" })).toBe(true);
    expect((await childDecision).decision.kind).toBe("denied");
    broker.abort("conv-parent");
    expect((await nestedDecision).decision.kind).toBe("abort");

    // Each decision is forwarded under the same occurrence id so a client can
    // retire the card it raised, including after a Stop.
    const decisions = events
      .filter((event) => event.type === "permission_decision")
      .map((event) => event.payload as Record<string, unknown>);
    expect(decisions.map((payload) => [payload.requestId, payload.sourceConversationId, payload.sourceAgentNickname])).toEqual([
      [childRequestId, "child-1", "Braindance"],
      [String(nestedRequest!.requestId), "grandchild-1", "Ghost"],
    ]);
  });

  it("omits attribution for a session that was not spawned as a sub-agent", async () => {
    const broker = new LiveApprovalBroker();
    const parent = sessionFixture("conv-parent-2");
    const events: BackgroundAgentDaemonEvent[] = [];
    cleanups.push(broker.register(parent, { isActive: () => true, onEvent: (event) => events.push(event) }));
    const child = sessionFixture("delegate-1");
    registerChildApprovalSession(child, parent);
    const decision = ask(parent, child, "true");
    await Promise.resolve();
    const params = notificationFromDaemonEvent("conv-parent-2", "conv-parent-2", events[0]!).params as Record<string, unknown>;
    expect(params.sourceConversationId).toBe("delegate-1");
    expect(params).not.toHaveProperty("sourceAgentNickname");
    expect(params).not.toHaveProperty("sourceAgentPath");
    broker.abort("conv-parent-2");
    await decision;
  });

  it.each([
    ["refuses delivery", () => false],
    ["fails to emit", () => Promise.reject(new Error("client stream closed"))],
  ] as const)("fails a forwarded child request visibly when the owner %s instead of leaving it pending", async (_label, deliver) => {
    const broker = new LiveApprovalBroker();
    const parent = sessionFixture("conv-parent-3");
    cleanups.push(broker.register(parent, {
      isActive: () => true,
      onEvent: (event) => event.type === "request_permissions" ? deliver() : undefined,
    }));
    const child = sessionFixture("child-3", { parent: "conv-parent-3", nickname: "Braindance", path: "/root/echo_probe" });
    registerChildApprovalSession(child, parent);
    const decision = await Promise.race([
      ask(parent, child, "echo SUBAGENT_OK").then((result) => result.decision),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(decision).toMatchObject({ kind: "denied", reason: expect.stringMatching(/could not be shown/) });
    expect(broker.list("conv-parent-3")).toEqual([]);
    expect(parent.abortController.signal.aborted).toBe(false);
  });

  it("a person denying a sub-agent's request stops that sub-agent, not its parent", async () => {
    const broker = new LiveApprovalBroker();
    const parent = sessionFixture("conv-parent-4");
    const events: BackgroundAgentDaemonEvent[] = [];
    cleanups.push(broker.register(parent, { isActive: () => true, onEvent: (event) => events.push(event) }));
    const child = sessionFixture("child-4", { parent: "conv-parent-4", nickname: "Braindance", path: "/root/echo_probe" });
    registerChildApprovalSession(child, parent);
    const userStops = (session: Session) => (session as unknown as { userStops: number }).userStops;

    const childDecision = ask(parent, child, "echo SUBAGENT_OK");
    await Promise.resolve();
    const childRequestId = String(events[0]!.payload!.requestId);
    expect(broker.resolve("conv-parent-4", childRequestId, { kind: "denied" })).toBe(true);
    // Still the person's decision for the child: its own turn ends as their stop.
    expect((await childDecision).decision).toMatchObject({ kind: "denied", decidedBy: "user" });
    // A stop latched on the parent would hold back the follow-up turn that the
    // child's report starts after the parent's turn has ended.
    expect(userStops(parent)).toBe(0);

    const ownDecision = ask(parent, parent, "rm -rf build");
    await Promise.resolve();
    const own = broker.list("conv-parent-4")[0]!;
    expect(broker.resolve("conv-parent-4", own.requestId, { kind: "denied" })).toBe(true);
    expect((await ownDecision).decision).toMatchObject({ kind: "denied", decidedBy: "user" });
    expect(userStops(parent)).toBe(1);
  });
});
