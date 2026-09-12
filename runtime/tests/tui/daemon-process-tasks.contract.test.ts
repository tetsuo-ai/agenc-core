import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionProcessSnapshot, SessionProcessesListResult } from "../../src/app-server/protocol/index.js";
import type { LocalShellTaskState } from "../../src/tasks/types.js";
import { getDefaultAppState } from "../../src/tui/state/AppStateStore.js";
import { startDaemonProcessTaskPolling } from "../../src/tui/state/daemonProcessTasks.js";
import { stopTuiTask, tuiStopActionForTask } from "../../src/tui/task-stop-actions.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";
import { drainMicrotasks } from "../helpers/controlled-async.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";

const taskId = "c5d4d21b-4fc5-4163-a7f3-9d4498bd093e";
const process: SessionProcessSnapshot = {
  taskId, command: "node server.js", cwd: "/workspace", tty: false,
  startedAt: 100, status: "running", outputTail: "listening\n", outputBytes: 10,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  vi.useFakeTimers();
  let state = getDefaultAppState();
  const local: LocalShellTaskState = {
    id: "legacy-task", type: "local_bash", command: "local", description: "local",
    startTime: 1, status: "running", notified: false, outputFile: "local.log", outputOffset: 0,
  };
  state = { ...state, tasks: { [local.id]: local } };
  const list = vi.fn(async (): Promise<SessionProcessesListResult | undefined> => ({ processes: [process] }));
  const stop = vi.fn(async (_id: string) => ({ stopped: true }));
  const session = { conversationId: "parent-session", listDaemonSessionProcesses: list, stopDaemonSessionProcess: stop };
  const setState: Parameters<typeof startDaemonProcessTaskPolling>[1] = update => { state = update(state); };
  const error = vi.fn();
  const close = startDaemonProcessTaskPolling(session, setState, error);
  return { session, list, stop, local, error, close, setState, state: () => state,
    task: () => state.tasks[taskId] as LocalShellTaskState };
}
afterEach(() => { vi.useRealTimers(); });

describe("daemon process task projection", () => {
  it("preserves local tasks, output tails and terminal snapshots without overlapping polls", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      expect(f.state().tasks[f.local.id]).toBe(f.local);
      expect(f.task().daemonProcess?.outputTail).toBe("listening\n");
      const next = deferred<SessionProcessesListResult>();
      f.list.mockReturnValueOnce(next.promise);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.list).toHaveBeenCalledTimes(2);
      next.resolve({ processes: [{ ...process, status: "completed", exitCode: 0, endedAt: 200, outputTail: "done\n" }] });
      await drainMicrotasks(20);
      expect(f.task()).toMatchObject({ status: "completed", endTime: 200, result: { code: 0 } });
      expect(f.task().daemonProcess?.outputTail).toBe("done\n");
    } finally { f.close(); }
  });

  it("waits for actual stop acknowledgement and rejects an older running poll afterward", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      const oldPoll = deferred<SessionProcessesListResult>();
      f.list.mockReturnValueOnce(oldPoll.promise);
      await vi.advanceTimersByTimeAsync(1_000);
      const stopping = deferred<{ stopped: boolean }>();
      f.stop.mockReturnValueOnce(stopping.promise);
      const selected = f.task();
      stopTuiTask(selected, f.setState);
      stopTuiTask(selected, f.setState);
      expect(f.stop).toHaveBeenCalledExactlyOnceWith(taskId);
      expect(f.task()).toMatchObject({ status: "running", stopRequested: true });
      expect(tuiStopActionForTask(f.task())).toBeNull();
      stopping.resolve({ stopped: true });
      await drainMicrotasks(20);
      expect(f.task()).toMatchObject({ status: "killed", stopRequested: false });
      oldPoll.resolve({ processes: [process] });
      await drainMicrotasks(20);
      expect(f.task().status).toBe("killed");
    } finally { f.close(); }
  });

  it.each(["rejected", "not stopped"])("shows %s stop errors without claiming the process ended", async failure => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      if (failure === "rejected") f.stop.mockRejectedValueOnce(new Error("connection lost"));
      else f.stop.mockResolvedValueOnce({ stopped: false });
      stopTuiTask(f.task(), f.setState);
      await drainMicrotasks(20);
      expect(f.task()).toMatchObject({ status: "running", stopRequested: false, stopError: expect.stringContaining("Stop failed:") });
      expect(tuiStopActionForTask(f.task())).toBe("local-shell");
    } finally { f.close(); }
  });

  it("ignores old-session polls and refuses a captured stop after session replacement", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      const oldStop = f.task().daemonProcess!.stop;
      const oldPoll = deferred<SessionProcessesListResult>();
      f.list.mockReturnValueOnce(oldPoll.promise);
      await vi.advanceTimersByTimeAsync(1_000);
      f.session.conversationId = "replacement-session";
      await expect(oldStop()).rejects.toThrow("previous session");
      expect(f.stop).not.toHaveBeenCalled();
      oldPoll.resolve({ processes: [{ ...process, status: "failed" }] });
      await drainMicrotasks(20);
      expect(f.task().status).toBe("running");
    } finally { f.close(); }
  });

  it("ignores a result after unmount and removes only its own projection", async () => {
    const f = fixture();
    await drainMicrotasks(20);
    const late = deferred<SessionProcessesListResult>();
    f.list.mockReturnValueOnce(late.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    f.close();
    late.resolve({ processes: [process] });
    await drainMicrotasks(20);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.state().tasks).toEqual({ [f.local.id]: f.local });
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it("retains the last snapshot on unavailable capability or errors, and applies authoritative history eviction", async () => {
    const f = fixture();
    try {
      await drainMicrotasks(20);
      f.list.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.task().status).toBe("running");
      expect(f.error).toHaveBeenCalledWith(expect.stringContaining("offline"));
      f.list.mockResolvedValueOnce({ processes: [] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.state().tasks).toEqual({ [f.local.id]: f.local });
    } finally { f.close(); }
  });
});

it("routes advertised daemon process methods with session and opaque task identity", async () => {
  const request = vi.fn(async (method: string) => method === "session.processes.list" ? { processes: [process] } : { stopped: true });
  const supportsMethod = vi.fn(() => false);
  const session = createDaemonTuiSessionFixture({
    baseSession: { conversationId: "parent-session", services: {} }, sessionId: "parent-session", clientId: "tui",
    client: { request, supportsMethod, subscribeToSessionEvents: () => () => {} } as unknown as AgenCDaemonTuiClient,
  });
  expect(await session.listDaemonSessionProcesses?.()).toBeUndefined();
  await expect(session.stopDaemonSessionProcess?.(taskId)).rejects.toThrow("does not support");
  expect(request).not.toHaveBeenCalled();
  supportsMethod.mockReturnValue(true);
  expect(await session.listDaemonSessionProcesses?.()).toEqual({ processes: [process] });
  await session.stopDaemonSessionProcess?.(taskId);
  expect(request.mock.calls).toEqual([
    ["session.processes.list", { sessionId: "parent-session" }],
    ["session.processes.stop", { sessionId: "parent-session", taskId }],
  ]);
});
