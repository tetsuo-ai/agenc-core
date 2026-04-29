import { useEffect, useMemo, useState } from 'react';
import type { TaskInfo } from '../../types';
import { TaskCard } from './TaskCard';
import { CreateTaskForm } from './CreateTaskForm';

const FILTERS = [
  { label: 'all', value: '' },
  { label: 'open', value: 'open' },
  { label: 'in_progress', value: 'in_progress' },
  { label: 'pending_validation', value: 'pending_validation' },
  { label: 'completed', value: 'completed' },
  { label: 'disputed', value: 'disputed' },
  { label: 'cancelled', value: 'cancelled' },
] as const;

type TaskScope = 'yours' | 'all';

interface TasksViewProps {
  tasks: TaskInfo[];
  onRefresh: () => void;
  onCreate: (params: Record<string, unknown>) => void;
  onClaim: (taskId: string) => void;
  onComplete: (taskId: string, resultData?: string) => void;
  onDispute: (taskId: string, evidence: string, resolutionType?: string) => void;
  onCancel: (taskId: string) => void;
}

export function TasksView({
  tasks,
  onRefresh,
  onCreate,
  onClaim,
  onComplete,
  onDispute,
  onCancel,
}: TasksViewProps) {
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState<TaskScope>('yours');

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const hasViewerScope = useMemo(
    () => tasks.some((task) => Boolean(task.viewerAgentPda)),
    [tasks],
  );

  const yoursCount = useMemo(
    () => tasks.filter((task) => task.ownedBySigner || task.assignedToSigner).length,
    [tasks],
  );

  const effectiveScope: TaskScope = hasViewerScope ? scope : 'all';

  const filtered = useMemo(() => {
    const scopedTasks = effectiveScope === 'yours'
      ? tasks.filter((task) => task.ownedBySigner || task.assignedToSigner)
      : tasks;

    if (!filter) {
      return scopedTasks;
    }

    return scopedTasks.filter((task) => task.status.toLowerCase() === filter);
  }, [tasks, filter, effectiveScope]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const task of tasks) {
      const key = task.status.toLowerCase();
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [tasks]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <div className="border-b border-bbs-purple-dim bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="shrink-0 text-bbs-purple">TASKS&gt;</span>
              <span>Task Board</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              On-chain task registry
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              create work items, inspect settlement state, and manage open queue entries
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3 text-xs uppercase tracking-[0.14em]">
            <span className="border border-bbs-border bg-bbs-dark px-3 py-2 text-bbs-lightgray">
              [{tasks.length} tracked]
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [REFRESH]
            </button>
          </div>
        </div>
      </div>

      {tasks.length > 0 && (
        <div className="border-b border-bbs-border bg-bbs-dark/80 px-4 py-3 md:px-6">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em]">
            {hasViewerScope && (
              <>
                <span className="mr-2 text-bbs-gray">scope:</span>
                <button
                  type="button"
                  onClick={() => setScope('yours')}
                  className={[
                    'border px-3 py-2 transition-colors',
                    effectiveScope === 'yours'
                      ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                      : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                  ].join(' ')}
                >
                  [yours:{yoursCount}]
                </button>
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className={[
                    'border px-3 py-2 transition-colors',
                    effectiveScope === 'all'
                      ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                      : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                  ].join(' ')}
                >
                  [all:{tasks.length}]
                </button>
                <span className="ml-4 mr-2 text-bbs-gray">filter:</span>
              </>
            )}
            {!hasViewerScope && <span className="mr-2 text-bbs-gray">filter:</span>}
            {FILTERS.map((item) => {
              const count = item.value ? (counts[item.value] ?? 0) : tasks.length;
              const active = filter === item.value;
              return (
                <button
                  key={item.value || 'all'}
                  type="button"
                  onClick={() => setFilter(item.value)}
                  className={[
                    'border px-3 py-2 transition-colors',
                    active
                      ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                      : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                  ].join(' ')}
                >
                  [{item.label}:{count}]
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <div className="animate-list-item" style={{ animationDelay: '0ms' }}>
            <CreateTaskForm onCreate={onCreate} />
          </div>

          {filtered.length === 0 ? (
            <div className="animate-list-item border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no matching tasks]
            </div>
          ) : (
            filtered.map((task, index) => (
              <div
                key={task.id}
                className="animate-list-item"
                style={{ animationDelay: `${(index + 1) * 45}ms` }}
              >
                <TaskCard
                  task={task}
                  onClaim={onClaim}
                  onComplete={onComplete}
                  onDispute={onDispute}
                  onCancel={onCancel}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
