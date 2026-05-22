import { requestTeammateShutdown } from "../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js";
import { killAsyncAgent } from "../../../tasks/LocalAgentTask/LocalAgentTask.js";
import { killTask } from "../../../tasks/LocalShellTask/killShellTasks.js";
import { isStoppableTaskStatus, type TaskState } from "../../../tasks/types.js";
import type { AppState } from "../../state/AppStateStore.js";

type SetAppState = (updater: (prev: AppState) => AppState) => void;

export type WorkbenchTaskStopAction =
  | "local-shell"
  | "local-agent"
  | "teammate"
  | "remote-unavailable";

export function workbenchStopActionForTask(task: Pick<TaskState, "type" | "status"> | null | undefined): WorkbenchTaskStopAction | null {
  if (!task || !isStoppableTaskStatus(task.status)) return null;
  switch (task.type) {
    case "local_bash":
      return "local-shell";
    case "local_agent":
      return "local-agent";
    case "in_process_teammate":
      return "teammate";
    case "remote_agent":
      return "remote-unavailable";
    default:
      return null;
  }
}

export function stopWorkbenchTask(
  task: TaskState,
  setAppState: SetAppState,
): WorkbenchTaskStopAction | null {
  const action = workbenchStopActionForTask(task);
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
    case "remote-unavailable":
    case null:
      return action;
  }
}
