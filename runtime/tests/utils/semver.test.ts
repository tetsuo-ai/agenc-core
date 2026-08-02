import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

const runtimeRoot = resolve(import.meta.dirname, '../..')

describe('semver utilities', () => {
  test('loads the npm fallback from a native Node ESM source import', () => {
    const source = [
      'import { satisfies } from "./src/utils/semver.ts";',
      'if (!satisfies("26.5.0", ">=26.5.0 <27.0.0")) process.exitCode = 1;',
    ].join('\n')

    expect(
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '--eval', source],
        {
          cwd: runtimeRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
          },
        },
      ),
    ).toBe('')
  })
})
