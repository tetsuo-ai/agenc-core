import type { DisputeInfo } from '../../types';
import { formatCompact, formatTimestamp } from './shared';

interface DisputesPaneProps {
  disputes: DisputeInfo[];
  selectedDispute: DisputeInfo | null;
  onInspect: (disputePda: string) => void;
}

export function DisputesPane({
  disputes,
  selectedDispute,
  onInspect,
}: DisputesPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="min-h-0 flex-1 overflow-y-auto border-b border-bbs-border px-4 py-4 md:border-b-0 md:border-r md:px-6">
        <div className="space-y-3">
          {disputes.map((dispute) => (
            <button
              key={dispute.disputePda}
              type="button"
              onClick={() => onInspect(dispute.disputePda)}
              className="w-full border border-bbs-border bg-bbs-dark px-4 py-4 text-left transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">DISPUTE&gt;</div>
                  <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                    {dispute.resolutionType}
                  </div>
                  <div className="mt-2 text-xs text-bbs-gray">task {formatCompact(dispute.taskPda)}</div>
                </div>
                <div className="text-right text-xs uppercase tracking-[0.14em] text-bbs-gray">
                  <div>[{dispute.status}]</div>
                  <div className="mt-2 text-bbs-lightgray">{dispute.votesFor} / {dispute.votesAgainst}</div>
                </div>
              </div>
            </button>
          ))}
          {disputes.length === 0 && (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no disputes returned]
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 w-full shrink-0 overflow-y-auto md:w-[420px]">
        <div className="space-y-4 px-4 py-4 md:px-6">
          {!selectedDispute ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [select a dispute to inspect the settlement state]
            </div>
          ) : (
            <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">DETAIL&gt;</div>
              <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                {selectedDispute.status}
              </div>
              <div className="mt-3 space-y-2 text-xs text-bbs-lightgray">
                <div>initiator: {formatCompact(selectedDispute.initiator)}</div>
                <div>defendant: {formatCompact(selectedDispute.defendant)}</div>
                <div>evidence hash: {formatCompact(selectedDispute.evidenceHash)}</div>
                <div>opened: {formatTimestamp(selectedDispute.createdAt)}</div>
                <div>expires: {formatTimestamp(selectedDispute.expiresAt)}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
