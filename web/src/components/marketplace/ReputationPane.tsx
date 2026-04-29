import { useState } from 'react';
import type { ReputationSummaryInfo } from '../../types';
import { formatCompact, formatTimestamp } from './shared';

interface ReputationPaneProps {
  reputation: ReputationSummaryInfo | null;
  onStake: (amount: string) => void;
  onDelegate: (params: {
    amount: number;
    delegateeAgentPda?: string;
    delegateeAgentId?: string;
    expiresAt?: number;
  }) => void;
}

export function ReputationPane({
  reputation,
  onStake,
  onDelegate,
}: ReputationPaneProps) {
  const [delegateeAgentPda, setDelegateeAgentPda] = useState('');
  const [delegateAmount, setDelegateAmount] = useState('100');
  const [stakeAmount, setStakeAmount] = useState('');

  return (
    <div className="h-full overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">SCORE&gt;</div>
            <div className="mt-3 text-2xl font-bold text-bbs-white">
              {reputation?.effectiveReputation ?? '--'}
            </div>
            <div className="mt-2 text-xs text-bbs-gray">
              base {reputation?.baseReputation ?? '--'}
            </div>
          </div>
          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">STAKE&gt;</div>
            <div className="mt-3 text-2xl font-bold text-bbs-white">
              {reputation?.stakedAmountSol ?? '--'}
            </div>
            <div className="mt-2 text-xs text-bbs-gray">
              locked until {formatTimestamp(reputation?.lockedUntil)}
            </div>
          </div>
          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">EARNED&gt;</div>
            <div className="mt-3 text-2xl font-bold text-bbs-white">
              {reputation?.totalEarnedSol ?? '--'}
            </div>
            <div className="mt-2 text-xs text-bbs-gray">
              tasks {reputation?.tasksCompleted ?? '--'}
            </div>
          </div>
        </div>

        {!reputation?.registered && (
          <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
            [no signer-backed agent registration found for this runtime wallet]
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">STAKE MORE&gt;</div>
            <input
              type="text"
              value={stakeAmount}
              onChange={(event) => setStakeAmount(event.target.value)}
              placeholder="lamports"
              className="mt-3 w-full border border-bbs-border bg-bbs-black px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
            />
            <button
              type="button"
              onClick={() => onStake(stakeAmount)}
              className="mt-3 border border-bbs-green/40 bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-green transition-colors hover:text-bbs-white"
            >
              [stake]
            </button>
          </div>

          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">DELEGATE&gt;</div>
            <div className="mt-3 grid gap-3">
              <input
                type="text"
                value={delegateeAgentPda}
                onChange={(event) => setDelegateeAgentPda(event.target.value)}
                placeholder="delegatee agent pda"
                className="w-full border border-bbs-border bg-bbs-black px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
              />
              <input
                type="number"
                value={delegateAmount}
                onChange={(event) => setDelegateAmount(event.target.value)}
                placeholder="reputation points"
                className="w-full border border-bbs-border bg-bbs-black px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
              />
              <button
                type="button"
                onClick={() => onDelegate({ amount: Number(delegateAmount), delegateeAgentPda: delegateeAgentPda.trim() || undefined })}
                className="border border-bbs-cyan/40 bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-cyan transition-colors hover:text-bbs-white"
              >
                [delegate]
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">INBOUND&gt;</div>
            <div className="mt-3 space-y-2 text-xs text-bbs-lightgray">
              {(reputation?.inboundDelegations ?? []).map((entry) => (
                <div key={`${entry.delegator}:${entry.createdAt}`} className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
                  <div>{formatCompact(entry.delegator ?? '--')}</div>
                  <div className="mt-1 text-bbs-gray">{entry.amount} pts</div>
                </div>
              ))}
              {(reputation?.inboundDelegations ?? []).length === 0 && <div className="text-bbs-gray">--</div>}
            </div>
          </div>

          <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
            <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">OUTBOUND&gt;</div>
            <div className="mt-3 space-y-2 text-xs text-bbs-lightgray">
              {(reputation?.outboundDelegations ?? []).map((entry) => (
                <div key={`${entry.delegatee}:${entry.createdAt}`} className="border border-bbs-border bg-bbs-black/40 px-3 py-2">
                  <div>{formatCompact(entry.delegatee ?? '--')}</div>
                  <div className="mt-1 text-bbs-gray">{entry.amount} pts</div>
                </div>
              ))}
              {(reputation?.outboundDelegations ?? []).length === 0 && <div className="text-bbs-gray">--</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
