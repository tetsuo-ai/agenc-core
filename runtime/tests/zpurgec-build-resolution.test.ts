import { describe, expect, it } from 'vitest'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __agencBuildConfigTest } from '../build.config.ts'

const runtimeRoot = dirname(fileURLToPath(import.meta.url))
const repoRuntimeRoot = resolve(runtimeRoot, '..')

function runtimeRel(file: string | null): string | null {
  return file ? relative(repoRuntimeRoot, file).split(/[\\/]+/).join('/') : null
}

describe('Z-PURGEC build resolution boundaries', () => {
  it('does not classify migrated files from ts-nocheck comments alone', () => {
    const importer = resolve(repoRuntimeRoot, 'src/services/api/client.ts')

    expect(__agencBuildConfigTest.shouldUseAgenCResolution(importer)).toBe(false)
    expect(
      __agencBuildConfigTest.resolveRelativeAgenCSource(importer, './missing-module.js'),
    ).toBeNull()
  })

  it('resolves real migrated src aliases and fails missing aliases closed', () => {
    expect(
      runtimeRel(__agencBuildConfigTest.resolveAgenCBareSrc('src/components/SearchBox.js')),
    ).toBe('src/tui/components/SearchBox.tsx')
    expect(__agencBuildConfigTest.resolveAgenCBareSrc('src/not-present.js')).toBeNull()
  })

  it('does not mark missing runtime modules as optional externals', () => {
    expect(__agencBuildConfigTest.isKnownMissingOptionalModule('./tools/SleepTool/SleepTool.js')).toBe(false)
    expect(__agencBuildConfigTest.isKnownMissingOptionalModule('../tools/SleepTool/SleepTool.js')).toBe(false)
    expect(__agencBuildConfigTest.isKnownMissingOptionalModule('./not-present.js')).toBe(false)
    expect(__agencBuildConfigTest.isKnownMissingOptionalModule('@mendable/firecrawl-js')).toBe(true)
  })

  it('inlines copied-tree feature gates before unresolved import resolution', () => {
    expect(__agencBuildConfigTest.featureFlagLiteral('HISTORY_SNIP')).toBe('false')
    expect(__agencBuildConfigTest.featureFlagLiteral('CONTEXT_COLLAPSE')).toBe('false')
    expect(__agencBuildConfigTest.featureFlagLiteral('MCP_SKILLS')).toBe('true')
    expect(__agencBuildConfigTest.featureFlagLiteral('NOT_A_REAL_FLAG')).toBe('false')
    expect(
      __agencBuildConfigTest.inlineCopiedTreeFeatureCalls(
        "const x = feature('HISTORY_SNIP') ? require('./missing.js') : null; const y = feature(\"MCP_SKILLS\")",
      ),
    ).toBe("const x = false ? require('./missing.js') : null; const y = true")
    expect(
      __agencBuildConfigTest.inlineCopiedTreeFeatureCalls(
        "const x = feature(\n  'EXPERIMENTAL_SKILL_SEARCH',\n) ? require('./missing.js') : null",
      ),
    ).toBe("const x = false ? require('./missing.js') : null")
  })
})
