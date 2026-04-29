import { useCallback, useState } from 'react';
import type { TaskInfo, WSMessage } from '../types';

interface UseTasksOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseTasksReturn {
  tasks: TaskInfo[];
  refresh: () => void;
  create: (params: Record<string, unknown>) => void;
  claim: (taskId: string) => void;
  complete: (taskId: string, resultData?: string) => void;
  dispute: (taskId: string, evidence: string, resolutionType?: string) => void;
  cancel: (taskId: string) => void;
}

export function useTasks({ send }: UseTasksOptions): UseTasksReturn {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  const refresh = useCallback(() => {
    send({ type: 'tasks.list' });
  }, [send]);

  const create = useCallback((params: Record<string, unknown>) => {
    send({ type: 'tasks.create', payload: { params } });
  }, [send]);

  const claim = useCallback((taskId: string) => {
    send({ type: 'tasks.claim', payload: { taskId } });
  }, [send]);

  const complete = useCallback((taskId: string, resultData?: string) => {
    send({ type: 'tasks.complete', payload: { taskId, ...(resultData ? { resultData } : {}) } });
  }, [send]);

  const dispute = useCallback((taskId: string, evidence: string, resolutionType = 'refund') => {
    send({ type: 'tasks.dispute', payload: { taskId, evidence, resolutionType } });
  }, [send]);

  const cancel = useCallback((taskId: string) => {
    send({ type: 'tasks.cancel', payload: { taskId } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'tasks.list') {
      setTasks((msg.payload as TaskInfo[]) ?? []);
    }
  }, []);

  return { tasks, refresh, create, claim, complete, dispute, cancel, handleMessage } as UseTasksReturn & { handleMessage: (msg: WSMessage) => void };
}
