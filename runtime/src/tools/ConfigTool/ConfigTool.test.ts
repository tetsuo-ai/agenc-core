import { describe, expect, test } from 'vitest'

import {
  getNestedSettingValue,
  setGlobalConfigSettingValue,
  setNestedSettingValue,
} from './nestedSettingPath.js'

describe('ConfigTool dotted global settings', () => {
  test('reads and writes nested global values without replacing siblings', () => {
    const config = {
      editorMode: 'normal',
      tui: {
        vimMode: false,
        sidePane: 'status',
      },
    }

    expect(getNestedSettingValue(config, ['tui', 'vimMode'])).toBe(false)

    const next = setNestedSettingValue(config, ['tui', 'vimMode'], true)
    expect(next).toEqual({
      editorMode: 'normal',
      tui: {
        vimMode: true,
        sidePane: 'status',
      },
    })
    expect(config.tui.vimMode).toBe(false)
  })

  test('mirrors legacy editorMode and tui.vimMode in both directions', () => {
    expect(
      setGlobalConfigSettingValue(
        { editorMode: 'normal' },
        'editorMode',
        ['editorMode'],
        'vim',
      ),
    ).toEqual({
      editorMode: 'vim',
      tui: { vimMode: true },
    })

    expect(
      setGlobalConfigSettingValue(
        { editorMode: 'vim', tui: { vimMode: true } },
        'tui.vimMode',
        ['tui', 'vimMode'],
        false,
      ),
    ).toEqual({
      editorMode: 'normal',
      tui: { vimMode: false },
    })
  })
})
