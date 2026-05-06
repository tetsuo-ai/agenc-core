import { describe, expect, test, vi } from 'vitest'

import { formatVimModeIndicator } from './utils.js'

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({ editorMode: 'normal' }),
}))

describe('PromptInputFooterLeftSide vim mode indicator', () => {
  test('formats all active vim modes', () => {
    expect(formatVimModeIndicator('INSERT')).toBe('-- INSERT --')
    expect(formatVimModeIndicator('NORMAL')).toBe('-- NORMAL --')
  })

  test('omits vim mode when inactive', () => {
    expect(formatVimModeIndicator(undefined)).toBeNull()
  })
})
