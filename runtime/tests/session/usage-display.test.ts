import { expect, it } from 'vitest';
import { sessionSpendLabel, usageCachePercent } from '../../src/session/usage-display.js';
it('keeps off-peak attached to billed money and scopes a mixed swarm', () => {
  expect(sessionSpendLabel({ costUsd: 2.24, billedEstimateUsd: 1.12, hasUnknownCost: false,
    hasOffPeakDiscount: true, planCalls: 1, meteredCalls: 6, includesSubagents: true }))
    .toBe('$1.12 billed off-peak · plan · swarm');
  expect(sessionSpendLabel({ costUsd: 0, hasUnknownCost: false, planCalls: 1, meteredCalls: 0 })).toBe('plan');
  expect(sessionSpendLabel({ costUsd: 0, hasUnknownCost: true, planCalls: 1 })).toBe('≥$0.00 billed · plan');
});
it('never reports 100 percent unless all counted input was cached', () => {
  expect(usageCachePercent({ cachedInputTokens: 999, cacheInputTokens: 1000 })).toBe(99);
  expect(usageCachePercent({ cachedInputTokens: 1000, cacheInputTokens: 1000 })).toBe(100);
  expect(usageCachePercent({})).toBeNull();
});
