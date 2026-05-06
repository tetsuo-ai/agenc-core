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
      runtimeRel(__agencTsupAliasTest.resolveAgenCBareSrc('src/components/FeedbackSurvey/FeedbackSurvey.js')),
    ).toBe('src/tui/components/FeedbackSurvey/FeedbackSurvey.tsx')
    expect(__agencTsupAliasTest.resolveAgenCBareSrc('src/not-present.js')).toBeNull()
  })

  it('keeps optional missing modules explicit', () => {
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('../tools/SleepTool/SleepTool.js')).toBe(true)
    expect(__agencTsupAliasTest.isKnownMissingOptionalModule('./not-present.js')).toBe(false)
  })
})
