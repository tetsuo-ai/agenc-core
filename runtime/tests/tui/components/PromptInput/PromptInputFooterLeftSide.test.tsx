import { describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { sourceUrl } from '../../../helpers/source-path.ts'

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

  test('does not retain impossible footer pills', () => {
    const leftSide = readFileSync(
      sourceUrl('tui/components/PromptInput/PromptInputFooterLeftSide.tsx'),
      'utf8',
    )
    const promptInput = readFileSync(
      sourceUrl('tui/components/PromptInput/PromptInput.tsx'),
      'utf8',
    )

    expect(leftSide).not.toContain('TungstenPill')
    expect(leftSide).not.toContain('hasTmuxSession')
    expect(leftSide).not.toContain('hasCoordinatorTasks')
    expect(promptInput).not.toContain('tmuxSelected')
  })
})
