import { describe, expect, test } from 'vitest'

import { chordToDisplayString, parseChord } from './parser.js'

describe('keybinding display glyphs', () => {
  test('uses text arrow names in ASCII glyph mode', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(chordToDisplayString(parseChord('shift+↑'), 'linux', env)).toBe(
      'shift+up',
    )
    expect(chordToDisplayString(parseChord('ctrl+← ctrl+→'), 'linux', env)).toBe(
      'ctrl+left ctrl+right',
    )
  })

  test('preserves Unicode arrows by default', () => {
    expect(chordToDisplayString(parseChord('shift+↑'), 'linux', {})).toBe(
      'shift+↑',
    )
  })
})
