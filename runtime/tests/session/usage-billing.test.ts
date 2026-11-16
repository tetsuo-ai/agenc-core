import { afterEach, describe, expect, test, vi } from 'vitest';

import { isChatGptPlan, planAccountingEnabled } from '../../src/session/usage-billing.js';

const signIn = { extra: { authMode: 'oauth', chatgptBackend: true } } as never;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AGENC_PLAN_ACCOUNTING', () => {
  test('is on when unset and for unknown values', () => {
    vi.stubEnv('AGENC_PLAN_ACCOUNTING', undefined);
    expect(planAccountingEnabled()).toBe(true);
    for (const value of ['', 'on', '1', 'yes', 'plan']) {
      vi.stubEnv('AGENC_PLAN_ACCOUNTING', value);
      expect(planAccountingEnabled()).toBe(true);
    }
    expect(isChatGptPlan('openai', signIn)).toBe(true);
  });

  test.each(['off', 'OFF', ' off ', 'none', '0', 'false', 'no'])('%j turns plan accounting off', value => {
    vi.stubEnv('AGENC_PLAN_ACCOUNTING', value);
    expect(planAccountingEnabled()).toBe(false);
    expect(isChatGptPlan('openai', signIn)).toBe(false);
  });

  test('the unreleased AGENC_HONEST_USAGE name is not read', () => {
    vi.stubEnv('AGENC_PLAN_ACCOUNTING', undefined);
    vi.stubEnv('AGENC_HONEST_USAGE', '0');
    expect(planAccountingEnabled()).toBe(true);
    expect(isChatGptPlan('openai', signIn)).toBe(true);
  });
});
