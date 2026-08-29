// Pure type + type guard for LocalShellTask state. Kept outside the React
// component module so task-lifecycle consumers do not pull React/Ink into
// their module graph.

import type { TaskStateBase } from "../Task.js";
import type { AgentId } from "../../types/ids.js";
import type { ShellCommand } from "../../utils/ShellCommand.js";
import type { SessionQueueOwner } from "../../utils/queueOwnership.js";

export type LocalShellTaskState = TaskStateBase & {
  queueOwner: SessionQueueOwner;
  type: "local_bash"; // Keep as 'local_bash' for backward compatibility with persisted session state
  command: string;
  result?: {
    code: number;
    interrupted: boolean;
  };
  completionStatusSentInAttachment: boolean;
  shellCommand: ShellCommand | null;
  unregisterCleanup?: () => void;
  cleanupTimeoutId?: NodeJS.Timeout;
  // Track what we last reported for computing deltas (total lines from TaskOutput)
  lastReportedTotalLines: number;
  // Whether the task has been backgrounded (false = foreground running, true = backgrounded)
  isBackgrounded: boolean;
  // Agent that spawned this task. Used to kill orphaned bash tasks when the
  // agent exits (see killShellTasksForAgent). Undefined = main thread.
  agentId?: AgentId;
};

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === "object" &&
    task !== null &&
    "type" in task &&
    task.type === "local_bash"
  );
}
