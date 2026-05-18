import { describe, expect, test, vi } from 'vitest'

import type { GlobalConfig } from '../../../utils/config.js'
import {
  clampPromptTextInputColumns,
  isVimModeEnabled,
  pasteReferenceLineThreshold,
} from './utils.js'

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

describe('PromptInput terminal geometry helpers', () => {
  test('clamps input columns to a valid width', () => {
    expect(clampPromptTextInputColumns(0)).toBe(0)
    expect(clampPromptTextInputColumns(2)).toBe(0)
    expect(clampPromptTextInputColumns(3)).toBe(0)
    expect(clampPromptTextInputColumns(80)).toBe(77)
  })

  test('keeps paste threshold usable on tiny terminal heights', () => {
    expect(pasteReferenceLineThreshold(0)).toBe(1)
    expect(pasteReferenceLineThreshold(9)).toBe(1)
    expect(pasteReferenceLineThreshold(10)).toBe(1)
    expect(pasteReferenceLineThreshold(11)).toBe(1)
    expect(pasteReferenceLineThreshold(12)).toBe(2)
    expect(pasteReferenceLineThreshold(24)).toBe(2)
  })
})
