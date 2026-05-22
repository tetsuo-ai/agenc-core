import { describe, expect, test } from 'vitest'

import {
  BEL,
  C0,
  ESC,
  ESC_TYPE,
  SEP,
  isC0,
  isEscFinal,
} from '../../../src/tui/ink/termio/ansi.js'

describe('ansi termio coverage swarm row 231', () => {
  test('exports control-character byte values and string constants', () => {
    expect(C0.NUL).toBe(0x00)
    expect(C0.ESC).toBe(0x1b)
    expect(C0.DEL).toBe(0x7f)

    expect(ESC).toBe('\x1b')
    expect(BEL).toBe('\x07')
    expect(SEP).toBe(';')
  })

  test('exports escape sequence introducer bytes', () => {
    expect(ESC_TYPE).toEqual({
      CSI: 0x5b,
      OSC: 0x5d,
      DCS: 0x50,
      APC: 0x5f,
      PM: 0x5e,
      SOS: 0x58,
      ST: 0x5c,
    })
  })

  test('classifies C0 controls at the lower range and DEL boundary', () => {
    expect(isC0(0x00)).toBe(true)
    expect(isC0(0x1f)).toBe(true)
    expect(isC0(0x20)).toBe(false)
    expect(isC0(0x7e)).toBe(false)
    expect(isC0(0x7f)).toBe(true)
    expect(isC0(0x80)).toBe(false)
  })

  test('classifies ESC final bytes across the inclusive range', () => {
    expect(isEscFinal(0x2f)).toBe(false)
    expect(isEscFinal(0x30)).toBe(true)
    expect(isEscFinal(0x3b)).toBe(true)
    expect(isEscFinal(0x40)).toBe(true)
    expect(isEscFinal(0x7e)).toBe(true)
    expect(isEscFinal(0x7f)).toBe(false)
  })
})
