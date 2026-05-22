import { describe, expect, test } from 'vitest'

import {
  CSI_PREFIX,
  CURSOR_HOME,
  CURSOR_LEFT,
  CURSOR_RESTORE,
  CURSOR_SAVE,
  CURSOR_STYLES,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  ERASE_LINE,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
  FOCUS_IN,
  FOCUS_OUT,
  PASTE_END,
  PASTE_START,
  RESET_SCROLL_REGION,
  csi,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorMove,
  cursorPosition,
  cursorTo,
  cursorUp,
  eraseLine,
  eraseLines,
  eraseScreen,
  eraseToEndOfLine,
  eraseToEndOfScreen,
  eraseToStartOfLine,
  eraseToStartOfScreen,
  isCSIFinal,
  isCSIIntermediate,
  isCSIParam,
  scrollDown,
  scrollUp,
  setScrollRegion,
} from '../../../src/tui/ink/termio/csi.js'

const CSI = '\x1b['

describe('termio CSI helpers coverage swarm row 104', () => {
  test('classifies CSI byte ranges by inclusive boundaries', () => {
    expect(CSI_PREFIX).toBe(CSI)

    expect(isCSIParam(0x2f)).toBe(false)
    expect(isCSIParam(0x30)).toBe(true)
    expect(isCSIParam(0x3f)).toBe(true)
    expect(isCSIParam(0x40)).toBe(false)

    expect(isCSIIntermediate(0x1f)).toBe(false)
    expect(isCSIIntermediate(0x20)).toBe(true)
    expect(isCSIIntermediate(0x2f)).toBe(true)
    expect(isCSIIntermediate(0x30)).toBe(false)

    expect(isCSIFinal(0x3f)).toBe(false)
    expect(isCSIFinal(0x40)).toBe(true)
    expect(isCSIFinal(0x7e)).toBe(true)
    expect(isCSIFinal(0x7f)).toBe(false)
  })

  test('formats CSI sequences from raw bodies and joined parameters', () => {
    expect(csi()).toBe(CSI)
    expect(csi('H')).toBe(`${CSI}H`)
    expect(csi('>4;2m')).toBe(`${CSI}>4;2m`)
    expect(csi(4, 20, 'r')).toBe(`${CSI}4;20r`)
    expect(csi('?25', 'l')).toBe(`${CSI}?25l`)
  })

  test('generates cursor movement and save/restore sequences', () => {
    expect(cursorUp()).toBe(`${CSI}1A`)
    expect(cursorUp(0)).toBe('')
    expect(cursorDown(2)).toBe(`${CSI}2B`)
    expect(cursorDown(0)).toBe('')
    expect(cursorForward(3)).toBe(`${CSI}3C`)
    expect(cursorForward(0)).toBe('')
    expect(cursorBack(4)).toBe(`${CSI}4D`)
    expect(cursorBack(0)).toBe('')

    expect(cursorTo(7)).toBe(`${CSI}7G`)
    expect(CURSOR_LEFT).toBe(`${CSI}G`)
    expect(cursorPosition(8, 9)).toBe(`${CSI}8;9H`)
    expect(CURSOR_HOME).toBe(`${CSI}H`)
    expect(CURSOR_SAVE).toBe(`${CSI}s`)
    expect(CURSOR_RESTORE).toBe(`${CSI}u`)
  })

  test('combines relative cursor movement in horizontal then vertical order', () => {
    expect(cursorMove(0, 0)).toBe('')
    expect(cursorMove(3, 2)).toBe(`${CSI}3C${CSI}2B`)
    expect(cursorMove(-4, -5)).toBe(`${CSI}4D${CSI}5A`)
    expect(cursorMove(6, -7)).toBe(`${CSI}6C${CSI}7A`)
    expect(cursorMove(-8, 9)).toBe(`${CSI}8D${CSI}9B`)
  })

  test('generates erase sequences and repeated line clearing', () => {
    expect(eraseToEndOfLine()).toBe(`${CSI}K`)
    expect(eraseToStartOfLine()).toBe(`${CSI}1K`)
    expect(eraseLine()).toBe(`${CSI}2K`)
    expect(ERASE_LINE).toBe(`${CSI}2K`)

    expect(eraseToEndOfScreen()).toBe(`${CSI}J`)
    expect(eraseToStartOfScreen()).toBe(`${CSI}1J`)
    expect(eraseScreen()).toBe(`${CSI}2J`)
    expect(ERASE_SCREEN).toBe(`${CSI}2J`)
    expect(ERASE_SCROLLBACK).toBe(`${CSI}3J`)

    expect(eraseLines(0)).toBe('')
    expect(eraseLines(-1)).toBe('')
    expect(eraseLines(1)).toBe(`${CSI}2K${CSI}G`)
    expect(eraseLines(3)).toBe(`${CSI}2K${CSI}1A${CSI}2K${CSI}1A${CSI}2K${CSI}G`)
  })

  test('generates scroll, paste, focus, keyboard, and mode sequences', () => {
    expect(scrollUp()).toBe(`${CSI}1S`)
    expect(scrollUp(0)).toBe('')
    expect(scrollDown(2)).toBe(`${CSI}2T`)
    expect(scrollDown(0)).toBe('')
    expect(setScrollRegion(4, 20)).toBe(`${CSI}4;20r`)
    expect(RESET_SCROLL_REGION).toBe(`${CSI}r`)

    expect(PASTE_START).toBe(`${CSI}200~`)
    expect(PASTE_END).toBe(`${CSI}201~`)
    expect(FOCUS_IN).toBe(`${CSI}I`)
    expect(FOCUS_OUT).toBe(`${CSI}O`)
    expect(ENABLE_KITTY_KEYBOARD).toBe(`${CSI}>1u`)
    expect(DISABLE_KITTY_KEYBOARD).toBe(`${CSI}<u`)
    expect(ENABLE_MODIFY_OTHER_KEYS).toBe(`${CSI}>4;2m`)
    expect(DISABLE_MODIFY_OTHER_KEYS).toBe(`${CSI}>4m`)
  })

  test('exports cursor style lookup values by protocol index', () => {
    expect(CURSOR_STYLES).toEqual([
      { blinking: true, style: 'block' },
      { blinking: true, style: 'block' },
      { blinking: false, style: 'block' },
      { blinking: true, style: 'underline' },
      { blinking: false, style: 'underline' },
      { blinking: true, style: 'bar' },
      { blinking: false, style: 'bar' },
    ])
  })
})
