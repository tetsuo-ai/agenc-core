import { expect, test } from 'vitest'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedKey,
} from './parse-keypress.ts'
import { InputEvent } from './events/input-event.ts'

function parseInputEvent(sequence: string): InputEvent {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  expect(items).toHaveLength(1)

  const item = items[0]
  expect(item?.kind).toBe('key')

  return new InputEvent(item as ParsedKey)
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
