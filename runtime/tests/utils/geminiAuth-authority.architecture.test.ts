import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
}

describe('Gemini credential authority', () => {
  test('has no Gemini-specific persisted access-token channel', () => {
    expect(
      existsSync(new URL('../../src/utils/geminiCredentials.ts', import.meta.url)),
    ).toBe(false)
    expect(source('services/api/openaiShim.ts')).not.toContain('geminiCredentials')
    expect(source('utils/secureStorage/index.ts')).not.toMatch(/\bgemini\?\s*:/u)
    expect(source('config/migration.ts')).not.toContain('parsed.gemini')
  })

  test('credential resolution and the native provider never read process environment', () => {
    expect(source('utils/geminiAuth.ts')).not.toContain('process.env')
    expect(source('llm/providers/gemini/index.ts')).not.toContain('process.env')
  })

  test('only the documented project identifiers participate in resolution', () => {
    const authSource = source('utils/geminiAuth.ts')
    expect(authSource).toContain('env.GEMINI_PROJECT_ID')
    expect(authSource).toContain('env.GOOGLE_CLOUD_PROJECT')
    expect(authSource).not.toContain('env.GCLOUD_PROJECT')
    expect(authSource).not.toContain('env.GOOGLE_PROJECT_ID')
  })
})
