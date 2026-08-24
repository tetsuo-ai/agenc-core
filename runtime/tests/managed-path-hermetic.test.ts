import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getManagedFilePath,
} from '../src/utils/settings/managedPath.js';

describe('hermetic managed-policy path', () => {
  it('routes marked Vitest workers into the minted test home', () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME;

    expect(hermeticHome).toBeTruthy();
    expect(process.env.VITEST).toBe('true');
    expect(getManagedFilePath()).toBe(join(hermeticHome as string, 'managed-policy'));
  });
});
