import { describe, expect, test } from 'vitest'

import { InputEvent } from '../../../src/tui/ink/events/input-event.ts'
import type { ParsedKey } from '../../../src/tui/ink/parse-keypress.ts'

function keypress(overrides: Partial<ParsedKey> = {}): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: '',
    raw: '',
    isPasted: false,
    ...overrides,
  }
}

describe('InputEvent coverage swarm row 079', () => {
  test('maps parsed key names and modifiers onto the public key shape', () => {
    const namedKeys: Array<[ParsedKey['name'], keyof InputEvent['key']]> = [
      ['up', 'upArrow'],
      ['down', 'downArrow'],
      ['left', 'leftArrow'],
      ['right', 'rightArrow'],
      ['pagedown', 'pageDown'],
      ['pageup', 'pageUp'],
      ['wheelup', 'wheelUp'],
      ['wheeldown', 'wheelDown'],
      ['home', 'home'],
      ['end', 'end'],
      ['return', 'return'],
      ['escape', 'escape'],
      ['tab', 'tab'],
      ['backspace', 'backspace'],
      ['delete', 'delete'],
    ]

    for (const [name, property] of namedKeys) {
      const event = new InputEvent(keypress({ name, sequence: `\x1b-${name}` }))

      expect(event.key[property], name).toBe(true)
      expect(event.input, name).toBe('')
    }

    const modified = new InputEvent(
      keypress({
        ctrl: true,
        fn: true,
        meta: true,
        name: 'x',
        shift: true,
        super: true,
      }),
    )

    expect(modified.key).toEqual(
      expect.objectContaining({
        ctrl: true,
        fn: true,
        meta: true,
        shift: true,
        super: true,
      }),
    )
    expect(modified.input).toBe('x')
  })

  test('normalizes missing, control, uppercase, option, and escape input', () => {
    expect(new InputEvent(keypress({ sequence: undefined })).input).toBe('')
    expect(
      new InputEvent(keypress({ ctrl: true, name: 'space', sequence: 'ignored' }))
        .input,
    ).toBe(' ')
    expect(new InputEvent(keypress({ ctrl: true, name: 'c' })).input).toBe('c')

    const uppercase = new InputEvent(
      keypress({ name: 'a', sequence: 'A', shift: false }),
    )
    expect(uppercase.input).toBe('A')
    expect(uppercase.key.shift).toBe(true)

    expect(
      new InputEvent(
        keypress({ name: 'up', option: true, sequence: '\x1b\x1b[A' }),
      ).key.meta,
    ).toBe(true)
    expect(new InputEvent(keypress({ name: 'escape' })).key.meta).toBe(true)
  })

  test('suppresses malformed function-key and orphaned mouse fragments', () => {
    expect(
      new InputEvent(
        keypress({ code: '[25~', name: undefined, sequence: '\x1b[25~' }),
      ).input,
    ).toBe('')

    expect(
      new InputEvent(keypress({ name: '', sequence: '[<64;74;16M' })).input,
    ).toBe('')
    expect(
      new InputEvent(keypress({ name: '', sequence: '[<65;10;5m' })).input,
    ).toBe('')
  })

  test('converts CSI-u and modifyOtherKeys payloads to text input safely', () => {
    const csiCases: Array<[string | undefined, string, string]> = [
      ['b', '\x1b[98;3u', 'b'],
      ['space', '\x1b[32;5u', ' '],
      ['escape', '\x1b[27;5u', ''],
      [undefined, '\x1b[57358u', ''],
      ['return', '\x1b[13;2u', 'return'],
    ]

    for (const [name, sequence, expected] of csiCases) {
      expect(new InputEvent(keypress({ name, sequence })).input).toBe(expected)
    }

    const modifyOtherKeysCases: Array<[string | undefined, string, string]> = [
      ['b', '\x1b[27;3;98~', 'b'],
      ['space', '\x1b[27;5;32~', ' '],
      ['escape', '\x1b[27;5;27~', ''],
      [undefined, '\x1b[27;5;0~', ''],
    ]

    for (const [name, sequence, expected] of modifyOtherKeysCases) {
      expect(new InputEvent(keypress({ name, sequence })).input).toBe(expected)
    }
  })

  test('preserves application keypad printable input instead of clearing it', () => {
    expect(new InputEvent(keypress({ name: '0', sequence: '\x1bOp' })).input).toBe(
      '0',
    )
    expect(new InputEvent(keypress({ name: '+', sequence: '\x1bOk' })).input).toBe(
      '+',
    )
  })
})
