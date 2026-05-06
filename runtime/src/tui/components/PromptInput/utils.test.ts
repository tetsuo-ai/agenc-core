import { describe, expect, test, vi } from 'vitest'

import type { GlobalConfig } from '../../../utils/config.js'
import { isVimModeEnabled } from './utils.js'

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({ editorMode: 'normal' }),
}))

const baseConfig = {
  editorMode: 'normal',
} as GlobalConfig

describe('PromptInput vim mode config', () => {
  test('defaults off for normal editor mode', () => {
    expect(isVimModeEnabled(baseConfig)).toBe(false)
  })

  test('enables vim when tui.vimMode is true', () => {
    expect(
      isVimModeEnabled({
        ...baseConfig,
        editorMode: 'normal',
        tui: { vimMode: true },
      }),
    ).toBe(true)
  })

  test('tui.vimMode false overrides legacy editorMode vim', () => {
    expect(
      isVimModeEnabled({
        ...baseConfig,
        editorMode: 'vim',
        tui: { vimMode: false },
      }),
    ).toBe(false)
  })

  test('falls back to legacy editorMode when tui.vimMode is absent', () => {
    expect(
      isVimModeEnabled({
        ...baseConfig,
        editorMode: 'vim',
      }),
    ).toBe(true)
  })
})
