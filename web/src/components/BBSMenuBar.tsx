import { useEffect } from 'react';
import type { ViewId } from '../types';

interface BBSMenuBarProps {
  currentView: ViewId;
  onViewChange: (view: ViewId) => void;
}

const MENU_ITEMS: Array<{ key: string; label: string; title: string; view: ViewId }> = [
  { key: '1', label: 'CHAT', title: 'Chat', view: 'chat' },
  { key: '2', label: 'DASH', title: 'Status', view: 'status' },
  { key: '3', label: 'RUNS', title: 'Runs', view: 'runs' },
  { key: '4', label: 'TRACE', title: 'Observability', view: 'observability' },
  { key: '5', label: 'MARKET', title: 'Marketplace', view: 'marketplace' },
  { key: '6', label: 'TOOLS', title: 'Tools', view: 'tools' },
  { key: '7', label: 'MEMORY', title: 'Memory', view: 'memory' },
  { key: '8', label: 'DESKTOP', title: 'Desktop', view: 'desktop' },
  { key: '9', label: 'FEED', title: 'Activity', view: 'activity' },
  { key: '-', label: 'SIM', title: 'Simulation', view: 'simulation' },
  { key: '0', label: 'SETTINGS', title: 'Settings', view: 'settings' },
];

export function BBSMenuBar({ currentView, onViewChange }: BBSMenuBarProps) {
  // Keyboard shortcuts: number keys 1-9
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const item = MENU_ITEMS.find((m) => m.key === e.key);
      if (item) {
        e.preventDefault();
        onViewChange(item.view);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onViewChange]);

  return (
    <div className="shrink-0 border-b border-bbs-purple-dim bg-bbs-surface overflow-x-auto">
      <div className="flex items-center gap-0 px-2 py-1.5 min-w-max">
        {MENU_ITEMS.map((item) => {
          const isActive = currentView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onViewChange(item.view)}
              title={item.title}
              className={`flex items-center gap-1 px-3 py-1 text-xs transition-colors whitespace-nowrap ${
                isActive
                  ? 'text-bbs-white'
                  : 'text-bbs-gray hover:text-bbs-lightgray'
              }`}
            >
              <span className={isActive ? 'text-bbs-purple' : 'text-bbs-gray'}>[{item.key}]</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
