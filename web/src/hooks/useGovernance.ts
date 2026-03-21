import { useCallback, useState } from 'react';
import type { GovernanceProposalInfo, WSMessage } from '../types';

interface UseGovernanceOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseGovernanceReturn {
  proposals: GovernanceProposalInfo[];
  selectedProposal: GovernanceProposalInfo | null;
  refresh: (status?: string) => void;
  inspect: (proposalPda: string) => void;
  vote: (proposalPda: string, approve: boolean) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useGovernance({ send }: UseGovernanceOptions): UseGovernanceReturn {
  const [proposals, setProposals] = useState<GovernanceProposalInfo[]>([]);
  const [selectedProposal, setSelectedProposal] = useState<GovernanceProposalInfo | null>(null);

  const refresh = useCallback((status?: string) => {
    send({ type: 'market.governance.list', payload: status ? { status } : {} });
  }, [send]);

  const inspect = useCallback((proposalPda: string) => {
    send({ type: 'market.governance.detail', payload: { proposalPda } });
  }, [send]);

  const vote = useCallback((proposalPda: string, approve: boolean) => {
    send({ type: 'market.governance.vote', payload: { proposalPda, approve } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'market.governance.list') {
      setProposals((msg.payload as GovernanceProposalInfo[]) ?? []);
      return;
    }
    if (msg.type === 'market.governance.detail') {
      setSelectedProposal((msg.payload as GovernanceProposalInfo) ?? null);
    }
  }, []);

  return { proposals, selectedProposal, refresh, inspect, vote, handleMessage };
}
