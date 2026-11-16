import type { AdmissionUsageSummary } from '../budget/admission-types.js';
import { formatUsdCost } from './cost.js';

export type DisplayUsage = Pick<AdmissionUsageSummary, 'costUsd' | 'hasUnknownCost' | 'costEstimated' |
  'billedEstimateUsd' | 'hasOffPeakDiscount' | 'hasMissingDispatchTime' | 'planCalls' | 'meteredCalls' |
  'includesSubagents' | 'cachedInputTokens' | 'cacheInputTokens' | 'cacheUnreportedCalls'> & {
  /** Per-model rows, read only to name the plan ("ChatGPT plan"). */
  readonly models?: readonly { readonly provider?: string; readonly planCalls?: number }[];
};

/**
 * The money of a session for the status line. A session whose ledger records
 * billing routes always shows a billed amount, "$0.00 billed" included, so a
 * subscription never stands alone without a figure; `swarm` leads the amount
 * when it includes sub-agents. The plan itself is named by `usagePlanLabel`.
 */
export function sessionSpendLabel(usage: DisplayUsage): string {
  // Old summaries have no billing-route evidence. Keep their accounting label.
  if (usage.planCalls === undefined && usage.includesSubagents !== true) {
    return usage.costEstimated ? 'price unknown' :
      `${usage.hasUnknownCost ? '≥' : ''}${formatUsdCost(usage.billedEstimateUsd ?? usage.costUsd)}`;
  }
  if (usage.costEstimated) return 'price unknown';
  return `${usage.includesSubagents ? 'swarm ' : ''}${usage.hasUnknownCost ? '≥' : ''}` +
    `${formatUsdCost(usage.billedEstimateUsd ?? usage.costUsd)} billed` +
    (usage.hasMissingDispatchTime ? ' peak est.' : usage.hasOffPeakDiscount ? ' off-peak' : '');
}

/** The name of a subscription plan by provider: ChatGPT for OpenAI sign-in. */
export function planLabelFor(providers: readonly (string | undefined)[]): string {
  return providers.length > 0 && providers.every(provider => provider === 'openai') ? 'ChatGPT plan' : 'subscription plan';
}

/** The plan that covers this session's plan calls, or null when it has none. Never a bare "plan". */
export function usagePlanLabel(usage: Pick<AdmissionUsageSummary, 'planCalls'> & {
  readonly models?: readonly { readonly provider?: string; readonly planCalls?: number }[];
}): string | null {
  if ((usage.planCalls ?? 0) <= 0) return null;
  return planLabelFor((usage.models ?? []).filter(row => (row.planCalls ?? 0) > 0).map(row => row.provider));
}

/** "(1 call unknown)" for calls that reported no cache count; empty when every call did. */
export function cacheUnknownNote(calls: number | undefined): string {
  return (calls ?? 0) > 0 ? `(${calls} ${calls === 1 ? 'call' : 'calls'} unknown)` : '';
}

/** The denominator contains only calls that actually reported cache usage. */
export function usageCachePercent(usage: Pick<DisplayUsage, 'cachedInputTokens' | 'cacheInputTokens'>): number | null {
  const input = usage.cacheInputTokens ?? 0;
  if (input <= 0 || usage.cachedInputTokens === undefined) return null;
  const cached = Math.min(input, usage.cachedInputTokens);
  return Math.min(cached < input ? 99 : 100, Math.round(cached / input * 100));
}
