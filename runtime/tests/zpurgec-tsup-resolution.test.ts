import { describe, expect, it } from 'vitest'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __agencTsupAliasTest } from '../tsup.config.ts'

const runtimeRoot = dirname(fileURLToPath(import.meta.url))
const repoRuntimeRoot = resolve(runtimeRoot, '..')

function runtimeRel(file: string | null): string | null {
  return file ? relative(repoRuntimeRoot, file).split(/[\\/]+/).join('/') : null
}

describe('Z-PURGEC tsup resolution boundaries', () => {
  it('does not classify migrated files from ts-nocheck comments alone', () => {
    const importer = resolve(repoRuntimeRoot, 'src/services/api/client.ts')

    expect(__agencTsupAliasTest.shouldUseAgenCResolution(importer)).toBe(false)
    expect(
      __agencTsupAliasTest.resolveRelativeAgenCSource(importer, './missing-module.js'),
    ).toBeNull()
  })

  it('resolves real migrated src aliases and fails missing aliases closed', () => {
    expect(
      runtimeRel(__agencTsupAliasTest.resolveAgenCBareSrc('src/components/SearchBox.js')),
    ).toBe('src/tui/components/SearchBox.tsx')
    expect(__agencTsupAliasTest.resolveAgenCBareSrc('src/not-present.js')).toBeNull()
  })

  it('does not mark missing runtime modules as optional externals', () => {
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('./tools/SleepTool/SleepTool.js')).toBe(false)
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('../tools/SleepTool/SleepTool.js')).toBe(false)
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('./not-present.js')).toBe(false)
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('@mendable/firecrawl-js')).toBe(true)
  })

  it('inlines copied-tree feature gates before unresolved import resolution', () => {
    expect(__agencTsupAliasTest.featureFlagLiteral('HISTORY_SNIP')).toBe('false')
    expect(__agencTsupAliasTest.featureFlagLiteral('CONTEXT_COLLAPSE')).toBe('false')
    expect(__agencTsupAliasTest.featureFlagLiteral('MCP_SKILLS')).toBe('true')
    expect(__agencTsupAliasTest.featureFlagLiteral('NOT_A_REAL_FLAG')).toBe('false')
    expect(
      __agencTsupAliasTest.inlineCopiedTreeFeatureCalls(
        "const x = feature('HISTORY_SNIP') ? require('./missing.js') : null; const y = feature(\"MCP_SKILLS\")",
      ),
    ).toBe("const x = false ? require('./missing.js') : null; const y = true")
    expect(
      __agencTsupAliasTest.inlineCopiedTreeFeatureCalls(
        "const x = feature(\n  'EXPERIMENTAL_SKILL_SEARCH',\n) ? require('./missing.js') : null",
      ),
    ).toBe("const x = false ? require('./missing.js') : null")
  })
})
