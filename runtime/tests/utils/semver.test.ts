import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { describe, expect, test } from 'vitest'
import * as original from 'semver'
import * as narrowed from '../../src/utils/semver.js'

import runtimeBuildConfig, { __agencBuildConfigTest } from '../../build.config'

const runtimeRoot = resolve(import.meta.dirname, '../..')

describe('semver utilities', () => {
  test('matches the original Node fallback for valid, loose, invalid and prerelease versions', () => {
    const versions = ['1.2.3', 'v1.2.3', '=1.2.3', '1.2.3-alpha.1', '1.2.3+build.1',
      '0.0.0-0', '01.02.03', '26.5.0', '1.2', '', 'invalid', '99999999999999999.0.0']
    const outcome = (call: () => unknown) => {
      try { return { value: call() } }
      catch (error) {
        if (!(error instanceof Error)) throw error
        return { error: error.name, message: error.message }
      }
    }
    for (const a of versions) for (const b of versions) {
      for (const name of ['gt', 'gte', 'lt', 'lte'] as const) {
        expect(outcome(() => narrowed[name](a, b))).toEqual(outcome(() => original[name](a, b, { loose: true })))
      }
      expect(outcome(() => narrowed.order(a, b))).toEqual(outcome(() => original.compare(a, b, { loose: true })))
    }
    for (const version of versions) for (const range of ['*', '^1.2.0', '~1.2', '>=1.2.3-alpha.1 <2',
      '1.x || >=26.0.0', '1.2.3 - 2.0.0', '', 'invalid', '>=0.0.0-0']) {
      expect(outcome(() => narrowed.satisfies(version, range))).toEqual(outcome(() => original.satisfies(version, range, { loose: true })))
    }
  })

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

  test('production-bundles the Node fallback without an installed semver package', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'agenc-semver-bundle-'))
    const artifact = join(artifactRoot, 'semver.mjs')

    try {
      await build({
        entryPoints: [resolve(runtimeRoot, 'src/utils/semver.ts')],
        outfile: artifact,
        bundle: true,
        external: runtimeBuildConfig.external,
        format: runtimeBuildConfig.format[0] as 'esm',
        plugins: [__agencBuildConfigTest.agencOptionalExternal],
        platform: runtimeBuildConfig.platform as 'node',
        target: runtimeBuildConfig.target,
      })

      const source = [
        `import { satisfies } from ${JSON.stringify(pathToFileURL(artifact).href)};`,
        'if (!satisfies("26.5.0", ">=26.5.0 <27.0.0")) process.exitCode = 1;',
      ].join('\n')

      expect(
        execFileSync(
          process.execPath,
          ['--input-type=module', '--eval', source],
          {
            cwd: artifactRoot,
            encoding: 'utf8',
            env: {
              ...process.env,
              NODE_OPTIONS: '',
            },
          },
        ),
      ).toBe('')
    } finally {
      await rm(artifactRoot, { recursive: true, force: true })
    }
  })
})
