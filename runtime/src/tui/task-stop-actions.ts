import { requestTeammateShutdown } from "../tasks/InProcessTeammateTask/InProcessTeammateTask.js";
import { killAsyncAgent } from "../tasks/LocalAgentTask/LocalAgentTask.js";
import { killTask } from "../tasks/LocalShellTask/killShellTasks.js";
import type { LocalShellTaskState, TaskState } from "../tasks/types.js";
import type { AppState } from "./state/AppStateStore.js";

type SetAppState = (updater: (prev: AppState) => AppState) => void;

type StopActionTask =
  Pick<TaskState, "type" | "status"> & {
    readonly shutdownRequested?: boolean;
    readonly stopRequested?: boolean;
  };

export type TuiTaskStopAction =
  | "local-shell"
  | "local-agent"
  | "teammate";

export function tuiStopActionForTask(task: StopActionTask | null | undefined): TuiTaskStopAction | null {
  if (!task) return null;
  switch (task.type) {
    case "local_bash":
      return task.status === "running" && task.stopRequested !== true ? "local-shell" : null;
    case "local_agent":
      return task.status === "pending" || task.status === "running" ? "local-agent" : null;
    case "in_process_teammate":
      return task.status === "running" && task.shutdownRequested !== true ? "teammate" : null;
    default:
      return null;
  }
}

export function stopTuiTask(
  task: TaskState,
  setAppState: SetAppState,
): TuiTaskStopAction | null {
  const action = tuiStopActionForTask(task);
  switch (action) {
    case "local-shell":
      if (task.type === "local_bash" && task.daemonProcess !== undefined) {
        requestDaemonProcessStop(task, setAppState);
      } else {
        killTask(task.id, setAppState);
      }
      return action;
    case "local-agent":
      killAsyncAgent(task.id, setAppState);
      return action;
    case "teammate":
      requestTeammateShutdown(task.id, setAppState);
      return action;
    case null:
      return action;
  }
}

const pendingDaemonStops = new WeakSet<() => Promise<void>>();

function requestDaemonProcessStop(task: LocalShellTaskState, setAppState: SetAppState): void {
  const stop = task.daemonProcess!.stop;
  if (pendingDaemonStops.has(stop)) return;
  pendingDaemonStops.add(stop);
  const update = (transform: (current: LocalShellTaskState) => LocalShellTaskState): void => {
    setAppState(state => {
      const current = state.tasks[task.id];
      if (current?.type !== "local_bash" || current.daemonProcess?.stop !== stop) return state;
      return { ...state, tasks: { ...state.tasks, [task.id]: transform(current) } };
    });
  };
  update(current => ({ ...current, stopRequested: true, stopError: undefined }));
  void stop().then(() => {
    update(current => ({
      ...current,
      status: current.status === "running" ? "killed" : current.status,
      endTime: current.endTime ?? Date.now(),
      stopRequested: false,
    }));
  }, error => {
    update(current => ({
      ...current, stopRequested: false,
      stopError: `Stop failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }).finally(() => { pendingDaemonStops.delete(stop); });
}
