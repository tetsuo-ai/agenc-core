import { describe, expect, test } from 'vitest'

import { createTokenizer } from '../../../src/tui/ink/termio/tokenize.ts'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

describe('termio tokenizer coverage swarm row 137', () => {
  test('buffers incomplete CSI input, flushes it, and reset discards it', () => {
    const tokenizer = createTokenizer()

    expect(tokenizer.feed(`hello${ESC}[`)).toEqual([
      { type: 'text', value: 'hello' },
    ])
    expect(tokenizer.buffer()).toBe(`${ESC}[`)

    expect(tokenizer.feed('31m!')).toEqual([
      { type: 'sequence', value: `${ESC}[31m` },
      { type: 'text', value: '!' },
    ])
    expect(tokenizer.buffer()).toBe('')

    expect(tokenizer.feed(`${ESC}]0;partial`)).toEqual([])
    expect(tokenizer.flush()).toEqual([
      { type: 'sequence', value: `${ESC}]0;partial` },
    ])
    expect(tokenizer.buffer()).toBe('')

    expect(tokenizer.feed(`${ESC}[?`)).toEqual([])
    tokenizer.reset()
    expect(tokenizer.feed('after reset')).toEqual([
      { type: 'text', value: 'after reset' },
    ])
  })

  test('classifies escape, intermediate, SS3, OSC, DCS, and APC sequences', () => {
    const tokenizer = createTokenizer()

    expect(
      tokenizer.feed(
        [
          `${ESC}c`,
          `${ESC}(B`,
          `${ESC}%G`,
          `${ESC}OP`,
          `${ESC}]0;title${BEL}`,
          `${ESC}]8;;url${ST}`,
          `${ESC}Ppayload${BEL}`,
          `${ESC}_app${ST}`,
          'tail',
        ].join(''),
      ),
    ).toEqual([
      { type: 'sequence', value: `${ESC}c` },
      { type: 'sequence', value: `${ESC}(B` },
      { type: 'sequence', value: `${ESC}%G` },
      { type: 'sequence', value: `${ESC}OP` },
      { type: 'sequence', value: `${ESC}]0;title${BEL}` },
      { type: 'sequence', value: `${ESC}]8;;url${ST}` },
      { type: 'sequence', value: `${ESC}Ppayload${BEL}` },
      { type: 'sequence', value: `${ESC}_app${ST}` },
      { type: 'text', value: 'tail' },
    ])
  })

  test('recovers invalid escape forms as text and resumes at nested escapes', () => {
    const tokenizer = createTokenizer()

    expect(tokenizer.feed(`${ESC}\x00x`)).toEqual([
      { type: 'text', value: `${ESC}\x00x` },
    ])
    expect(tokenizer.feed(`${ESC}(\x1fz`)).toEqual([
      { type: 'text', value: `${ESC}(\x1fz` },
    ])
    expect(tokenizer.feed(`${ESC}O\x1fq`)).toEqual([
      { type: 'text', value: `${ESC}O\x1fq` },
    ])
    expect(tokenizer.feed(`${ESC}[${ESC}[A`)).toEqual([
      { type: 'text', value: `${ESC}[` },
      { type: 'sequence', value: `${ESC}[A` },
    ])
    expect(tokenizer.feed(`${ESC}${ESC}c`)).toEqual([
      { type: 'sequence', value: ESC },
      { type: 'sequence', value: `${ESC}c` },
    ])
  })

  test('gates X10 mouse payload consumption behind the option', () => {
    const defaultTokenizer = createTokenizer()

    expect(defaultTokenizer.feed(`${ESC}[Mabc`)).toEqual([
      { type: 'sequence', value: `${ESC}[M` },
      { type: 'text', value: 'abc' },
    ])

    const mouseTokenizer = createTokenizer({ x10Mouse: true })
    expect(mouseTokenizer.feed(`${ESC}[Ma`)).toEqual([])
    expect(mouseTokenizer.buffer()).toBe(`${ESC}[Ma`)
    expect(mouseTokenizer.feed('bc')).toEqual([
      { type: 'sequence', value: `${ESC}[Mabc` },
    ])

    expect(mouseTokenizer.feed(`${ESC}[M${ESC}[A`)).toEqual([
      { type: 'sequence', value: `${ESC}[M` },
      { type: 'sequence', value: `${ESC}[A` },
    ])
    expect(mouseTokenizer.feed(`${ESC}[<0;1;2Mrest`)).toEqual([
      { type: 'sequence', value: `${ESC}[<0;1;2M` },
      { type: 'text', value: 'rest' },
    ])
  })
})
