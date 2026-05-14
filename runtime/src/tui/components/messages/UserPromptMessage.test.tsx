import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
  getUserPromptTruncationNotice,
  truncateUserPromptDisplayText,
} from './UserPromptMessage.js'

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

describe('UserPromptMessage truncation glyphs', () => {
  test('uses shared ellipsis glyphs for truncation notices', () => {
    expect(getUserPromptTruncationNotice(3)).toBe('… +3 lines …')
    expect(getUserPromptTruncationNotice(3, { AGENC_TUI_GLYPHS: 'ascii' })).toBe('... +3 lines ...')
  })

  test('uses ascii truncation markers when requested', () => {
    const text = `${'a'.repeat(2_500)}\n${'middle\n'.repeat(900)}${'z'.repeat(2_500)}`
    const output = truncateUserPromptDisplayText(text, { AGENC_TUI_GLYPHS: 'ascii' })

    expect(output).toContain('... +')
    expect(output).not.toContain('…')
  })
})
