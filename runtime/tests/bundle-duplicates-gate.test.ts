import { describe, expect, it } from 'vitest'
import {
  assertNoDuplicatePackages,
  collectDuplicatePackages,
  packageNameFromNodeModulesPath,
  packageNameFromSpecifier,
} from '../scripts/check-bundle-duplicates.mjs'

function metafile({
  inputs = {},
  outputs = {},
}: {
  inputs?: Record<string, { bytes: number; imports: unknown[] }>
  outputs?: Record<string, { imports: Array<{ path: string; kind: string; external?: boolean }> }>
} = {}) {
  return { inputs, outputs }
}

describe('bundle duplicates gate', () => {
  it('parses package names from node_modules paths and bare specifiers', () => {
    expect(packageNameFromNodeModulesPath('../node_modules/chalk/source/index.js')).toBe('chalk')
    expect(packageNameFromNodeModulesPath('node_modules/@scope/pkg/lib/x.js')).toBe('@scope/pkg')
    expect(
      packageNameFromNodeModulesPath('../node_modules/foo/node_modules/bar/index.js'),
    ).toBe('bar')
    expect(packageNameFromNodeModulesPath('src/version.ts')).toBeNull()

    expect(packageNameFromSpecifier('chalk')).toBe('chalk')
    expect(packageNameFromSpecifier('@scope/pkg/sub')).toBe('@scope/pkg')
    expect(packageNameFromSpecifier('./chunk.js')).toBeNull()
    expect(packageNameFromSpecifier('/abs/path.js')).toBeNull()
    expect(packageNameFromSpecifier('node:fs')).toBeNull()
  })

  it('flags a package that is both inlined and imported from node_modules', () => {
    const duplicate = metafile({
      inputs: {
        '../node_modules/chalk/source/index.js': { bytes: 5902, imports: [] },
      },
      outputs: {
        'dist/chunk-a.js': {
          imports: [{ path: 'chalk', kind: 'import-statement', external: true }],
        },
      },
    })

    expect(collectDuplicatePackages(duplicate).map((entry) => entry.package)).toEqual(['chalk'])
    expect(() => assertNoDuplicatePackages(duplicate)).toThrow(
      /\[check-bundle-duplicates\][\s\S]*chalk/,
    )
  })

  it('flags the innermost package of a nested node_modules install', () => {
    const nested = metafile({
      inputs: {
        '../node_modules/foo/node_modules/bar/index.js': { bytes: 10, imports: [] },
      },
      outputs: {
        'dist/chunk-a.js': {
          imports: [{ path: 'bar', kind: 'import-statement', external: true }],
        },
      },
    })

    expect(collectDuplicatePackages(nested).map((entry) => entry.package)).toEqual(['bar'])
  })

  it('accepts packages that are only bundled or only loaded from node_modules', () => {
    const clean = metafile({
      inputs: {
        // Bundled everywhere via noExternal; nothing imports it externally.
        '../node_modules/lodash-es/eq.js': { bytes: 797, imports: [] },
      },
      outputs: {
        'dist/chunk-a.js': {
          imports: [
            // External everywhere; no inlined inputs.
            { path: 'react', kind: 'import-statement', external: true },
            { path: 'react/jsx-runtime', kind: 'import-statement', external: true },
            // Builtins and internal chunk imports are not packages.
            { path: 'node:fs', kind: 'import-statement', external: true },
            { path: './chunk-b.js', kind: 'import-statement' },
          ],
        },
      },
    })

    expect(collectDuplicatePackages(clean)).toEqual([])
    expect(() => assertNoDuplicatePackages(clean)).not.toThrow()
  })
})
