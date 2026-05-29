import { describe, expect, test } from 'vitest'

import {
  getUserPromptTruncationNotice,
  truncateUserPromptDisplayText,
} from './UserPromptMessage.js'

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
