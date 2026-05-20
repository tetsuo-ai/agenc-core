import { expect, test } from 'vitest'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
  type ParsedResponse,
} from './parse-keypress.ts'
import { InputEvent } from './events/input-event.ts'
import { PASTE_END, PASTE_START } from './termio/csi.ts'

function parseOne(sequence: string): ParsedInput {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  expect(items).toHaveLength(1)

  return items[0]!
}

function parseKey(sequence: string): ParsedKey {
  const item = parseOne(sequence)

  expect(item.kind).toBe('key')

  return item as ParsedKey
}

function parseFlushedKey(sequence: string): ParsedKey {
  const [items, state] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  expect(items).toEqual([])

  const [flushed] = parseMultipleKeypresses(state, null)
  expect(flushed).toHaveLength(1)
  expect(flushed[0]?.kind).toBe('key')

  return flushed[0] as ParsedKey
}

function parseMouse(sequence: string): ParsedMouse {
  const item = parseOne(sequence)

  expect(item.kind).toBe('mouse')

  return item as ParsedMouse
}

function parseResponse(sequence: string): ParsedResponse {
  const item = parseOne(sequence)

  expect(item.kind).toBe('response')

  return item as ParsedResponse
}

function parseInputEvent(sequence: string): InputEvent {
  return new InputEvent(parseKey(sequence))
}

test('treats CSI-u modifier 0 as unmodified printable input', () => {
  const event = parseInputEvent('\x1b[47;0u')

  expect(event.input).toBe('/')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves printable Unicode CSI-u input', () => {
  const event = parseInputEvent('\x1b[231u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves printable Unicode CSI-u input with explicit modifier 0', () => {
  const event = parseInputEvent('\x1b[231;0u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('splits batched text and return into separate keypresses', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, 'next\r1\r')

  expect(items).toHaveLength(4)

  const events = items.map(item => {
    expect(item.kind).toBe('key')
    return new InputEvent(item as ParsedKey)
  })

  expect(events[0]!.input).toBe('next')
  expect(events[0]!.key.return).toBe(false)
  expect(events[1]!.input).toBe('')
  expect(events[1]!.key.return).toBe(true)
  expect(events[2]!.input).toBe('1')
  expect(events[2]!.key.return).toBe(false)
  expect(events[3]!.input).toBe('')
  expect(events[3]!.key.return).toBe(true)
})

test('splits batched ctrl-c into separate keypresses', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, '\x03\x03')

  expect(items).toHaveLength(2)

  const events = items.map(item => {
    expect(item.kind).toBe('key')
    return new InputEvent(item as ParsedKey)
  })

  expect(events[0]!.input).toBe('c')
  expect(events[0]!.key.ctrl).toBe(true)
  expect(events[1]!.input).toBe('c')
  expect(events[1]!.key.ctrl).toBe(true)
})

test('parses terminal responses separately from key input', () => {
  expect(parseResponse('\x1b[?25;1$y').response).toEqual({
    mode: 25,
    status: 1,
    type: 'decrpm',
  })
  expect(parseResponse('\x1b[?1;2c').response).toEqual({
    params: [1, 2],
    type: 'da1',
  })
  expect(parseResponse('\x1b[>0;95;0c').response).toEqual({
    params: [0, 95, 0],
    type: 'da2',
  })
  expect(parseResponse('\x1b[?9u').response).toEqual({
    flags: 9,
    type: 'kittyKeyboard',
  })
  expect(parseResponse('\x1b[?12;34R').response).toEqual({
    col: 34,
    row: 12,
    type: 'cursorPosition',
  })
  expect(parseResponse('\x1b]11;rgb:0000/1111/2222\x07').response).toEqual({
    code: 11,
    data: 'rgb:0000/1111/2222',
    type: 'osc',
  })
  expect(parseResponse('\x1bP>|xterm.js(5.5.0)\x1b\\').response).toEqual({
    name: 'xterm.js(5.5.0)',
    type: 'xtversion',
  })
})

test('keeps paste payloads literal and flushes an incomplete paste', () => {
  const [pasted, pastedState] = parseMultipleKeypresses(
    INITIAL_STATE,
    `${PASTE_START}hello\x1b[31mred${PASTE_END}`,
  )

  expect(pastedState.mode).toBe('NORMAL')
  expect(pasted).toEqual([
    expect.objectContaining({
      isPasted: true,
      kind: 'key',
      raw: 'hello\x1b[31mred',
      sequence: 'hello\x1b[31mred',
    }),
  ])

  const [emptyPaste] = parseMultipleKeypresses(
    INITIAL_STATE,
    `${PASTE_START}${PASTE_END}`,
  )
  expect(emptyPaste).toEqual([
    expect.objectContaining({
      isPasted: true,
      raw: '',
      sequence: '',
    }),
  ])

  const [pending, pendingState] = parseMultipleKeypresses(
    INITIAL_STATE,
    `${PASTE_START}partial`,
  )
  expect(pending).toEqual([])
  expect(pendingState).toEqual(
    expect.objectContaining({
      mode: 'IN_PASTE',
      pasteBuffer: 'partial',
    }),
  )

  const [flushed, flushedState] = parseMultipleKeypresses(pendingState, null)
  expect(flushedState.mode).toBe('NORMAL')
  expect(flushed).toEqual([
    expect.objectContaining({
      isPasted: true,
      raw: 'partial',
      sequence: 'partial',
    }),
  ])
})

test('parses SGR mouse clicks and keeps wheel input as key events', () => {
  expect(parseMouse('\x1b[<0;12;5M')).toEqual({
    action: 'press',
    button: 0,
    col: 12,
    kind: 'mouse',
    row: 5,
    sequence: '\x1b[<0;12;5M',
  })
  expect(parseMouse('\x1b[<32;4;3m')).toEqual({
    action: 'release',
    button: 32,
    col: 4,
    kind: 'mouse',
    row: 3,
    sequence: '\x1b[<32;4;3m',
  })

  expect(parseKey('\x1b[<64;1;2M').name).toBe('wheelup')
  expect(parseKey('\x1b[<65;1;2M').name).toBe('wheeldown')
  expect(parseKey('\x1b[<80;1;2M').name).toBe('wheelup')
})

test('parses X10 mouse wheel events and resynthesizes orphaned mouse tails', () => {
  const wheelUp =
    '\x1b[M' + String.fromCharCode(32 + 64) + String.fromCharCode(33) + '!'
  const wheelDown =
    '\x1b[M' + String.fromCharCode(32 + 65) + String.fromCharCode(33) + '!'
  const mouseClick =
    '\x1b[M' + String.fromCharCode(32) + String.fromCharCode(33) + '!'

  expect(parseKey(wheelUp).name).toBe('wheelup')
  expect(parseKey(wheelDown).name).toBe('wheeldown')
  expect(parseKey(mouseClick).name).toBe('mouse')
  expect(parseKey('[<64;1;2M').name).toBe('wheelup')
})

test('parses control, meta, printable, and navigation key variants', () => {
  expect(parseKey('\r')).toEqual(
    expect.objectContaining({ name: 'return', raw: undefined }),
  )
  expect(parseKey('\n').name).toBe('enter')
  expect(parseKey('\t').name).toBe('tab')
  expect(parseKey('\b').name).toBe('backspace')
  const [escapedBackspace] = parseMultipleKeypresses(INITIAL_STATE, '\x1b\b')
  expect(escapedBackspace.map(item => (item as ParsedKey).name)).toEqual([
    'escape',
    'backspace',
  ])
  expect(parseKey('\x7f').name).toBe('backspace')
  const [escapedDelete] = parseMultipleKeypresses(INITIAL_STATE, '\x1b\x7f')
  expect(escapedDelete.map(item => (item as ParsedKey).name)).toEqual([
    'escape',
    'backspace',
  ])
  expect(parseFlushedKey('\x1b').name).toBe('escape')
  expect(parseKey('\x1b\x1b')).toEqual(
    expect.objectContaining({ meta: false, name: 'escape' }),
  )
  expect(parseKey(' ')).toEqual(
    expect.objectContaining({ meta: false, name: 'space' }),
  )
  expect(parseFlushedKey('\x1b ')).toEqual(
    expect.objectContaining({ meta: true, name: 'space' }),
  )
  expect(parseKey('\x1f')).toEqual(
    expect.objectContaining({ ctrl: true, name: '_' }),
  )
  expect(parseKey('\x01')).toEqual(
    expect.objectContaining({ ctrl: true, name: 'a' }),
  )
  expect(parseKey('7').name).toBe('number')
  expect(parseKey('a').name).toBe('a')
  expect(parseKey('A')).toEqual(
    expect.objectContaining({ name: 'a', shift: true }),
  )
  expect(parseKey('\x1ba')).toEqual(
    expect.objectContaining({ meta: true, name: '', shift: false }),
  )
  expect(parseKey('\x1bA')).toEqual(
    expect.objectContaining({ meta: true, name: '', shift: true }),
  )
})

test('parses function key families and modifier encodings', () => {
  expect(parseKey('\x1bOP').name).toBe('f1')
  expect(parseKey('\x1b[15~').name).toBe('f5')
  expect(parseKey('\x1b[A').name).toBe('up')
  expect(parseKey('\x1b[Z')).toEqual(
    expect.objectContaining({ name: 'tab', shift: true }),
  )
  expect(parseKey('\x1b[1;5C')).toEqual(
    expect.objectContaining({ ctrl: true, name: 'right' }),
  )
  expect(parseKey('\x1b[1;6D')).toEqual(
    expect.objectContaining({ ctrl: true, meta: false, name: 'left' }),
  )
  expect(parseKey('\x1b[1;3A')).toEqual(
    expect.objectContaining({ meta: true, name: 'up' }),
  )
  const [escapedArrow] = parseMultipleKeypresses(INITIAL_STATE, '\x1b\x1b[A')
  expect(escapedArrow.map(item => (item as ParsedKey).name)).toEqual([
    'escape',
    'up',
  ])
  expect(parseKey('\x1bb')).toEqual(
    expect.objectContaining({ meta: true, name: 'left' }),
  )
  expect(parseKey('\x1bf')).toEqual(
    expect.objectContaining({ meta: true, name: 'right' }),
  )
})

test('parses CSI-u and modifyOtherKeys names and modifiers', () => {
  expect(parseKey('\x1b[13;2u')).toEqual(
    expect.objectContaining({ name: 'return', shift: true }),
  )
  expect(parseKey('\x1b[27;5u')).toEqual(
    expect.objectContaining({ ctrl: true, name: 'escape' }),
  )
  expect(parseKey('\x1b[127;9u')).toEqual(
    expect.objectContaining({ name: 'backspace', super: true }),
  )
  expect(parseKey('\x1b[57414u').name).toBe('return')
  expect(parseKey('\x1b[57399u').name).toBe('0')
  expect(parseKey('\x1b[57350u').name).toBeUndefined()
  expect(parseKey('\x1b[27;10;65~')).toEqual(
    expect.objectContaining({ name: 'a', shift: true, super: true }),
  )
})
