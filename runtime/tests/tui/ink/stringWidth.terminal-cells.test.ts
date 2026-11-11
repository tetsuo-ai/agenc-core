import { describe, expect, test } from 'vitest'

import { TRANSCRIPT_FIXTURES } from '../components/markdown/fixtures/transcriptWidthFixtures.js'
import { terminalCells } from '../components/markdown/fixtures/terminalCells.js'
import { stringWidth } from './stringWidth.js'
import { wrapAnsi } from './wrapAnsi.js'

const VS16 = '️'
const ZWJ = '‍'

describe('stringWidth counts the cells a terminal uses', () => {
  const cases: Array<readonly [label: string, text: string, cells: number]> = [
    // Wide symbols: two cells with or without a selector. U+2705 is the one
    // from the owner's table of 2026-11-11.
    ['check mark button', '✅', 2],
    ['cross mark', '❌', 2],
    ['high voltage', '⚡', 2],
    ['hourglass', '⏳', 2],
    ['hot beverage', '☕', 2],
    ['question mark', '❓', 2],
    ['check mark button with selector', `✅${VS16}`, 2],
    // Text symbols: one cell, and two once U+FE0F asks for the emoji form.
    ['warning sign', '⚠', 1],
    ['warning sign with selector', `⚠${VS16}`, 2],
    ['heavy check mark', '✔', 1],
    ['heavy check mark with selector', `✔${VS16}`, 2],
    ['copyright', '©', 1],
    ['copyright with selector', `©${VS16}`, 2],
    ['trade mark', '™', 1],
    ['left right arrow', '↔', 1],
    ['play button', '▶', 1],
    ['thermometer without selector', '\u{1f321}', 1],
    ['thermometer with selector', `\u{1f321}${VS16}`, 2],
    // Clusters.
    ['family', `👨${ZWJ}👩${ZWJ}👧`, 2],
    ['technologist with skin tone', `👩🏽${ZWJ}💻`, 2],
    ['flag', '🇪🇸', 2],
    ['thumbs up with skin tone', '👍🏽', 2],
    ['pointing up with skin tone', '☝🏽', 2],
    ['keycap', `1${VS16}⃣`, 2],
    // Wide scripts and marks.
    ['Japanese', '日本語のテキスト', 16],
    ['Korean', '한국어', 6],
    ['fullwidth', 'ＡＢＣ１２３', 12],
    ['combining accent', 'café', 4],
    ['decomposed kana', 'がぎ', 4],
    ['decomposed Hangul', '한글', 4],
    ['Hebrew with points', 'שָׁלוֹם', 4],
    ['Arabic with vowel signs', 'مَرْحَبًا', 5],
    ['direction marks', 'a‎b‏c‪d‬', 4],
    ['line with all kinds', `P1 ✅ ok ⚠${VS16} 日本 ©`, 18],
  ]

  test.each(cases)('%s', (_label, text, cells) => {
    expect(terminalCells(text)).toBe(cells)
    expect(stringWidth(text)).toBe(cells)
  })

  test('the width of a text is the sum of its parts, whatever stands next to it', () => {
    // Before the fix a text symbol such as U+00A9 or U+2194 counted one cell
    // alone and two cells as soon as the same string held an emoji, so a
    // line and its pieces disagreed and rows drifted.
    const parts = cases.map(([, text]) => text)
    for (const part of parts) {
      for (const neighbour of ['😀', '✅', `⚠${VS16}`, '日', 'a']) {
        expect(stringWidth(`${part} ${neighbour}`)).toBe(
          stringWidth(part) + 1 + stringWidth(neighbour),
        )
        expect(stringWidth(`${neighbour} ${part}`)).toBe(
          stringWidth(neighbour) + 1 + stringWidth(part),
        )
      }
    }
  })

  test('every word of the fixtures has the reference width', () => {
    for (const fixture of TRANSCRIPT_FIXTURES) {
      for (const word of fixture.markdown.split(/\s+/)) {
        expect([word, stringWidth(word)]).toEqual([word, terminalCells(word)])
      }
    }
  })

  test('the wrap library never makes a line wider than asked, measured with stringWidth', () => {
    // The wrap library measures with its own table. This pins that the two
    // agree on what the transcript shows: emoji, symbols, wide scripts.
    for (const fixture of TRANSCRIPT_FIXTURES) {
      const text = fixture.markdown.replace(/\n+/g, ' ')
      for (const width of [7, 12, 20, 33, 56, 76]) {
        for (const line of wrapAnsi(text, width, { hard: true, trim: true }).split('\n')) {
          expect([line, stringWidth(line) <= width]).toEqual([line, true])
        }
      }
    }
  })
})
