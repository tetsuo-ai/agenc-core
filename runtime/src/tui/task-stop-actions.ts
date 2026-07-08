import { requestTeammateShutdown } from "../tasks/InProcessTeammateTask/InProcessTeammateTask.js";
import { killAsyncAgent } from "../tasks/LocalAgentTask/LocalAgentTask.js";
import { killTask } from "../tasks/LocalShellTask/killShellTasks.js";
import type { TaskState } from "../tasks/types.js";
import type { AppState } from "./state/AppStateStore.js";

type SetAppState = (updater: (prev: AppState) => AppState) => void;

type StopActionTask =
  Pick<TaskState, "type" | "status"> & {
    readonly shutdownRequested?: boolean;
  };

export type TuiTaskStopAction =
  | "local-shell"
  | "local-agent"
  | "teammate";

export function tuiStopActionForTask(task: StopActionTask | null | undefined): TuiTaskStopAction | null {
  if (!task) return null;
  switch (task.type) {
    case "local_bash":
      return task.status === "running" ? "local-shell" : null;
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
      killTask(task.id, setAppState);
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
