import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getManagedFilePath,
} from '../src/utils/settings/managedPath.js';
import {
  fireRawRead,
  getMdmRawReadPromise,
  startMdmRawRead,
} from '../src/utils/settings/mdm/rawRead.js';

describe('hermetic managed-policy path', () => {
  it('routes marked Vitest workers into the minted test home', () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME;

    expect(hermeticHome).toBeTruthy();
    expect(process.env.VITEST).toBe('true');
    expect(getManagedFilePath()).toBe(join(hermeticHome as string, 'managed-policy'));
  });

  it('replaces MDM I/O at the Vitest module boundary', async () => {
    await expect(fireRawRead()).resolves.toEqual({
      hkcuStdout: null,
      hklmStdout: null,
      plistStdouts: null,
    });
    expect(getMdmRawReadPromise()).toBeNull();
    startMdmRawRead();
    await expect(getMdmRawReadPromise()).resolves.toEqual({
      hkcuStdout: null,
      hklmStdout: null,
      plistStdouts: null,
    });
  });
});
