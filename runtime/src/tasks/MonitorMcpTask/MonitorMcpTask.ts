// MonitorMcpTask — task registry entry for the 'monitor_mcp' type.
//
// Architecture: MonitorTool spawns shell processes as LocalShellTask
// (type: 'local_bash', kind: 'monitor'). The 'monitor_mcp' type exists
// in TaskType for forward-compatibility with MCP-based monitoring (not
// yet implemented). This module satisfies the import from tasks.ts and
// provides killMonitorMcpTasksForAgent for agent-scoped cleanup of
// monitor-kind shell tasks.

import type { AppState } from '../../tui/state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from 'src/utils/debug.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState as updateTaskStateBase } from '../../utils/task/framework.js'
import { isLocalShellTask } from '../LocalShellTask/guards.js'
import { killTask } from '../LocalShellTask/killShellTasks.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  agentId?: AgentId
}

// Seam: the 'monitor_mcp' task type is deliberately NOT a member of the
// `TaskState` union in tasks/types.ts (it's forward-compat scaffolding, not
// yet implemented — see the module header). The framework's updateTaskState is
// generically constrained to that union, so MonitorMcpTaskState (type:
// 'monitor_mcp') can't satisfy it directly. This thin adapter re-types the
// helper for the monitor_mcp task without changing any runtime behavior —
// framework already performs the equivalent internal cast when reading the
// task back out of AppState. Mirrors the DreamTask adapter.
const updateTaskState = updateTaskStateBase as (
  taskId: string,
  setAppState: SetAppState,
  updater: (task: MonitorMcpTaskState) => MonitorMcpTaskState,
) => void

function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'monitor_mcp'
  )
}

const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState) {
    updateTaskState(taskId, setAppState, task => {
      if (task.status !== 'running') {
        return task
      }

      return {
        ...task,
        status: 'killed',
        notified: true,
        endTime: Date.now(),
      }
    })
    void evictTaskOutput(taskId)
  },
}

/**
 * Kill all monitor tasks owned by a given agent.
 *
 * MonitorTool spawns tasks as local_bash with kind='monitor'. When an agent
 * exits, killShellTasksForAgent already handles those. This function provides
 * additional cleanup for any monitor_mcp-typed tasks and also kills any
 * local_bash tasks with kind='monitor' that might have been missed (belt and
 * suspenders). Finally, it purges queued notifications for the dead agent.
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): void {
  const tasks = getAppState().tasks ?? {}

  for (const [taskId, taskEntry] of Object.entries(tasks)) {
    // monitor_mcp is not a member of the AppState `TaskState` union (see the
    // seam note above), so an `isMonitorMcpTask` guard against a TaskState-typed
    // value narrows to `never`. Treat the entry as unknown — both guards below
    // accept unknown and narrow correctly — without changing runtime behavior.
    const task: unknown = taskEntry
    // Kill monitor_mcp tasks for this agent
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing monitor_mcp task ${taskId} (agent ${agentId} exiting)`,
      )
      void MonitorMcpTask.kill(taskId, setAppState)
    }
    // Also kill local_bash tasks with kind='monitor' for this agent
    // (killShellTasksForAgent already does this, but being explicit
    // guards against ordering issues)
    if (
      isLocalShellTask(task) &&
      task.kind === 'monitor' &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing monitor shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them.
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
