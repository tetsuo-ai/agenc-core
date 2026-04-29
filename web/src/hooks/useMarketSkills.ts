import { useCallback, useState } from 'react';
import type { MarketplaceSkillInfo, WSMessage } from '../types';

interface UseMarketSkillsOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseMarketSkillsReturn {
  skills: MarketplaceSkillInfo[];
  selectedSkill: MarketplaceSkillInfo | null;
  refresh: (query?: string) => void;
  inspect: (skillPda: string) => void;
  purchase: (skillPda: string, skillId: string) => void;
  rate: (skillPda: string, rating: number, review?: string) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useMarketSkills({ send }: UseMarketSkillsOptions): UseMarketSkillsReturn {
  const [skills, setSkills] = useState<MarketplaceSkillInfo[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkillInfo | null>(null);

  const refresh = useCallback((query?: string) => {
    send({ type: 'market.skills.list', payload: query ? { query } : {} });
  }, [send]);

  const inspect = useCallback((skillPda: string) => {
    send({ type: 'market.skills.detail', payload: { skillPda } });
  }, [send]);

  const purchase = useCallback((skillPda: string, skillId: string) => {
    send({ type: 'market.skills.purchase', payload: { skillPda, skillId } });
  }, [send]);

  const rate = useCallback((skillPda: string, rating: number, review?: string) => {
    send({
      type: 'market.skills.rate',
      payload: { skillPda, rating, ...(review ? { review } : {}) },
    });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'market.skills.list') {
      setSkills((msg.payload as MarketplaceSkillInfo[]) ?? []);
      return;
    }
    if (msg.type === 'market.skills.detail') {
      setSelectedSkill((msg.payload as MarketplaceSkillInfo) ?? null);
      return;
    }
    if (msg.type === 'market.skills.purchased' && selectedSkill) {
      setSelectedSkill({ ...selectedSkill, purchased: true });
    }
  }, [selectedSkill]);

  return { skills, selectedSkill, refresh, inspect, purchase, rate, handleMessage };
}
