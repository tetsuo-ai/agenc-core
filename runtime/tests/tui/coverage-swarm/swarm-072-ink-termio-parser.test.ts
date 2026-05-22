import { describe, expect, test } from 'vitest'

import { Parser } from '../../../src/tui/ink/termio/parser.ts'

const ESC = '\x1b'

describe('termio Parser coverage swarm row 072', () => {
  test('handles empty/default CSI params, colon params, and fallback lookups', () => {
    const parser = new Parser()

    expect(
      parser.feed(
        [
          `${ESC}[;5H`,
          `${ESC}[2:3f`,
          `${ESC}[J`,
          `${ESC}[99J`,
          `${ESC}[K`,
          `${ESC}[99K`,
          `${ESC}[X`,
          `${ESC}[r`,
          `${ESC}[ q`,
          `${ESC}[99 q`,
        ].join(''),
      ),
    ).toEqual([
      { action: { col: 5, row: 0, type: 'position' }, type: 'cursor' },
      { action: { col: 3, row: 2, type: 'position' }, type: 'cursor' },
      { action: { region: 'toEnd', type: 'display' }, type: 'erase' },
      { action: { region: 'toEnd', type: 'display' }, type: 'erase' },
      { action: { region: 'toEnd', type: 'line' }, type: 'erase' },
      { action: { region: 'toEnd', type: 'line' }, type: 'erase' },
      { action: { count: 1, type: 'chars' }, type: 'erase' },
      { action: { bottom: 1, top: 1, type: 'setRegion' }, type: 'scroll' },
      {
        action: { blinking: true, style: 'block', type: 'style' },
        type: 'cursor',
      },
      {
        action: { blinking: true, style: 'block', type: 'style' },
        type: 'cursor',
      },
    ])
  })

  test('resets empty SGR style and treats combined graphemes as double width', () => {
    const parser = new Parser()

    expect(parser.feed(`${ESC}[1;31m${ESC}[me\u0301`)).toEqual([
      {
        graphemes: [{ value: 'e\u0301', width: 2 }],
        style: expect.objectContaining({
          bold: false,
          fg: { type: 'default' },
        }),
        type: 'text',
      },
    ])
  })

  test('parses alternate-screen variants and private mode resets', () => {
    const parser = new Parser()

    expect(
      parser.feed(
        [
          `${ESC}[?47h`,
          `${ESC}[?47l`,
          `${ESC}[?2004l`,
          `${ESC}[?1000l`,
          `${ESC}[?1002l`,
          `${ESC}[?1003l`,
        ].join(''),
      ),
    ).toEqual([
      { action: { enabled: true, type: 'alternateScreen' }, type: 'mode' },
      { action: { enabled: false, type: 'alternateScreen' }, type: 'mode' },
      { action: { enabled: false, type: 'bracketedPaste' }, type: 'mode' },
      { action: { mode: 'off', type: 'mouseTracking' }, type: 'mode' },
      { action: { mode: 'off', type: 'mouseTracking' }, type: 'mode' },
      { action: { mode: 'off', type: 'mouseTracking' }, type: 'mode' },
    ])
  })
})
