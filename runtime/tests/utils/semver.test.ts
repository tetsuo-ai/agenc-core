import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import { describe, expect, test } from 'vitest'

import runtimeBuildConfig, { __agencBuildConfigTest } from '../../build.config'

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
