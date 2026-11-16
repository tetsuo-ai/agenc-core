import type { ProviderFactoryOptions } from '../llm/provider.js';

/** Accounting and display switch. Never changes a provider request. */
export function honestUsageEnabled(): boolean {
  return process.env.AGENC_HONEST_USAGE !== '0';
}

export function isChatGptPlan(provider: string, options: ProviderFactoryOptions): boolean {
  return honestUsageEnabled() && provider === 'openai' && options.extra?.authMode === 'oauth' && options.extra.chatgptBackend === true;
}

/** Recorded with the call, so changing the selected account cannot reprice history. */
export interface UsageBillingDetails {
  readonly billingMode: 'plan' | 'metered';
  readonly cachedInputTokens?: number;
  readonly apiEquivalentUsd?: number;
  readonly apiEquivalentUnknown?: boolean;
  readonly offPeakEligibleCostUsd?: number;
}
