import { useCallback, useState } from 'react';
import type { DisputeInfo, WSMessage } from '../types';

interface UseDisputesOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseDisputesReturn {
  disputes: DisputeInfo[];
  selectedDispute: DisputeInfo | null;
  refresh: (status?: string) => void;
  inspect: (disputePda: string) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useDisputes({ send }: UseDisputesOptions): UseDisputesReturn {
  const [disputes, setDisputes] = useState<DisputeInfo[]>([]);
  const [selectedDispute, setSelectedDispute] = useState<DisputeInfo | null>(null);

  const refresh = useCallback((status?: string) => {
    send({ type: 'market.disputes.list', payload: status ? { status } : {} });
  }, [send]);

  const inspect = useCallback((disputePda: string) => {
    send({ type: 'market.disputes.detail', payload: { disputePda } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'market.disputes.list') {
      setDisputes((msg.payload as DisputeInfo[]) ?? []);
      return;
    }
    if (msg.type === 'market.disputes.detail') {
      setSelectedDispute((msg.payload as DisputeInfo) ?? null);
    }
  }, []);

  return { disputes, selectedDispute, refresh, inspect, handleMessage };
}
