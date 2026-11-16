import type { ProviderFactoryOptions } from '../llm/provider.js';

export const PLAN_ACCOUNTING_ENV = 'AGENC_PLAN_ACCOUNTING';
const OFF_VALUES: ReadonlySet<string> = new Set(['off', 'none', '0', 'false', 'no']);

/**
 * Accounting and display switch. Never changes a provider request. On unless
 * AGENC_PLAN_ACCOUNTING is `off` (also `none`, `0`, `false`, `no`).
 */
export function planAccountingEnabled(): boolean {
  return !OFF_VALUES.has((process.env[PLAN_ACCOUNTING_ENV] ?? '').trim().toLowerCase());
}

export function isChatGptPlan(provider: string, options: ProviderFactoryOptions): boolean {
  return planAccountingEnabled() && provider === 'openai' && options.extra?.authMode === 'oauth' && options.extra.chatgptBackend === true;
}

/** Recorded with the call, so changing the selected account cannot reprice history. */
export interface UsageBillingDetails {
  readonly billingMode: 'plan' | 'metered';
  readonly cachedInputTokens?: number;
  readonly apiEquivalentUsd?: number;
  readonly apiEquivalentUnknown?: boolean;
  readonly offPeakEligibleCostUsd?: number;
}
