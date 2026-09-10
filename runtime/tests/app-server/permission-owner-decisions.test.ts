import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { registerChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(workflow = false) {
  const owner = approvalSession("conv-owner");
  const child = approvalSession("conv-child");
  const broker = new LiveApprovalBroker();
  cleanups.push(() => owner.shutdown(), () => child.shutdown());
  cleanups.push(broker.register(owner, { workflow, isActive: () => true }));
  registerChildApprovalSession(child, owner);
  const sessions = new AgenCDaemonSessionManager({ createSessionId: () => "daemon-permission-session" });
  const setAgentPermissionMode = vi.fn(async () => ({ applied: true, previousMode: "default", rollback: vi.fn(async () => {}) }));
  const manager = new AgenCDaemonAgentManager({
    approvalBroker: broker,
    sessionManager: sessions,
    runner: {
      startAgent: async () => ({ agentId: owner.conversationId, agentPath: "/root", startedAt: new Date().toISOString(), status: "running" }),
      listPermissions: async (agentId) => ({ permissions: [], pendingRequests: broker.list(agentId) }),
      resolveToolDecision: async (agentId, params) => broker.resolve(agentId, params.requestId, params.decision),
      setAgentPermissionMode,
    },
  });
  await manager.createAgent({ objective: "Review a child request", cwd: "/tmp", runtimeOptions: resolveAgentRuntimeOptions({}) });
  await sessions.restoreSession({ sessionId: owner.conversationId, agentId: "agent_default", status: "waiting", metadata: { recovered: true } });
  const waiting = requestApproval({
    ctx: {
      callId: "child-call", toolName: "exec_command", turnId: "child-turn",
      invocation: { callId: "child-call", session: child, payload: { kind: "function", name: "exec_command", arguments: '{"cmd":"node --test"}' }, turn: { subId: "child-turn", cwd: "/tmp" } } as never,
    },
    resolver: owner.services.approvalResolver,
    args: { cmd: "node --test" },
  });
  await vi.waitFor(() => expect(broker.list(owner.conversationId)).toHaveLength(1));
  const requestId = broker.list(owner.conversationId)[0]!.requestId;
  return { owner, child, manager, broker, sessions, waiting, requestId, setAgentPermissionMode };
}

function approvalSession(conversationId: string): Session {
  const eventLog = new EventLog();
  let sequence = 0;
  let stopped = false;
  return {
    conversationId,
    eventLog,
    abortController: new AbortController(),
    services: { admissionRequired: false },
    rolloutStore: {},
    permissionModeRegistry: new PermissionModeRegistry(createEmptyToolPermissionContext()),
    onBeforeDurableClose: () => () => {},
    emit: (event: Parameters<EventLog["emit"]>[0]) => {
      const canonical = { ...event, eventId: `${conversationId}:${++sequence}`, seq: sequence };
      eventLog.emit(canonical);
      return canonical;
    },
    markStoppedByUser: () => { stopped = true; },
    get stoppedByUserSinceLastPrompt() { return stopped; },
    shutdown: async () => {},
  } as unknown as Session;
}

describe("permission owner decisions", () => {
  it.each(["canonical", "lifecycle"])("approves a child request using its %s owner ID", async (identifier) => {
    const state = await fixture();
    const sessionId = identifier === "canonical" ? state.owner.conversationId : "daemon-permission-session";
    expect((await state.manager.listPermissions({ sessionId })).pendingRequests?.[0]?.requestId).toBe(state.requestId);
    await state.manager.approveTool({ sessionId, requestId: state.requestId, scope: "session", allowAllToolsForSession: true });
    expect((await state.waiting).decision.kind).toBe("approved_for_session");
    expect(state.setAgentPermissionMode).toHaveBeenCalledWith(state.owner.conversationId, expect.objectContaining({ sessionId: "daemon-permission-session", mode: "bypassPermissions" }));
    await expect(state.manager.approveTool({ sessionId, requestId: state.requestId })).rejects.toThrow("not pending");
  });

  it.each([false, true])("preserves denial feedback and fences only ordinary owners (workflow=%s)", async (workflow) => {
    const state = await fixture(workflow);
    const reason = "Do not commit.\nExplain the changes instead.";
    await state.manager.denyTool({ sessionId: state.owner.conversationId, requestId: state.requestId, reason });
    expect(await state.waiting).toMatchObject({ decision: { kind: "denied", reason }, source: "resolver", reason });
    expect(state.owner.stoppedByUserSinceLastPrompt).toBe(!workflow);
    expect(state.owner.abortController.signal.aborted).toBe(false);
  });

  it("rejects a closed canonical owner without using its recovered shadow", async () => {
    const state = await fixture();
    await state.sessions.terminateSession({ sessionId: "daemon-permission-session" });
    await expect(state.manager.denyTool({ sessionId: state.owner.conversationId, requestId: state.requestId })).rejects.toThrow("not found or closed");
    expect(state.broker.list(state.owner.conversationId)).toHaveLength(1);
    expect(state.owner.stoppedByUserSinceLastPrompt).toBe(false);
  });

  it("rejects a request from another owner without latching a stop", async () => {
    const state = await fixture();
    await expect(state.manager.denyTool({ sessionId: "daemon-permission-session", requestId: "other-owner-request" })).rejects.toThrow("not pending");
    expect(state.broker.list(state.owner.conversationId)).toHaveLength(1);
    expect(state.owner.stoppedByUserSinceLastPrompt).toBe(false);
  });

  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)("rolls back stale session promotion from %s", async (previousMode) => {
    const state = await fixture();
    const rollback = vi.fn(async () => {});
    state.setAgentPermissionMode.mockImplementation(async () => {
      state.broker.abort(state.owner.conversationId);
      return { applied: true, previousMode, rollback };
    });
    await expect(state.manager.approveTool({ sessionId: state.owner.conversationId, requestId: state.requestId, scope: "session", allowAllToolsForSession: true })).rejects.toThrow("not pending");
    expect(rollback).toHaveBeenCalledOnce();
    expect((await state.waiting).decision.kind).toBe("abort");
    expect(state.owner.stoppedByUserSinceLastPrompt).toBe(false);
  });

  it.each([undefined, "", "  ", "Keep this unchanged.\nUse another approach."])("retains optional denial feedback %j", async (reason) => {
    const state = await fixture();
    await state.manager.denyTool({ sessionId: "daemon-permission-session", requestId: state.requestId, ...(reason === undefined ? {} : { reason }) });
    const result = await state.waiting;
    expect(result.decision).toEqual(reason?.trim() ? { kind: "denied", reason } : { kind: "denied" });
    expect(result.reason).toBe(reason?.trim() || undefined);
  });
});
