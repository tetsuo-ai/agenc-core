import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = readFileSync(
  new URL('./UserPromptMessage.tsx', import.meta.url),
  'utf8',
)

describe('UserPromptMessage feature flags', () => {
  test('uses AgenC-owned brief layout flag names', () => {
    expect(source).not.toContain('tengu_kairos_brief')
    expect(source).toContain('agenc_kairos_brief')
  })
})
