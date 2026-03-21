import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTools } from './useTools';
import type { WSMessage } from '../types';

type UseToolsHook = ReturnType<typeof useTools> & { handleMessage: (msg: WSMessage) => void };

describe('useTools', () => {
  it('sends refresh/toggle payloads', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useTools({ send }));

    act(() => {
      result.current.refresh();
    });
    act(() => {
      result.current.toggle('desk', true);
    });

    expect(send).toHaveBeenNthCalledWith(1, { type: 'tools.list' });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'tools.toggle',
      payload: { skillName: 'desk', enabled: true },
    });
  });

  it('handles tools.list response', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useTools({ send }));

    act(() => {
      (result.current as UseToolsHook).handleMessage({
        type: 'tools.list',
        payload: [{ name: 'desk', description: 'Desktop automation', enabled: true }],
      });
    });

    expect(result.current.tools).toEqual([
      { name: 'desk', description: 'Desktop automation', enabled: true },
    ]);
  });
});
