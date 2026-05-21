import { describe, expect, test } from 'vitest'

import {
  colorsEqual,
  defaultStyle,
  stylesEqual,
  type Color,
  type TextStyle,
} from '../../../src/tui/ink/termio/types.js'

function changedStyle(change: Partial<TextStyle>): TextStyle {
  return { ...defaultStyle(), ...change }
}

describe('termio semantic type helpers coverage swarm row 090', () => {
  test('creates an independent default text style with reset colors', () => {
    const first = defaultStyle()
    const second = defaultStyle()

    expect(first).toEqual({
      bg: { type: 'default' },
      blink: false,
      bold: false,
      dim: false,
      fg: { type: 'default' },
      hidden: false,
      inverse: false,
      italic: false,
      overline: false,
      strikethrough: false,
      underline: 'none',
      underlineColor: { type: 'default' },
    })
    expect(first).not.toBe(second)
    expect(first.fg).not.toBe(second.fg)
    expect(first.bg).not.toBe(second.bg)
    expect(first.underlineColor).not.toBe(second.underlineColor)
  })

  test('compares named, indexed, RGB, and default colors', () => {
    const cases: Array<[Color, Color, boolean]> = [
      [
        { type: 'named', name: 'red' },
        { type: 'named', name: 'red' },
        true,
      ],
      [
        { type: 'named', name: 'red' },
        { type: 'named', name: 'blue' },
        false,
      ],
      [
        { type: 'indexed', index: 12 },
        { type: 'indexed', index: 12 },
        true,
      ],
      [
        { type: 'indexed', index: 12 },
        { type: 'indexed', index: 13 },
        false,
      ],
      [
        { type: 'rgb', r: 1, g: 2, b: 3 },
        { type: 'rgb', r: 1, g: 2, b: 3 },
        true,
      ],
      [
        { type: 'rgb', r: 1, g: 2, b: 3 },
        { type: 'rgb', r: 9, g: 2, b: 3 },
        false,
      ],
      [
        { type: 'rgb', r: 1, g: 2, b: 3 },
        { type: 'rgb', r: 1, g: 9, b: 3 },
        false,
      ],
      [
        { type: 'rgb', r: 1, g: 2, b: 3 },
        { type: 'rgb', r: 1, g: 2, b: 9 },
        false,
      ],
      [{ type: 'default' }, { type: 'default' }, true],
      [{ type: 'default' }, { type: 'named', name: 'white' }, false],
    ]

    for (const [left, right, expected] of cases) {
      expect(colorsEqual(left, right)).toBe(expected)
    }
  })

  test('compares every text style field and nested color', () => {
    const base = defaultStyle()

    expect(stylesEqual(base, defaultStyle())).toBe(true)

    for (const change of [
      { bold: true },
      { dim: true },
      { italic: true },
      { underline: 'single' as const },
      { blink: true },
      { inverse: true },
      { hidden: true },
      { strikethrough: true },
      { overline: true },
      { fg: { type: 'named' as const, name: 'green' as const } },
      { bg: { type: 'indexed' as const, index: 7 } },
      { underlineColor: { type: 'rgb' as const, r: 4, g: 5, b: 6 } },
    ]) {
      expect(stylesEqual(base, changedStyle(change))).toBe(false)
    }
  })
})
