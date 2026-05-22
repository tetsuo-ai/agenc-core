import { describe, expect, test } from 'vitest'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedInput,
  type ParsedKey,
} from '../../../src/tui/ink/parse-keypress.js'

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

function parseKeyAfterOptionalFlush(sequence: string): ParsedKey {
  const [items, state] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  if (items.length === 1) {
    expect(items[0]?.kind).toBe('key')

    return items[0] as ParsedKey
  }

  const [flushed] = parseMultipleKeypresses(state, null)
  expect(flushed).toHaveLength(1)
  expect(flushed[0]?.kind).toBe('key')

  return flushed[0] as ParsedKey
}

describe('parse-keypress coverage swarm row 188', () => {
  test('parses exact page navigation overrides', () => {
    expect(parseKey('\x1b[5~')).toEqual(
      expect.objectContaining({
        ctrl: false,
        meta: false,
        name: 'pageup',
        shift: false,
      }),
    )
    expect(parseKey('\x1b[6~')).toEqual(
      expect.objectContaining({
        ctrl: false,
        meta: false,
        name: 'pagedown',
        shift: false,
      }),
    )
  })

  test('marks rxvt shift and control aliases from function-key sequences', () => {
    expect(parseKeyAfterOptionalFlush('\x1b[2$')).toEqual(
      expect.objectContaining({
        code: '[2$',
        ctrl: false,
        name: 'insert',
        shift: true,
      }),
    )
    expect(parseKeyAfterOptionalFlush('\x1b[3^')).toEqual(
      expect.objectContaining({
        code: '[3^',
        ctrl: true,
        name: 'delete',
        shift: false,
      }),
    )
    expect(parseKey('\x1bOa')).toEqual(
      expect.objectContaining({
        code: 'Oa',
        ctrl: true,
        name: 'up',
      }),
    )
  })

  test('falls back malformed terminal responses to key events', () => {
    expect(parseKey('\x1b]not-a-response\x07')).toEqual(
      expect.objectContaining({
        name: '',
        raw: '\x1b]not-a-response\x07',
        sequence: '\x1b]not-a-response\x07',
      }),
    )
    expect(parseKey('\x1bPnot-a-version\x1b\\')).toEqual(
      expect.objectContaining({
        name: '',
        raw: '\x1bPnot-a-version\x1b\\',
        sequence: '\x1bPnot-a-version\x1b\\',
      }),
    )
  })
})
