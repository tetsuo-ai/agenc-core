import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  HERMETIC_DESIGN_INPUT_ENV_VARS,
  HERMETIC_MARKER_ENV_VAR,
} from './helpers/hermetic-env.mjs';

const HERMETIC_ENV_CONTRACT = JSON.parse(
  readFileSync(
    new URL('./fixtures/hermetic-env-contract.json', import.meta.url),
    'utf8',
  ),
) as string[];

describe('least-privilege design environment', () => {
  it('runs setup, preserves only design inputs, and isolates home state', () => {
    expect(process.env[HERMETIC_MARKER_ENV_VAR]).toBe('1');
    expect(process.env.AGENC_HOME).toBe(process.env.AGENC_CONFIG_DIR);
    expect(process.env.HOME).toBe(process.env.AGENC_HOME);

    const preserved = new Set<string>(HERMETIC_DESIGN_INPUT_ENV_VARS);
    expect(
      HERMETIC_ENV_CONTRACT.filter(
        (name) => !preserved.has(name) && process.env[name] !== undefined,
      ),
    ).toEqual([]);

    const prefix = process.env.AGENC_TEST_DESIGN_ENV_PROBE;
    if (prefix !== undefined) {
      for (const name of HERMETIC_DESIGN_INPUT_ENV_VARS) {
        expect(process.env[name]).toBe(`${prefix}-${name}`);
      }
    }
  });
});
