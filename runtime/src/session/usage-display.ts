import type { AdmissionUsageSummary } from '../budget/admission-types.js';
import { formatUsdCost } from './cost.js';

export type DisplayUsage = Pick<AdmissionUsageSummary, 'costUsd' | 'hasUnknownCost' | 'costEstimated' |
  'billedEstimateUsd' | 'hasOffPeakDiscount' | 'hasMissingDispatchTime' | 'planCalls' | 'meteredCalls' |
  'includesSubagents' | 'cachedInputTokens' | 'cacheInputTokens' | 'cacheUnreportedCalls'>;

export function sessionSpendLabel(usage: DisplayUsage): string {
  // Old summaries have no billing-route evidence. Keep their accounting label.
  if (usage.planCalls === undefined && usage.includesSubagents !== true) {
    return usage.costEstimated ? 'price unknown' :
      `${usage.hasUnknownCost ? '≥' : ''}${formatUsdCost(usage.billedEstimateUsd ?? usage.costUsd)}`;
  }
  const plan = (usage.planCalls ?? 0) > 0;
  const billed = !plan || (usage.meteredCalls ?? 0) > 0 || usage.costUsd > 0 || usage.hasUnknownCost;
  const money = usage.costEstimated ? 'price unknown' :
    `${usage.hasUnknownCost ? '≥' : ''}${formatUsdCost(usage.billedEstimateUsd ?? usage.costUsd)}${usage.planCalls === undefined ? '' : ' billed'}` +
    (usage.hasMissingDispatchTime ? ' peak est.' : usage.hasOffPeakDiscount ? ' off-peak' : '');
  return [billed ? money : '', plan ? 'plan' : '', usage.includesSubagents ? 'swarm' : ''].filter(Boolean).join(' · ');
}

/** The denominator contains only calls that actually reported cache usage. */
export function usageCachePercent(usage: Pick<DisplayUsage, 'cachedInputTokens' | 'cacheInputTokens'>): number | null {
  const input = usage.cacheInputTokens ?? 0;
  if (input <= 0 || usage.cachedInputTokens === undefined) return null;
  const cached = Math.min(input, usage.cachedInputTokens);
  return Math.min(cached < input ? 99 : 100, Math.round(cached / input * 100));
}
