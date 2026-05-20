import { describe, expect, test } from 'vitest'

import {
  chordToDisplayString,
  chordToString,
  keystrokeToDisplayString,
  keystrokeToString,
  parseChord,
  parseKeystroke,
} from './parser.js'
import type { ParsedKeystroke } from './types.js'

function stroke(
  key: string,
  overrides: Partial<ParsedKeystroke> = {},
): ParsedKeystroke {
  return {
    key,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
    ...overrides,
  }
}

describe('keybinding parser display coverage', () => {
  test('normalizes aliases and formats named keys across display modes', () => {
    expect(parseKeystroke('alt+opt+option+esc')).toEqual(
      stroke('escape', { alt: true }),
    )
    expect(parseKeystroke('return')).toEqual(stroke('enter'))
    expect(parseKeystroke('\u2193')).toEqual(stroke('down'))
    expect(parseChord(' ')).toEqual([stroke(' ')])

    expect(
      keystrokeToString(
        stroke('escape', {
          alt: true,
          shift: true,
          meta: true,
          super: true,
        }),
      ),
    ).toBe('alt+shift+meta+cmd+Esc')

    expect(
      chordToString([
        stroke(' '),
        stroke('backspace'),
        stroke('delete'),
        stroke('pageup'),
        stroke('pagedown'),
        stroke('home'),
        stroke('end'),
      ]),
    ).toBe('Space Backspace Delete PageUp PageDown Home End')

    expect(
      keystrokeToDisplayString(
        stroke('down', { alt: true, super: true }),
        'macos',
        {},
      ),
    ).toBe('opt+cmd+\u2193')

    expect(
      keystrokeToDisplayString(
        stroke('down', { meta: true, super: true }),
        'linux',
        { AGENC_TUI_GLYPHS: 'ascii' },
      ),
    ).toBe('alt+super+down')

    expect(
      chordToDisplayString([stroke('left'), stroke('right')], 'linux', {}),
    ).toBe('\u2190 \u2192')
  })
})
