import type { TaskInfo } from '../../types';
import { TasksView } from '../tasks/TasksView';

interface TasksPaneProps {
  tasks: TaskInfo[];
  agentWallet?: string;
  onRefresh: () => void;
  onCreate: (params: Record<string, unknown>) => void;
  onClaim: (taskId: string) => void;
  onComplete: (taskId: string, resultData?: string) => void;
  onDispute: (taskId: string, evidence: string, resolutionType?: string) => void;
  onCancel: (taskId: string) => void;
}

export function TasksPane({
  tasks,
  agentWallet,
  onRefresh,
  onCreate,
  onClaim,
  onComplete,
  onDispute,
  onCancel,
}: TasksPaneProps) {
  return (
    <TasksView
      tasks={tasks}
      agentWallet={agentWallet}
      onRefresh={onRefresh}
      onCreate={onCreate}
      onClaim={onClaim}
      onComplete={onComplete}
      onDispute={onDispute}
      onCancel={onCancel}
    />
  );
}
