import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNativeWorkerSnapshot } from "../../src/app-server/protocol/index.js";
import type { LocalAgentTaskState, LocalShellTaskState } from "../../src/tasks/types.js";
import { getDefaultAppState } from "../../src/tui/state/AppStateStore.js";
import { startDaemonWorkerTaskPolling } from "../../src/tui/state/daemonWorkerTasks.js";
import { syncCollabAgentEventToAppState } from "../../src/tui/state/collabAgentTaskSync.js";
import { formatTaskElapsed } from "../../src/tui/workbench/agents/activity.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";

const worker: SessionNativeWorkerSnapshot = {
  agentId: "worker-one", agentPath: "/root/backend", nickname: "backend", role: "default",
  status: "idle", prompt: "Implement the server", toolUseCount: 5, tokenCount: 900,
};
const snapshot = (nativeWorkers: readonly SessionNativeWorkerSnapshot[] = [worker]) => ({
  sessionId: "daemon-alias", turnCount: 2,
  tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }, nativeWorkers,
});
function fixture(initialWorkers: readonly SessionNativeWorkerSnapshot[] = [worker]) {
  vi.useFakeTimers();
  let state = getDefaultAppState();
  const local: LocalShellTaskState = {
    id: "local-shell", type: "local_bash", command: "local", description: "local", startTime: 1,
    status: "running", notified: false, outputFile: "", outputOffset: 0,
  };
  state = { ...state, tasks: { [local.id]: local } };
  const read = vi.fn(async () => snapshot(initialWorkers));
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    conversationId: "parent-conversation", getDaemonSessionSnapshot: read,
    subscribeToEvents: (cb: (event: unknown) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const setState: Parameters<typeof startDaemonWorkerTaskPolling>[1] = update => { state = update(state); };
  const error = vi.fn();
  const close = startDaemonWorkerTaskPolling(session, setState, error);
  return { session, read, local, close, error, setState, state: () => state,
    emit: (event: unknown) => { for (const cb of listeners) cb(event); },
    task: () => state.tasks[worker.agentId] as LocalAgentTaskState };
}
afterEach(() => { vi.useRealTimers(); });

describe("daemon native worker inventory projection", () => {
  it("preserves canonical timing across live status patches and starts a fresh interval on reuse", async () => {
    const first = { turnId: "first", startedAt: 100_000, endedAt: 160_000 };
    const f = fixture([{ ...worker, timing: first }]);
    try {
      await drainMicrotasks(20);
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("1m00s");
      const emitStatus = (status: string, timing?: typeof first | Omit<typeof first, "endedAt">) => {
        const event = { type: "collab_agent_status", payload: { threadId: worker.agentId, status,
          ...(timing !== undefined ? { timing } : {}) } };
        f.emit(event);
        syncCollabAgentEventToAppState(event, f.setState as never, 999_000);
      };
      emitStatus("idle");
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("1m00s");
      emitStatus("running", { turnId: "next", startedAt: 500_000 });
      expect(f.task().endTime).toBeUndefined();
      expect(formatTaskElapsed(f.task(), 515_000)).toBe("0m15s");
      emitStatus("running");
      expect(f.task().startTime).toBe(500_000);
      emitStatus("interrupted", { turnId: "next", startedAt: 500_000, endedAt: 517_000 });
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("0m17s");
      emitStatus("running", { turnId: "next", startedAt: 500_000 });
      expect(f.task().endTime).toBeUndefined();
      emitStatus("idle", { turnId: "next", startedAt: 500_000, endedAt: 520_000 });
      emitStatus("killed");
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("0m20s");
    } finally { f.close(); }
  });

  it("does not invent elapsed time for an older daemon without lifecycle timestamps", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      expect(f.task().startTime).toBe(0);
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("—");
      f.read.mockResolvedValue(snapshot([{ ...worker, status: "running" }]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(formatTaskElapsed(f.task(), 900_000)).toBe("—");
    } finally { f.close(); }
  });

  it("skips unchanged projections, deduplicates offline errors, and coalesces event refreshes", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      const initial = f.state();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.state()).toBe(initial);
      f.read.mockRejectedValue(new Error("offline"));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.error).toHaveBeenCalledTimes(1);
      f.read.mockResolvedValue(snapshot([{ ...worker, status: "running" }]));
      const before = f.read.mock.calls.length;
      for (let index = 0; index < 3; index++) f.emit({ type: "collab_agent_status", payload: {} });
      await vi.advanceTimersByTimeAsync(250);
      expect(f.read).toHaveBeenCalledTimes(before + 1);
      expect(f.task().status).toBe("running");
    } finally { f.close(); }
  });

  it("restores idle workers and counts, refreshes after reconnect, and removes closed workers", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      expect(f.task()).toMatchObject({ status: "completed", description: "backend", progress: { toolUseCount: 5, tokenCount: 900 } });
      expect(f.task().evictAfter).toBeUndefined();
      expect(f.state().tasks[f.local.id]).toBe(f.local);
      f.read.mockRejectedValueOnce(new Error("offline"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.task().status).toBe("completed");
      expect(f.error).toHaveBeenCalledWith(expect.stringContaining("offline"));
      f.read.mockResolvedValueOnce(snapshot([{ ...worker, status: "running" }]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.task().status).toBe("running");
      f.read.mockResolvedValueOnce(snapshot([{ ...worker, status: "errored", error: "failed" }]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.task()).toMatchObject({ status: "failed", error: "failed" });
      f.read.mockResolvedValueOnce(snapshot([]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.state().tasks).toEqual({ [f.local.id]: f.local });
    } finally { f.close(); }
  });

  it("rejects a stale snapshot overtaken by a live worker transition", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
      f.read.mockReturnValueOnce(old.promise);
      await vi.advanceTimersByTimeAsync(5_000);
      const event = { type: "collab_agent_status", payload: { threadId: worker.agentId, status: "running" } };
      f.emit(event);
      syncCollabAgentEventToAppState(event, f.setState as never);
      old.resolve(snapshot());
      await drainMicrotasks(20);
      expect(f.task().status).toBe("running");
      expect(f.task().daemonWorker).toBeDefined();
    } finally { f.close(); }
  });

  it.each(["unmount", "replace"])("ignores an old poll after %s and preserves unrelated tasks", async mode => {
    const f = fixture();
    await drainMicrotasks(20);
    const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
    f.read.mockReturnValueOnce(old.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    if (mode === "unmount") f.close();
    else f.session.conversationId = "replacement-conversation";
    old.resolve(snapshot([{ ...worker, status: "running" }]));
    await drainMicrotasks(20);
    if (mode === "replace") {
      expect(f.task().status).toBe("completed");
      f.close();
    }
    expect(f.state().tasks).toEqual({ [f.local.id]: f.local });
  });
});
