import { describe, expect, test } from 'vitest'

import type { Diff } from '../../../src/tui/ink/frame.js'
import { optimize } from '../../../src/tui/ink/optimizer.js'

describe('optimizer coverage swarm row 103', () => {
  test('returns empty and single-patch diffs unchanged', () => {
    const empty: Diff = []
    const single: Diff = [{ type: 'stdout', content: 'ready' }]

    expect(optimize(empty)).toBe(empty)
    expect(optimize(single)).toBe(single)
  })

  test('filters no-op stdout, cursorMove, and clear patches', () => {
    const diff: Diff = [
      { type: 'stdout', content: '' },
      { type: 'cursorMove', x: 0, y: 0 },
      { type: 'clear', count: 0 },
      { type: 'stdout', content: 'visible' },
      { type: 'clear', count: 2 },
    ]

    expect(optimize(diff)).toEqual([
      { type: 'stdout', content: 'visible' },
      { type: 'clear', count: 2 },
    ])
  })

  test('merges cursor moves and collapses consecutive cursorTo patches', () => {
    const diff: Diff = [
      { type: 'cursorMove', x: 2, y: -1 },
      { type: 'cursorMove', x: -3, y: 4 },
      { type: 'stdout', content: 'x' },
      { type: 'cursorTo', col: 4 },
      { type: 'cursorTo', col: 9 },
    ]

    expect(optimize(diff)).toEqual([
      { type: 'cursorMove', x: -1, y: 3 },
      { type: 'stdout', content: 'x' },
      { type: 'cursorTo', col: 9 },
    ])
  })

  test('concatenates adjacent styles and dedupes only repeated hyperlink URIs', () => {
    const diff: Diff = [
      { type: 'styleStr', str: '\u001B[49m' },
      { type: 'styleStr', str: '\u001B[2m' },
      { type: 'hyperlink', uri: 'https://agenc.test/a' },
      { type: 'hyperlink', uri: 'https://agenc.test/a' },
      { type: 'hyperlink', uri: 'https://agenc.test/b' },
    ]

    expect(optimize(diff)).toEqual([
      { type: 'styleStr', str: '\u001B[49m\u001B[2m' },
      { type: 'hyperlink', uri: 'https://agenc.test/a' },
      { type: 'hyperlink', uri: 'https://agenc.test/b' },
    ])
  })

  test('cancels adjacent cursor visibility pairs in both orders', () => {
    const diff: Diff = [
      { type: 'cursorHide' },
      { type: 'cursorShow' },
      { type: 'stdout', content: 'after-first-pair' },
      { type: 'cursorShow' },
      { type: 'cursorHide' },
      { type: 'stdout', content: 'after-second-pair' },
    ]

    expect(optimize(diff)).toEqual([
      { type: 'stdout', content: 'after-first-pair' },
      { type: 'stdout', content: 'after-second-pair' },
    ])
  })
})
