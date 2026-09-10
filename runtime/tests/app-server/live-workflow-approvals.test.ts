import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { requestApproval } from "../../src/permissions/guardian/arbiter.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { registerChildApprovalSession, revokeChildApprovalSession } from "../../src/agents/child-approval-context.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { createWorkflowSessionSeams, recordWorkflowChildTerminal } from "../../src/app-server/workflow/session-adapters.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import type { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { isWorkflowApprovalSession } from "../../src/permissions/approval-failure.js";
import { approvalResponseKey } from "../../src/permissions/approval-response-key.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sessionFixture(conversationId: string): Session {
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

function context(session: Session, callId = "call_1", signal?: AbortSignal): ApprovalCtx {
  return {
    callId, toolName: "Write", turnId: "turn_1", signal,
    invocation: {
      callId, session,
      payload: { kind: "function", name: "Write", arguments: '{"file_path":"result.txt","content":"approved"}' },
      turn: { subId: "turn_1" },
    } as ApprovalCtx["invocation"],
  };
}

function ask(owner: Session, requesting: Session, callId = "call_1", signal?: AbortSignal) {
  const ctx = context(requesting, callId, signal);
  return requestApproval({
    ctx: { ...ctx, toolName: "exec_command" },
    resolver: owner.services.approvalResolver,
    args: { command: "node --test" },
  });
}

describe("live workflow approvals", () => {
  it.each([false, true])("separates sequential scopes without changing response routing (workflow=%s)", async (workflow) => {
    const broker = new LiveApprovalBroker();
    const owner = sessionFixture("scope-owner");
    cleanups.push(broker.register(owner, { workflow, isActive: () => true }));
    const first = ask(owner, owner, "same-call");
    await Promise.resolve();
    const firstPending = broker.list(owner.conversationId)[0]!;
    const responseKey = broker.pending(owner.conversationId, firstPending.requestId)!.responseKey;
    expect(responseKey).toBe(approvalResponseKey(owner, "same-call"));
    expect(firstPending.requestId).not.toBe("same-call");
    expect(broker.resolve(owner.conversationId, firstPending.requestId, { kind: "approved" })).toBe(true);
    expect((await first).decision.kind).toBe("approved");

    const second = requestApproval({
      ctx: { ...context(owner, "same-call"), toolName: "exec_command" },
      resolver: owner.services.approvalResolver,
      args: { command: "git status", network: ["new.example"] },
    });
    await Promise.resolve();
    const secondPending = broker.list(owner.conversationId)[0]!;
    expect(secondPending.requestId).not.toBe(firstPending.requestId);
    expect(broker.pending(owner.conversationId, secondPending.requestId)!.responseKey).toBe(responseKey);
    expect(broker.resolve(owner.conversationId, firstPending.requestId, { kind: "approved" })).toBe(false);
    expect(broker.resolve(owner.conversationId, "same-call", { kind: "approved" })).toBe(false);
    expect(broker.list(owner.conversationId)).toHaveLength(1);
    expect(broker.resolve(owner.conversationId, secondPending.requestId, { kind: "denied" })).toBe(true);
    expect((await second).decision.kind).toBe("denied");
    expect(approvalResponseKey(owner, "same-call")).toBe("same-call");
  });

  it("installs the resolver at workflow bootstrap and resumes exactly one accepted action through lifecycle RPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-live-approval-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const driver = openStateDatabases({ cwd: directory, agencHome: join(directory, "home") });
    cleanups.push(() => driver.close());
    const repo = new StateRunDurabilityRepository(driver);
    const owner = sessionFixture("workflow-owner");
    const broker = new LiveApprovalBroker();
    const seams = createWorkflowSessionSeams({
      agencHome: join(directory, "home"), env: {}, argv: ["node", "agenc"],
      kernel: {} as ExecutionAdmissionKernel, durability: () => repo,
      resolveRunRepoPath: () => directory, resolveRunPolicy: () => undefined,
      fallbackCwd: directory, warn: () => {}, approvalBroker: broker,
      bootstrap: async () => ({ session: owner, rolloutStore: { runEpoch: 1 }, shutdown: async () => {} }) as never,
    });
    cleanups.push(() => seams.close());
    await seams.journal.open(owner.conversationId, { repoPath: directory, policy: { permissionMode: "default" } });
    expect(owner.services.approvalResolver?.request).toEqual(expect.any(Function));
    const child = sessionFixture("workflow-child");
    registerChildApprovalSession(child, owner);
    let executions = 0;
    const action = ask(owner, child).then((result) => {
      if (result.decision.kind === "approved") {
        executions += 1;
        writeFileSync(join(directory, "result.txt"), "approved");
      }
      return result;
    });
    await Promise.resolve();
    const firstClient = new AgenCDaemonAgentManager({ approvalBroker: broker });
    const listing = await firstClient.listPermissions({ sessionId: owner.conversationId });
    expect(listing.pendingRequests).toHaveLength(1);
    expect(executions).toBe(0);
    const pending = listing.pendingRequests![0]!;
    expect(pending).toMatchObject({ ownerRunId: owner.conversationId, sessionId: child.conversationId, toolName: "exec_command" });
    const reconnectedClient = new AgenCDaemonAgentManager({ approvalBroker: broker });
    await reconnectedClient.approveTool({ sessionId: owner.conversationId, requestId: pending.requestId });
    expect((await action).decision.kind).toBe("approved");
    expect(executions).toBe(1);
    expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe("approved");
    expect(broker.list(owner.conversationId)).toEqual([]);
    await expect(reconnectedClient.approveTool({ sessionId: owner.conversationId, requestId: pending.requestId })).rejects.toThrow("not pending");
  });

  it("isolates colliding call IDs across two owners and sibling children", async () => {
    const broker = new LiveApprovalBroker();
    const first = sessionFixture("first");
    const second = sessionFixture("second");
    cleanups.push(broker.register(first, { workflow: true, isActive: () => true }));
    cleanups.push(broker.register(second, { workflow: true, isActive: () => true }));
    const firstChild = sessionFixture("first-child");
    const sibling = sessionFixture("sibling");
    const secondChild = sessionFixture("second-child");
    registerChildApprovalSession(firstChild, first);
    registerChildApprovalSession(sibling, first);
    registerChildApprovalSession(secondChild, second);
    const promises = [ask(first, firstChild), ask(first, sibling), ask(second, secondChild)];
    await Promise.resolve();
    const firstRequests = broker.list("first");
    const secondRequest = broker.list("second")[0]!;
    expect(new Set([...firstRequests, secondRequest].map((pending) => pending.requestId)).size).toBe(3);
    expect(broker.resolve("second", firstRequests[0]!.requestId, { kind: "approved" })).toBe(false);
    expect(broker.resolve("first", firstRequests[0]!.requestId, { kind: "approved" })).toBe(true);
    expect(broker.resolve("first", firstRequests[1]!.requestId, { kind: "denied" })).toBe(true);
    expect(broker.list("second")).toHaveLength(1);
    broker.abort("second");
    expect((await Promise.all(promises)).map((result) => result.decision.kind)).toEqual(["approved", "denied", "abort"]);
  });

  it("rejects forged child ownership and revoked ancestor decisions", async () => {
    const broker = new LiveApprovalBroker();
    const owner = sessionFixture("owner");
    cleanups.push(broker.register(owner, { workflow: true, isActive: () => true }));
    expect((await ask(owner, sessionFixture("forged"))).decision.kind).toBe("denied");
    const parent = sessionFixture("intermediate");
    const child = sessionFixture("grandchild");
    registerChildApprovalSession(parent, owner);
    registerChildApprovalSession(child, parent);
    const waiting = ask(owner, child);
    await Promise.resolve();
    const pending = broker.list("owner")[0]!;
    revokeChildApprovalSession(parent);
    expect((await waiting).decision.kind).toBe("abort");
    expect(broker.resolve("owner", pending.requestId, { kind: "approved" })).toBe(false);
  });

  it("aborts queued approvals on turn cancellation and owner unregister without retaining a restart continuation", async () => {
    const broker = new LiveApprovalBroker();
    const owner = sessionFixture("owner");
    const unregister = broker.register(owner, { workflow: true, isActive: () => true });
    const cancellation = new AbortController();
    const waiting = ask(owner, owner, "cancel-me", cancellation.signal);
    await Promise.resolve();
    cancellation.abort();
    expect((await waiting).decision.kind).toBe("abort");
    const second = ask(owner, owner, "close-me");
    await Promise.resolve();
    const oldRequest = broker.list("owner")[0]!.requestId;
    unregister();
    expect((await second).decision.kind).toBe("abort");
    expect(broker.hasPending("owner")).toBe(false);
    expect(isWorkflowApprovalSession(owner)).toBe(false);
    const replacement = new LiveApprovalBroker();
    expect(replacement.resolve("owner", oldRequest, { kind: "approved" })).toBe(false);
  });

  it("times out without approving or leaking a pending request", async () => {
    const broker = new LiveApprovalBroker();
    const owner = sessionFixture("owner");
    cleanups.push(broker.register(owner, { workflow: true, isActive: () => true, timeoutMs: 5 }));
    expect((await ask(owner, owner)).decision.kind).toBe("timed_out");
    expect(broker.list("owner")).toEqual([]);
  });

  it("preserves scoped approvals and refuses permission-mode promotion", async () => {
    const broker = new LiveApprovalBroker();
    const owner = sessionFixture("owner");
    cleanups.push(broker.register(owner, { workflow: true, isActive: () => true }));
    const child = sessionFixture("child");
    registerChildApprovalSession(child, owner);
    const waiting = ask(owner, child);
    await Promise.resolve();
    const requestId = broker.list("owner")[0]!.requestId;
    const manager = new AgenCDaemonAgentManager({ approvalBroker: broker });
    await expect(manager.approveTool({ sessionId: "owner", requestId, scope: "session", allowAllToolsForSession: true })).rejects.toThrow("frozen");
    expect(broker.list("owner")).toHaveLength(1);
    await manager.approveTool({ sessionId: "owner", requestId, scope: "session" });
    expect((await waiting).decision.kind).toBe("approved_for_session");
    expect(owner.permissionModeRegistry.current().mode).toBe("default");
    expect(child.permissionModeRegistry.current().mode).toBe("default");
  });

  it("preserves typed permanent child failure during cold terminal adoption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agenc-approval-terminal-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const databaseOptions = { cwd: directory, agencHome: join(directory, "home") };
    let driver: StateSqliteDriver = openStateDatabases(databaseOptions);
    cleanups.push(() => driver.close());
    recordWorkflowChildTerminal(new StateRunDurabilityRepository(driver), "owner:implement#1", {
      status: "failed", stopReason: "approval_required", finalMessage: "No approver", usage: null,
    });
    driver.close();
    driver = openStateDatabases(databaseOptions);
    const repo = new StateRunDurabilityRepository(driver);
    const seams = createWorkflowSessionSeams({
      agencHome: databaseOptions.agencHome, env: {}, argv: [], kernel: {} as ExecutionAdmissionKernel,
      durability: () => repo, resolveRunRepoPath: () => directory, resolveRunPolicy: () => undefined,
      fallbackCwd: directory, warn: () => {},
    });
    expect(await seams.spawner.inspect("owner:implement#1")).toMatchObject({ state: "terminal", outcome: { status: "failed", stopReason: "approval_required" } });
    expect(await seams.spawner.inspect("owner:implement#2")).toEqual({ state: "unknown" });
  });
});
