import { Buffer } from 'buffer'
import { expect, test } from 'vitest'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedInput,
  type ParsedKey,
  type ParsedResponse,
} from './parse-keypress.ts'

function parseOne(input: Buffer | string): ParsedInput {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, input)

  expect(items).toHaveLength(1)

  return items[0]!
}

function parseKey(input: Buffer | string): ParsedKey {
  const item = parseOne(input)

  expect(item.kind).toBe('key')

  return item as ParsedKey
}

function parseResponse(input: string): ParsedResponse {
  const item = parseOne(input)

  expect(item.kind).toBe('response')

  return item as ParsedResponse
}

test('parses compatibility key encodings through the public parser', () => {
  expect(parseResponse('\x1b[?c').response).toEqual({
    params: [],
    type: 'da1',
  })

  expect(parseMultipleKeypresses(INITIAL_STATE)).toEqual([
    [],
    expect.objectContaining({ incomplete: '', mode: 'NORMAL' }),
  ])
  expect(parseKey(Buffer.from('q'))).toEqual(
    expect.objectContaining({ name: 'q', sequence: 'q' }),
  )
  expect(parseKey(Buffer.from([0xe1]))).toEqual(
    expect.objectContaining({ meta: true, sequence: '\x1ba' }),
  )
  expect(parseKey(new String('7') as unknown as string)).toEqual(
    expect.objectContaining({ name: 'number', sequence: '7' }),
  )

  const csiUKeyNames = new Map<number, string | undefined>([
    [9, 'tab'],
    [32, 'space'],
    [57400, '1'],
    [57401, '2'],
    [57402, '3'],
    [57403, '4'],
    [57404, '5'],
    [57405, '6'],
    [57406, '7'],
    [57407, '8'],
    [57408, '9'],
    [57409, '.'],
    [57410, '/'],
    [57411, '*'],
    [57412, '-'],
    [57413, '+'],
    [57415, '='],
    [0xf0000, undefined],
    [0x100000, undefined],
  ])

  for (const [codepoint, name] of csiUKeyNames) {
    expect(parseKey(`\x1b[${codepoint}u`)).toEqual(
      expect.objectContaining({ name }),
    )
  }

  expect(parseKey('\x1b[1~')).toEqual(
    expect.objectContaining({ ctrl: false, name: 'home' }),
  )
  expect(parseKey('\x1b[4~')).toEqual(
    expect.objectContaining({ ctrl: false, name: 'end' }),
  )
  expect(parseKey('\x1b[1;5D')).toEqual(
    expect.objectContaining({ ctrl: true, name: 'left' }),
  )
})
