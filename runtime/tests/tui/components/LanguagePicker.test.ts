import { describe, expect, it } from 'vitest'

import {
  getLanguagePickerInputColumns,
  LANGUAGE_PICKER_PLACEHOLDER,
} from './LanguagePicker.js'

describe('LanguagePicker sizing', () => {
  it('caps input width for wide dialogs and clamps tiny widths to one column', () => {
    expect(getLanguagePickerInputColumns(120)).toBe(60)
    expect(getLanguagePickerInputColumns(80)).toBe(60)
    expect(getLanguagePickerInputColumns(20)).toBe(16)
    expect(getLanguagePickerInputColumns(4)).toBe(1)
    expect(getLanguagePickerInputColumns(0)).toBe(1)
  })

  it('uses an ASCII placeholder for narrow and ASCII terminal modes', () => {
    expect([...LANGUAGE_PICKER_PLACEHOLDER].every(char => char.charCodeAt(0) < 128)).toBe(true)
  })
})
