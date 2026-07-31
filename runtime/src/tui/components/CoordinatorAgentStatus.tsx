import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { type AppState, useAppState } from '../state/AppState.js';

/** Return the panel-managed agent tasks that participate in footer navigation. */
export function getVisibleAgentTasks(
  tasks: AppState['tasks'],
): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter(
      (task): task is LocalAgentTaskState =>
        isPanelAgentTask(task) && task.evictAfter !== 0,
    )
    .sort((left, right) => left.startTime - right.startTime);
}

export function getCoordinatorTaskCount(tasks: AppState['tasks']): number {
  const visibleTasks = getVisibleAgentTasks(tasks);
  return visibleTasks.length === 0 ? 0 : visibleTasks.length + 1;
}

export function useCoordinatorTaskCount(): number {
  const tasks = useAppState(state => state.tasks);
  return getCoordinatorTaskCount(tasks);
}
