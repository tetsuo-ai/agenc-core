import type { SessionProcessSnapshot } from "../../app-server/protocol/index.js";
import type { LocalShellTaskState, TaskState } from "../../tasks/types.js";
import type { AgenCBridgeSession } from "../session-types.js";
import type { AppState } from "./AppStateStore.js";

type SetAppState = (update: (state: AppState) => AppState) => void;

/** Project daemon-owned processes; the TUI never owns their handles or output. */
export function startDaemonProcessTaskPolling(
  session: Pick<AgenCBridgeSession, "conversationId" | "listDaemonSessionProcesses" | "stopDaemonSessionProcess">,
  setAppState: SetAppState,
  onError: (message: string) => void,
): () => void {
  if (session.listDaemonSessionProcesses === undefined) return () => {};
  const projection = {};
  const stopCallbacks = new Map<string, () => Promise<void>>();
  let active = true;
  let reading = false;

  const project = (process: SessionProcessSnapshot, sessionId: string, previous?: TaskState): LocalShellTaskState => {
    const callbackKey = `${sessionId}:${process.taskId}`;
    let stop = stopCallbacks.get(callbackKey);
    if (stop === undefined) {
      stop = async () => {
        if (!active || session.conversationId !== sessionId) throw new Error("This process belongs to a previous session");
        if (session.stopDaemonSessionProcess === undefined) throw new Error("This session cannot stop daemon processes");
        const result = await session.stopDaemonSessionProcess(process.taskId);
        if (!result.stopped) throw new Error("The daemon did not stop this process; it may already have exited");
      };
      stopCallbacks.set(callbackKey, stop);
    }
    const prior = previous?.type === "local_bash" && previous.daemonProcess?.projection === projection
      ? previous : undefined;
    // A poll started before a stop acknowledgement may contain an older
    // running snapshot. It must not resurrect the acknowledged terminal task.
    const retainTerminal = process.status === "running" && prior !== undefined &&
      prior.status !== "running" && prior.status !== "pending";
    return {
      id: process.taskId, type: "local_bash", description: process.command,
      command: process.command, startTime: process.startedAt,
      status: retainTerminal ? prior.status : process.status,
      endTime: retainTerminal ? prior.endTime : process.endedAt,
      outputFile: "", outputOffset: 0, notified: true, isBackgrounded: true,
      ...(process.exitCode === undefined ? {} : {
        result: { code: process.exitCode, interrupted: process.status === "killed" },
      }),
      stopRequested: prior?.stopRequested,
      stopError: prior?.stopError,
      daemonProcess: {
        projection, sessionId, cwd: process.cwd, tty: process.tty,
        ownerId: process.ownerId, outputTail: process.outputTail,
        outputBytes: process.outputBytes, stop,
      },
    };
  };
  const poll = async (): Promise<void> => {
    if (!active || reading) return;
    reading = true;
    const sessionId = session.conversationId;
    try {
      const snapshot = await session.listDaemonSessionProcesses?.();
      if (!active || session.conversationId !== sessionId || snapshot === undefined) return;
      const retained = new Set(snapshot.processes.map(process => `${sessionId}:${process.taskId}`));
      for (const key of stopCallbacks.keys()) if (!retained.has(key)) stopCallbacks.delete(key);
      setAppState(state => {
        if (!active || session.conversationId !== sessionId) return state;
        const tasks = Object.fromEntries(Object.entries(state.tasks).filter(([, task]) =>
          task.type !== "local_bash" || task.daemonProcess?.projection !== projection));
        for (const process of snapshot.processes) {
          // An unrelated local task can never be replaced by a daemon ID.
          if (tasks[process.taskId] !== undefined) continue;
          tasks[process.taskId] = project(process, sessionId, state.tasks[process.taskId]);
        }
        return { ...state, tasks };
      });
    } catch (error) {
      if (active && session.conversationId === sessionId) {
        onError(`Unable to refresh background processes: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      reading = false;
    }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, 1_000);
  timer.unref?.();
  return () => {
    active = false;
    clearInterval(timer);
    stopCallbacks.clear();
    setAppState(state => ({
      ...state,
      tasks: Object.fromEntries(Object.entries(state.tasks).filter(([, task]) =>
        task.type !== "local_bash" || task.daemonProcess?.projection !== projection)),
    }));
  };
}
