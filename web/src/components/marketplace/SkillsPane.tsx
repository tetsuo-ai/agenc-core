import { useMemo, useState } from 'react';
import type { MarketplaceSkillInfo } from '../../types';
import { formatCompact, formatTimestamp } from './shared';

interface SkillsPaneProps {
  skills: MarketplaceSkillInfo[];
  selectedSkill: MarketplaceSkillInfo | null;
  onRefresh: () => void;
  onInspect: (skillPda: string) => void;
  onPurchase: (skillPda: string, skillId: string) => void;
  onRate: (skillPda: string, rating: number, review?: string) => void;
}

export function SkillsPane({
  skills,
  selectedSkill,
  onRefresh,
  onInspect,
  onPurchase,
  onRate,
}: SkillsPaneProps) {
  const [search, setSearch] = useState('');
  const [ratingValue, setRatingValue] = useState('5');
  const [ratingReview, setRatingReview] = useState('');

  const filteredSkills = useMemo(() => {
    if (!search) return skills;
    const normalized = search.toLowerCase();
    return skills.filter((skill) =>
      skill.name.toLowerCase().includes(normalized)
      || skill.author.toLowerCase().includes(normalized)
      || skill.tags.some((tag) => tag.toLowerCase().includes(normalized)),
    );
  }, [search, skills]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex min-h-0 flex-1 flex-col border-b border-bbs-border md:border-b-0 md:border-r">
        <div className="border-b border-bbs-border bg-bbs-dark/70 px-4 py-3 md:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="filter skill registrations"
              className="min-w-[16rem] flex-1 border border-bbs-border bg-bbs-black px-3 py-2 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
            />
            <button
              type="button"
              onClick={onRefresh}
              className="border border-bbs-border bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
            >
              [refresh]
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
          <div className="space-y-3">
            {filteredSkills.map((skill) => (
              <button
                key={skill.skillPda}
                type="button"
                onClick={() => onInspect(skill.skillPda)}
                className="w-full border border-bbs-border bg-bbs-dark px-4 py-4 text-left transition-colors hover:border-bbs-purple-dim hover:bg-bbs-surface"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">SKILL&gt;</div>
                    <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                      {skill.name}
                    </div>
                    <div className="mt-2 text-xs text-bbs-gray">
                      {skill.tags.length > 0 ? skill.tags.join(', ') : 'untagged'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs uppercase tracking-[0.14em] text-bbs-gray">
                    <div>[{skill.isActive ? 'active' : 'inactive'}]</div>
                    <div className="mt-2 text-bbs-lightgray">
                      {skill.priceSol ? `${skill.priceSol} SOL` : skill.priceLamports}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {filteredSkills.length === 0 && (
              <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
                [no marketplace skills found]
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 w-full shrink-0 overflow-y-auto md:w-[420px]">
        <div className="space-y-4 px-4 py-4 md:px-6">
          {!selectedSkill ? (
            <div className="border border-dashed border-bbs-border bg-bbs-dark px-5 py-8 text-center text-xs uppercase tracking-[0.16em] text-bbs-gray">
              [select a skill to inspect purchase and rating state]
            </div>
          ) : (
            <>
              <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">DETAIL&gt;</div>
                <div className="mt-2 text-sm font-bold uppercase tracking-[0.08em] text-bbs-white">
                  {selectedSkill.name}
                </div>
                <div className="mt-3 space-y-2 text-xs text-bbs-lightgray">
                  <div>author: {formatCompact(selectedSkill.author)}</div>
                  <div>skill id: {formatCompact(selectedSkill.skillId)}</div>
                  <div>content hash: {selectedSkill.contentHash ? formatCompact(selectedSkill.contentHash) : '--'}</div>
                  <div>rating: {selectedSkill.rating.toFixed(2)} ({selectedSkill.ratingCount} ratings)</div>
                  <div>downloads: {selectedSkill.downloads}</div>
                  <div>updated: {formatTimestamp(selectedSkill.updatedAt)}</div>
                  <div>installed: {selectedSkill.purchased ? 'yes' : 'unknown'}</div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em]">
                  <button
                    type="button"
                    onClick={() => onPurchase(selectedSkill.skillPda, selectedSkill.skillId)}
                    className="border border-bbs-green/40 bg-bbs-black px-3 py-2 text-bbs-green transition-colors hover:text-bbs-white"
                  >
                    [purchase]
                  </button>
                  <button
                    type="button"
                    onClick={() => onInspect(selectedSkill.skillPda)}
                    className="border border-bbs-border bg-bbs-black px-3 py-2 text-bbs-gray transition-colors hover:border-bbs-purple-dim hover:text-bbs-white"
                  >
                    [reload]
                  </button>
                </div>
              </div>

              <div className="border border-bbs-border bg-bbs-dark px-4 py-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-purple">RATE&gt;</div>
                <div className="mt-3 grid gap-3">
                  <select
                    value={ratingValue}
                    onChange={(event) => setRatingValue(event.target.value)}
                    className="w-full border border-bbs-border bg-bbs-black px-3 py-3 text-sm text-bbs-white outline-none focus:border-bbs-purple-dim"
                  >
                    {[5, 4, 3, 2, 1].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                  <textarea
                    value={ratingReview}
                    onChange={(event) => setRatingReview(event.target.value)}
                    rows={4}
                    placeholder="optional review note"
                    className="w-full resize-none border border-bbs-border bg-bbs-black px-3 py-3 text-sm text-bbs-white outline-none transition-colors placeholder:text-bbs-gray focus:border-bbs-purple-dim"
                  />
                  <button
                    type="button"
                    onClick={() => onRate(selectedSkill.skillPda, Number(ratingValue), ratingReview.trim() || undefined)}
                    className="border border-bbs-cyan/40 bg-bbs-black px-3 py-2 text-xs uppercase tracking-[0.14em] text-bbs-cyan transition-colors hover:text-bbs-white"
                  >
                    [submit rating]
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
