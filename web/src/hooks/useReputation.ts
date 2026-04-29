import { useCallback, useState } from 'react';
import type { ReputationSummaryInfo, WSMessage } from '../types';

interface UseReputationOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseReputationReturn {
  summary: ReputationSummaryInfo | null;
  refresh: () => void;
  stake: (amount: string) => void;
  delegate: (params: {
    amount: number;
    delegateeAgentPda?: string;
    delegateeAgentId?: string;
    expiresAt?: number;
  }) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useReputation({ send }: UseReputationOptions): UseReputationReturn {
  const [summary, setSummary] = useState<ReputationSummaryInfo | null>(null);

  const refresh = useCallback(() => {
    send({ type: 'market.reputation.summary' });
  }, [send]);

  const stake = useCallback((amount: string) => {
    send({ type: 'market.reputation.stake', payload: { amount } });
  }, [send]);

  const delegate = useCallback((params: {
    amount: number;
    delegateeAgentPda?: string;
    delegateeAgentId?: string;
    expiresAt?: number;
  }) => {
    send({ type: 'market.reputation.delegate', payload: params });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'market.reputation.summary') {
      setSummary((msg.payload as ReputationSummaryInfo) ?? null);
    }
  }, []);

  return { summary, refresh, stake, delegate, handleMessage };
}
