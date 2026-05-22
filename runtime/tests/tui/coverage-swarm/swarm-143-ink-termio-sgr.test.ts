import { describe, expect, test } from 'vitest'

import { applySGR } from '../../../src/tui/ink/termio/sgr.js'
import { defaultStyle } from '../../../src/tui/ink/termio/types.js'

describe('termio SGR parser coverage swarm row 143', () => {
  test('applies blink alias, underline none, and colon color variants', () => {
    const style = applySGR(
      '6;4:0;38:2::10:20:30;48:5:201;58:5:44',
      defaultStyle(),
    )

    expect(style).toEqual(
      expect.objectContaining({
        blink: true,
        underline: 'none',
        fg: { type: 'rgb', r: 10, g: 20, b: 30 },
        bg: { type: 'indexed', index: 201 },
        underlineColor: { type: 'indexed', index: 44 },
      }),
    )
  })

  test('leaves extended colors unchanged when colon parameters are incomplete', () => {
    const base = applySGR('31;48;5;22;58;2;1;2;3', defaultStyle())

    expect(applySGR('38:5', base)).toEqual(base)
    expect(applySGR('38:2:1:2', base)).toEqual(base)
    expect(applySGR('38:7:1', base)).toEqual(base)
  })

  test('handles semicolon RGB foregrounds and later ordinary SGR codes', () => {
    const rgb = applySGR('38;2;9;8;7;48;7;58;8', defaultStyle())

    expect(rgb).toEqual(
      expect.objectContaining({
        fg: { type: 'rgb', r: 9, g: 8, b: 7 },
        bg: { type: 'default' },
        underlineColor: { type: 'default' },
        inverse: true,
        hidden: true,
      }),
    )
  })
})
