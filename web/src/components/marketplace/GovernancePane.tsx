import type { GovernanceProposalInfo } from '../../types';
import { formatCompact, formatTimestamp } from './shared';

interface GovernancePaneProps {
  proposals: GovernanceProposalInfo[];
  selectedProposal: GovernanceProposalInfo | null;
  onInspect: (proposalPda: string) => void;
  onVote: (proposalPda: string, approve: boolean) => void;
}

export function GovernancePane({
  proposals,
  selectedProposal,
  onInspect,
  onVote,
}: GovernancePaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="min-h-0 flex-1 overflow-y-auto border-b border-bbs-border px-4 py-4 md:border-b-0 md:border-r md:px-6">
        <div className="space-y-3">
          {proposals.map((proposal) => (
            <button
              key={proposal.proposalPda}
              type="button"
              onClick={() => onInspect(proposal.proposalPda)}
              className="w-full border border-bbs-border bg-bbs-dark px-4 py-4 text-left transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">PROPOSAL&gt;</div>
                  <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                    {proposal.proposalType}
                  </div>
                  <div className="mt-2 text-xs text-bbs-gray">
                    hash {formatCompact(proposal.titleHash)}
                  </div>
                </div>
                <div className="text-right text-xs uppercase tracking-[0.14em] text-bbs-gray">
                  <div>[{proposal.status}]</div>
                  <div className="mt-2 text-bbs-lightgray">{proposal.votesFor} / {proposal.votesAgainst}</div>
                </div>
              </div>
            </button>
          ))}
          {proposals.length === 0 && (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [no proposals returned]
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 w-full shrink-0 overflow-y-auto md:w-[420px]">
        <div className="space-y-4 px-4 py-4 md:px-6">
          {!selectedProposal ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [select a proposal to inspect voting state]
            </div>
          ) : (
            <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">DETAIL&gt;</div>
              <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                {selectedProposal.proposalType}
              </div>
              <div className="mt-3 space-y-2 text-xs text-bbs-lightgray">
                <div>status: {selectedProposal.status}</div>
                <div>title hash: {formatCompact(selectedProposal.titleHash)}</div>
                <div>payload: {selectedProposal.payloadPreview || '--'}</div>
                <div>voting closes: {formatTimestamp(selectedProposal.votingDeadline)}</div>
                <div>execution after: {formatTimestamp(selectedProposal.executionAfter)}</div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
                <button
                  type="button"
                  onClick={() => onVote(selectedProposal.proposalPda, true)}
                  className="border border-bbs-green/40 bg-bbs-black px-3 py-2 text-bbs-green transition-colors hover:text-bbs-white"
                >
                  [vote yes]
                </button>
                <button
                  type="button"
                  onClick={() => onVote(selectedProposal.proposalPda, false)}
                  className="border border-bbs-red/40 bg-bbs-black px-3 py-2 text-bbs-red transition-colors hover:text-bbs-white"
                >
                  [vote no]
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
