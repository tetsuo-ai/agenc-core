import { describe, expect, test } from 'vitest'

import { FileIndex } from '../../../src/tui/ink/native-ts/file-index/index.js'

describe('coverage swarm row 217 file index', () => {
  test('handles windows separators and root-only empty top-level segments', () => {
    const index = new FileIndex()

    index.loadFromFileList([
      '',
      '/absolute/file.ts',
      '\\rooted\\file.ts',
      'zeta\\leaf.ts',
      'aa\\win.ts',
      'aa\\win.ts',
      'bb/file.ts',
      'a/file.ts',
    ])

    expect(index.search('', 10)).toEqual([
      { path: 'a', score: 0 },
      { path: 'aa', score: 0 },
      { path: 'bb', score: 0 },
      { path: 'zeta', score: 0 },
    ])
    expect(index.search('', 2)).toEqual([
      { path: 'a', score: 0 },
      { path: 'aa', score: 0 },
    ])
  })

  test('matches every boundary form and keeps uppercase queries case-sensitive', () => {
    const index = new FileIndex()

    index.loadFromFileList([
      'src/ab.ts',
      'src/a/b.ts',
      'src/a\\b.ts',
      'src/a-b.ts',
      'src/a_b.ts',
      'src/a.b.ts',
      'src/a b.ts',
      'src/axb.ts',
      'src/aB.ts',
      'src/ba.ts',
    ])

    const paths = index.search('ab', 20).map(result => result.path)

    expect(paths).toEqual(
      expect.arrayContaining([
        'src/ab.ts',
        'src/a/b.ts',
        'src/a\\b.ts',
        'src/a-b.ts',
        'src/a_b.ts',
        'src/a.b.ts',
        'src/a b.ts',
        'src/axb.ts',
      ]),
    )
    expect(paths).not.toContain('src/ba.ts')
    expect(index.search('aB', 10).map(result => result.path)).toEqual([
      'src/aB.ts',
    ])
  })

  test('replaces weaker top-k entries and rejects paths with missing or misordered matches', () => {
    const replacementIndex = new FileIndex()
    replacementIndex.loadFromFileList(['src/a-x-b.ts', 'src/ab.ts'])

    expect(replacementIndex.search('ab', 1)).toEqual([
      { path: 'src/ab.ts', score: 0 },
    ])

    const rejectionIndex = new FileIndex()
    rejectionIndex.loadFromFileList([
      'src/abc.ts',
      'src/acb.ts',
      'src/zzz.ts',
      `src/a${'x'.repeat(80)}b${'x'.repeat(80)}c.ts`,
    ])

    expect(rejectionIndex.search('abc', 1)).toEqual([
      { path: 'src/abc.ts', score: 0 },
    ])
    expect(rejectionIndex.search('abc', 10).map(result => result.path)).not.toContain(
      'src/acb.ts',
    )
    expect(rejectionIndex.search('1', 10)).toEqual([])
  })
})
