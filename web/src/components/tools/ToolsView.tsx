import { useEffect, useMemo, useState } from 'react';
import type { ToolInfo } from '../../types';
import { SkillCard } from '../skills/SkillCard';

interface ToolsViewProps {
  tools: ToolInfo[];
  onRefresh: () => void;
  onToggle: (name: string, enabled: boolean) => void;
}

const INPUT_CLASS =
  'w-full border border-bbs-border bg-bbs-surface px-3 py-2 text-sm text-bbs-lightgray placeholder:text-bbs-gray outline-none focus:border-bbs-purple-dim';

export function ToolsView({ tools, onRefresh, onToggle }: ToolsViewProps) {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const filtered = useMemo(() => {
    if (!filter) return tools;
    const normalized = filter.toLowerCase();
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(normalized) ||
        tool.description.toLowerCase().includes(normalized),
    );
  }, [filter, tools]);

  const enabledCount = tools.filter((tool) => tool.enabled).length;

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="shrink-0 border-b border-bbs-border bg-bbs-surface px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="shrink-0 text-xs text-bbs-purple">TOOLS&gt;</span>
              <div className="min-w-0">
                <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-bbs-white">
                  Runtime Tool Registry
                </h2>
                <p className="mt-1 text-xs text-bbs-gray">
                  internal operator tools loaded into the current runtime
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] uppercase tracking-[0.14em] text-bbs-gray">
              [{enabledCount}/{tools.length} enabled]
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [REFRESH]
            </button>
          </div>
        </div>
      </header>

      <div className="shrink-0 border-b border-bbs-border bg-bbs-dark/40 px-4 py-4 md:px-6">
        <div className="max-w-3xl">
          <label className="block text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
            Search Tools
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="search by tool name or description"
              className={`${INPUT_CLASS} max-w-2xl min-w-[16rem] flex-1`}
            />
            <span className="text-xs text-bbs-gray">[{filtered.length} results]</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
        <div className="mx-auto max-w-3xl space-y-2">
          {filtered.length === 0 ? (
            <div className="border border-dashed border-bbs-border px-4 py-8 text-center text-sm text-bbs-gray">
              {tools.length === 0 ? 'no tools registered' : 'no tools match the current search'}
            </div>
          ) : (
            filtered.map((tool, index) => (
              <div key={tool.name} className="animate-list-item" style={{ animationDelay: `${index * 35}ms` }}>
                <SkillCard skill={tool} onToggle={onToggle} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
