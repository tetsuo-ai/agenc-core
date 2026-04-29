import { useEffect, useState } from 'react';
import type { TaskInfo } from '../../types';

type TaskActionMode = 'complete' | 'dispute' | null;
type ResolutionType = 'refund' | 'complete' | 'split';

interface TaskCardProps {
  task: TaskInfo;
  onClaim: (taskId: string) => void;
  onComplete: (taskId: string, resultData?: string) => void;
  onDispute: (taskId: string, evidence: string, resolutionType?: string) => void;
  onCancel: (taskId: string) => void;
}

const STATUS_STYLES: Record<string, string> = {
  open: 'border-bbs-green/40 text-bbs-green',
  in_progress: 'border-bbs-yellow/40 text-bbs-yellow',
  pending_validation: 'border-bbs-purple-dim text-bbs-purple',
  completed: 'border-bbs-cyan/40 text-bbs-cyan',
  cancelled: 'border-bbs-border text-bbs-gray',
  disputed: 'border-bbs-red/40 text-bbs-red',
};

function truncateId(value: string) {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

export function TaskCard({
  task,
  onClaim,
  onComplete,
  onDispute,
  onCancel,
}: TaskCardProps) {
  const [actionMode, setActionMode] = useState<TaskActionMode>(null);
  const [resultData, setResultData] = useState('');
  const [evidence, setEvidence] = useState('');
  const [resolutionType, setResolutionType] = useState<ResolutionType>('refund');

  useEffect(() => {
    setActionMode(null);
    setResultData('');
    setEvidence('');
    setResolutionType('refund');
  }, [task.id, task.status]);

  const statusKey = task.status.toLowerCase();
  const statusClass = STATUS_STYLES[statusKey] ?? STATUS_STYLES.open;
  const description = task.description?.trim() || 'untitled task';
  const ownedBySigner = Boolean(task.ownedBySigner);
  const assignedToSigner = Boolean(task.assignedToSigner);
  const canClaim =
    task.claimableBySigner ??
    (statusKey === 'open' && !ownedBySigner && !assignedToSigner);
  const canCancel = statusKey === 'open' && ownedBySigner;
  const canComplete =
    (statusKey === 'in_progress' || statusKey === 'pending_validation') && assignedToSigner;
  const canDispute =
    (statusKey === 'in_progress' || statusKey === 'pending_validation') && assignedToSigner;

  return (
    <article className="border border-bbs-border bg-bbs-dark px-4 py-4 transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
            <span className="text-bbs-purple">TASK&gt;</span>
            <span className="text-bbs-lightgray">{truncateId(task.id)}</span>
          </div>
          <div className="mt-2 break-words text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
            {description}
          </div>
        </div>

        <span className={`shrink-0 border px-3 py-2 text-[10px] uppercase tracking-[0.16em] ${statusClass}`}>
          [{statusKey}]
        </span>
      </div>

      <div className="mt-4 grid gap-2 text-xs text-bbs-gray md:grid-cols-2 xl:grid-cols-4">
        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">task id</div>
          <div className="mt-1 break-all text-bbs-lightgray">{task.id}</div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">creator</div>
          <div className="mt-1 break-all text-bbs-lightgray">{task.creator ?? '--'}</div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">reward</div>
          <div className="mt-1 text-bbs-lightgray">{task.reward ?? '--'}</div>
        </div>

        <div className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">worker</div>
          <div className="mt-1 break-all text-bbs-lightgray">{task.worker ?? '--'}</div>
        </div>
      </div>

      {(canClaim || canCancel || canComplete || canDispute) && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
          {canClaim && (
            <button
              type="button"
              onClick={() => onClaim(task.id)}
              className="border border-bbs-green/40 bg-bbs-black px-3 py-2 text-bbs-green transition-colors hover:text-bbs-white"
            >
              [claim]
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              onClick={() => setActionMode((current) => current === 'complete' ? null : 'complete')}
              className="border border-bbs-cyan/40 bg-bbs-black px-3 py-2 text-bbs-cyan transition-colors hover:text-bbs-white"
            >
              [complete]
            </button>
          )}
          {canDispute && (
            <button
              type="button"
              onClick={() => setActionMode((current) => current === 'dispute' ? null : 'dispute')}
              className="border border-bbs-yellow/40 bg-bbs-black px-3 py-2 text-bbs-yellow transition-colors hover:text-bbs-white"
            >
              [dispute]
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => onCancel(task.id)}
              className="border border-bbs-red/40 bg-bbs-black px-3 py-2 text-bbs-red transition-colors hover:text-bbs-white"
            >
              [cancel]
            </button>
          )}
        </div>
      )}

      {actionMode === 'complete' && (
        <div className="mt-4 space-y-3 border border-bbs-cyan/30 bg-bbs-black/40 px-4 py-4 animate-panel-enter">
          <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Completion note</div>
          <textarea
            value={resultData}
            onChange={(event) => setResultData(event.target.value)}
            rows={3}
            placeholder="attach a short public completion note"
            className="w-full resize-none border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-cyan/40"
          />
          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
            <button
              type="button"
              onClick={() => onComplete(task.id, resultData.trim() || undefined)}
              className="border border-bbs-cyan/40 bg-bbs-dark px-3 py-2 text-bbs-cyan transition-colors hover:text-bbs-white"
            >
              [submit completion]
            </button>
            <button
              type="button"
              onClick={() => setActionMode(null)}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [close]
            </button>
          </div>
        </div>
      )}

      {actionMode === 'dispute' && (
        <div className="mt-4 space-y-3 border border-bbs-yellow/30 bg-bbs-black/40 px-4 py-4 animate-panel-enter">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Evidence</div>
              <textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                rows={4}
                placeholder="describe why this task should enter dispute review"
                className="w-full resize-none border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-yellow/40"
              />
            </div>

            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">Resolution</div>
              <select
                value={resolutionType}
                onChange={(event) => setResolutionType(event.target.value as ResolutionType)}
                className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm uppercase tracking-[0.08em] text-bbs-white outline-none transition-colors focus:border-bbs-yellow/40"
              >
                <option value="refund">refund</option>
                <option value="complete">complete</option>
                <option value="split">split</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
            <button
              type="button"
              onClick={() => onDispute(task.id, evidence.trim(), resolutionType)}
              disabled={!evidence.trim()}
              className="border border-bbs-yellow/40 bg-bbs-dark px-3 py-2 text-bbs-yellow transition-colors enabled:hover:text-bbs-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              [open dispute]
            </button>
            <button
              type="button"
              onClick={() => setActionMode(null)}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [close]
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
