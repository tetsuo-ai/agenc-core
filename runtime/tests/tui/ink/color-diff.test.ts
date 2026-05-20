import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test } from 'vitest'

import {
  __test,
  ColorDiff,
  ColorFile,
  getNativeModule,
  getSyntaxTheme,
} from './native-ts/color-diff/index.js'

describe('color-diff native TypeScript helpers', () => {
  const originalColorTerm = process.env.COLORTERM
  const originalSyntaxTheme = process.env.AGENC_SYNTAX_HIGHLIGHT
  const originalBatTheme = process.env.BAT_THEME

  afterEach(() => {
    process.env.COLORTERM = originalColorTerm
    process.env.AGENC_SYNTAX_HIGHLIGHT = originalSyntaxTheme
    process.env.BAT_THEME = originalBatTheme
  })

  test('tokenizes text into words, whitespace, punctuation, and codepoints', () => {
    expect(__test.tokenize('foo bar_baz(1) 🚀')).toEqual([
      'foo',
      ' ',
      'bar_baz',
      '(',
      '1',
      ')',
      ' ',
      '🚀',
    ])
  })

  test('pairs adjacent removed and added lines for word diffs', () => {
    expect(__test.findAdjacentPairs(['-', '+', ' ', '-', '-', '+', '+'])).toEqual([
      [0, 1],
      [3, 5],
      [4, 6],
    ])
    expect(__test.findAdjacentPairs(['+', '-', ' '])).toEqual([])
  })

  test('returns word-level ranges only for small edits', () => {
    expect(__test.wordDiffStrings('const total = 1', 'const total = 2')).toEqual([
      [{ start: 14, end: 15 }],
      [{ start: 14, end: 15 }],
    ])
    expect(__test.wordDiffStrings('completely different old text', 'new')).toEqual([
      [],
      [],
    ])
  })

  test('detects color mode, language, and palette escapes', () => {
    process.env.COLORTERM = 'truecolor'
    expect(__test.detectColorMode('dark')).toBe('truecolor')
    expect(__test.detectColorMode('ansi')).toBe('ansi')

    delete process.env.COLORTERM
    expect(__test.detectColorMode('dark')).toBe('color256')

    expect(__test.detectLanguage('Dockerfile', null)).toBe('dockerfile')
    expect(__test.detectLanguage('script', '#!/usr/bin/env python')).toBe('python')
    expect(__test.detectLanguage('index.ts', null)).toBe('ts')
    expect(__test.detectLanguage('unknown.nope', null)).toBeNull()

    expect(__test.ansi256FromRgb(0, 0, 0)).toBe(16)
    expect(__test.ansi256FromRgb(255, 255, 255)).toBe(231)
    expect(__test.colorToEscape({ r: 2, g: 0, b: 0, a: 0 }, true, 'ansi')).toBe('\x1b[32m')
    expect(__test.colorToEscape({ r: 0, g: 0, b: 0, a: 1 }, false, 'ansi')).toBe('\x1b[49m')
    expect(__test.colorToEscape({ r: 1, g: 2, b: 3, a: 255 }, true, 'truecolor')).toBe('\x1b[38;2;1;2;3m')
  })

  test('reports default syntax themes and exposes the native module shim', () => {
    process.env.AGENC_SYNTAX_HIGHLIGHT = 'Custom'
    process.env.BAT_THEME = 'Other'

    expect(getSyntaxTheme('dark')).toEqual({
      theme: 'Monokai Extended',
      source: null,
    })
    expect(getSyntaxTheme('light')).toEqual({
      theme: 'GitHub',
      source: null,
    })
    expect(getSyntaxTheme('ansi')).toEqual({
      theme: 'ansi',
      source: null,
    })
    expect(getNativeModule()).toMatchObject({
      ColorDiff,
      ColorFile,
      getSyntaxTheme,
    })
  })
})

describe('color-diff rendering', () => {
  test('renders highlighted files with line numbers and drops trailing empty lines', () => {
    const lines = new ColorFile(
      'const answer = 42\nconsole.log(answer)\n',
      'example.ts',
    ).render('dark', 80, false)

    expect(lines).not.toBeNull()
    expect(lines).toHaveLength(2)

    const plain = lines!.map(line => stripAnsi(line)).join('\n')
    expect(plain).toContain('1 const answer = 42')
    expect(plain).toContain('2 console.log(answer)')
  })

  test('renders hunks with changed lines, context lines, and wrapping', () => {
    const lines = new ColorDiff(
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 2,
        lines: [
          '-const label = "old value"',
          '+const label = "new value"',
          ' console.log(label)',
        ],
      },
      null,
      'example.ts',
    ).render('dark', 22, false)

    expect(lines).not.toBeNull()
    expect(lines!.length).toBeGreaterThan(3)

    const plain = lines!.map(line => stripAnsi(line)).join('\n')
    expect(plain).toContain('-const label')
    expect(plain).toContain('+const label')
    expect(plain).toContain('console.log')
  })

  test('renders ANSI dimmed deletions without word-level backgrounds', () => {
    const lines = new ColorDiff(
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-before', '+after'],
      },
      null,
      'file.txt',
    ).render('ansi', 80, true)

    expect(lines).not.toBeNull()
    expect(lines!.join('\n')).toContain('\x1b[2m')

    const plain = lines!.map(line => stripAnsi(line)).join('\n')
    expect(plain).toContain('-before')
    expect(plain).toContain('+after')
  })
})
