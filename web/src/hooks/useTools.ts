import { useCallback, useState } from 'react';
import type { ToolInfo, WSMessage } from '../types';

interface UseToolsOptions {
  send: (msg: Record<string, unknown>) => void;
}

export interface UseToolsReturn {
  tools: ToolInfo[];
  refresh: () => void;
  toggle: (skillName: string, enabled: boolean) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useTools({ send }: UseToolsOptions): UseToolsReturn {
  const [tools, setTools] = useState<ToolInfo[]>([]);

  const refresh = useCallback(() => {
    send({ type: 'tools.list' });
  }, [send]);

  const toggle = useCallback((skillName: string, enabled: boolean) => {
    send({ type: 'tools.toggle', payload: { skillName, enabled } });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'tools.list') {
      setTools((msg.payload as ToolInfo[]) ?? []);
    }
  }, []);

  return { tools, refresh, toggle, handleMessage };
}
