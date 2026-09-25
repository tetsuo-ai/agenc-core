import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import type { AgentStatus } from "../../../src/agents/status.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import { backgroundTaskLifecycleForSession, registerAgentThreadTask } from "../../../src/tasks/index.js";
import { mkSession } from "../../fixtures.js";

const mockDelegate = vi.mocked(delegate);
afterEach(() => vi.restoreAllMocks());

function fixture(preRegistered: boolean) {
  const { session, events } = mkSession();
  // Spawned agents belong to the lifecycle of the session that spawned them.
  const backgroundTaskLifecycle = backgroundTaskLifecycleForSession(session);
  const id = randomUUID();
  const status = new BehaviorSubject<AgentStatus>({ status: "running", turnId: "initial", startedAtMs: 1 });
  const thread = {
    threadId: id,
    taskPrompt: "inspect fixture",
    live: { agentId: id, agentPath: `/root/worker_${id.replaceAll("-", "")}`, role: { name: "default" }, status },
    join: () => new Promise<never>(() => {}),
  };
  if (preRegistered) registerAgentThreadTask(backgroundTaskLifecycle, thread, { progressIntervalMs: 0 });
  const ownerDispose = vi.fn();
  const subscribeOwner = session.agentStatus.subscribe.bind(session.agentStatus);
  vi.spyOn(session.agentStatus, "subscribe").mockImplementation(listener => {
    const unsubscribe = subscribeOwner(listener);
    return () => { ownerDispose(); unsubscribe(); };
  });
  const taskDispose = vi.fn();
  const subscribeTask = backgroundTaskLifecycle.subscribe.bind(backgroundTaskLifecycle);
  vi.spyOn(backgroundTaskLifecycle, "subscribe").mockImplementation((taskId, listener) => {
    const unsubscribe = subscribeTask(taskId, listener);
    return () => { taskDispose(); unsubscribe(); };
  });
  const opts = {
    getSession: () => session,
    workspace: session.roleWorkspace,
    roleCatalog: new AgentRoleCatalog(session.roleWorkspace),
    ensureAgentControl: () => ({
      control: { roleWorkspace: session.roleWorkspace, assertRoleWorkspace: () => {} }, registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  mockDelegate.mockResolvedValue({ kind: "async_launched", thread: thread as never });
  const invoke = () => createSpawnAgentTool(opts).execute({ message: "inspect fixture", task_name: "worker" });
  const progress = (n: number) => {
    backgroundTaskLifecycle.updateAgentProgress(id, { toolUseCount: n, tokenCount: n });
    status.next({ status: "running", turnId: `turn-${n}`, startedAtMs: n });
  };
  const statuses = () => events.filter(event => event.msg.type === "collab_agent_status");
  return { session, events, id, status, thread, invoke, progress, statuses, ownerDispose, taskDispose, backgroundTaskLifecycle };
}

describe("spawn task status ownership", () => {
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ] as const)("releases status forwarding on real owner close (preRegistered=%s, failedFinalizer=%s)", async (preRegistered, failedFinalizer) => {
    const f = fixture(preRegistered);
    const failure = new Error("durable finalizer failed");
    if (failedFinalizer) f.session.onBeforeDurableClose(() => { throw failure; });
    try {
      const result = await f.invoke();
      expect(result.isError, result.content).not.toBe(true);
      f.progress(1);
      expect(f.statuses().at(-1)?.msg).toMatchObject({ type: "collab_agent_status", payload: { threadId: f.id, status: "running" } });
      if (failedFinalizer) await expect(f.session.shutdown()).rejects.toBe(failure);
      else await expect(f.session.shutdown()).resolves.toBeUndefined();
      expect(f.ownerDispose).toHaveBeenCalledOnce();
      expect(f.taskDispose).toHaveBeenCalledOnce();
      const closedCount = f.statuses().length;
      expect(() => f.progress(2)).not.toThrow();
      expect(() => f.status.next({ status: "shutdown" })).not.toThrow();
      expect(f.statuses()).toHaveLength(closedCount);
      expect(f.backgroundTaskLifecycle.get(f.id)?.status).toBe("killed");
      expect(() => f.session.emit({ id: "late", msg: { type: "warning", payload: { cause: "test", message: "late" } } })).toThrow("canonical run journal is sealed");
    } finally {
      f.status.next({ status: "shutdown" });
      if (!f.session.isShuttingDown) await f.session.shutdown();
    }
  });

  it.each([false, true])("keeps normal pre-close terminal status (preRegistered=%s)", async (preRegistered) => {
    const f = fixture(preRegistered);
    try {
      expect((await f.invoke()).isError).not.toBe(true);
      f.status.next({ status: "errored", turnId: "initial", endedAtMs: 2, error: "provider dispatch failed" });
      expect(f.statuses().at(-1)?.msg).toMatchObject({
        type: "collab_agent_status", payload: { threadId: f.id, status: "failed", error: "provider dispatch failed" },
      });
    } finally { await f.session.shutdown(); }
  });

  it("disposes subscriptions returned after synchronous owner closure", async () => {
    const f = fixture(true);
    const removeCloseHook = vi.fn();
    vi.spyOn(f.session, "onBeforeDurableClose").mockImplementation(close => {
      f.session.beginShutdown();
      void close();
      return removeCloseHook;
    });
    try {
      expect((await f.invoke()).isError).not.toBe(true);
      expect(removeCloseHook).toHaveBeenCalledOnce();
      expect(f.ownerDispose).toHaveBeenCalledOnce();
      expect(f.taskDispose).toHaveBeenCalledOnce();
      expect(f.statuses()).toHaveLength(0);
    } finally { f.status.next({ status: "shutdown" }); await f.session.shutdown(); }
  });

  it("does not retain an observer if the owner closes before delegate returns", async () => {
    const f = fixture(true);
    mockDelegate.mockImplementationOnce(async () => {
      await f.session.shutdown();
      return { kind: "async_launched", thread: f.thread as never };
    });
    try {
      await expect(f.invoke()).rejects.toThrow("canonical run journal is sealed");
      expect(f.ownerDispose).not.toHaveBeenCalled();
      expect(f.taskDispose).toHaveBeenCalledOnce();
      expect(f.statuses()).toHaveLength(0);
    } finally { f.status.next({ status: "shutdown" }); }
  });

  it("preserves a live projection error and releases setup subscriptions", async () => {
    const f = fixture(true);
    const failure = new Error("live journal write failed");
    const emit = f.session.emit.bind(f.session);
    vi.spyOn(f.session, "emit").mockImplementation(event => {
      if (event.msg.type === "collab_agent_status") throw failure;
      return emit(event);
    });
    try {
      await expect(f.invoke()).rejects.toBe(failure);
      expect(f.ownerDispose).toHaveBeenCalledOnce();
      expect(f.taskDispose).toHaveBeenCalledOnce();
      expect(() => f.progress(3)).not.toThrow();
    } finally { f.status.next({ status: "shutdown" }); await f.session.shutdown(); }
  });

  it("releases owner listeners when a later terminal projection throws", async () => {
    const f = fixture(true);
    const failure = new Error("terminal journal write failed");
    try {
      expect((await f.invoke()).isError).not.toBe(true);
      const emit = f.session.emit.bind(f.session);
      vi.spyOn(f.session, "emit").mockImplementation(event => {
        if (event.msg.type === "collab_agent_status" && event.msg.payload.status === "failed") throw failure;
        return emit(event);
      });
      expect(() => f.backgroundTaskLifecycle.fail(f.id, "worker failed")).toThrow(failure);
      expect(f.ownerDispose).toHaveBeenCalledOnce();
      expect(f.taskDispose).toHaveBeenCalled();
      expect(() => f.progress(4)).not.toThrow();
    } finally { f.status.next({ status: "shutdown" }); await f.session.shutdown(); }
  });

  it("does not install projection resources for a rejected spawn", async () => {
    const f = fixture(false);
    const registerClose = vi.spyOn(f.session, "onBeforeDurableClose");
    mockDelegate.mockResolvedValueOnce({ kind: "rejected", reason: "capacity full" });
    try {
      expect((await f.invoke()).isError).toBe(true);
      expect(registerClose).not.toHaveBeenCalled();
      expect(f.session.agentStatus.subscribe).not.toHaveBeenCalled();
    } finally { await f.session.shutdown(); }
  });
});
