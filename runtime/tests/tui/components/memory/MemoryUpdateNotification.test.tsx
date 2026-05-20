import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import {
  getRelativeMemoryPath,
  MemoryUpdateNotification,
} from './MemoryUpdateNotification.js'
import { getRelativeMemoryPathForRoots } from './path-format.js'

vi.mock('os', () => ({
  homedir: () => '/home/tester',
}))

vi.mock('../../../utils/cwd.js', () => ({
  getCwd: () => '/home/tester/project',
}))

describe('getRelativeMemoryPathForRoots', () => {
  test('formats paths relative to home and cwd roots', () => {
    expect(
      getRelativeMemoryPathForRoots(
        '/home/tester/.agenc/memory.md',
        '/home/tester',
        '/work/repo',
      ),
    ).toBe('~/.agenc/memory.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/work/repo/AGENTS.md',
        '/home/tester',
        '/work/repo',
      ),
    ).toBe('./AGENTS.md')
  })

  test('formats exact root paths as root markers', () => {
    expect(
      getRelativeMemoryPathForRoots('/home/tester', '/home/tester', '/work/repo'),
    ).toBe('~')
    expect(
      getRelativeMemoryPathForRoots('/work/repo', '/home/tester', '/work/repo'),
    ).toBe('.')
  })

  test('chooses the shorter path when home and cwd both contain the file', () => {
    expect(
      getRelativeMemoryPathForRoots(
        '/home/tester/project/AGENC.md',
        '/home/tester',
        '/home/tester/project',
      ),
    ).toBe('./AGENC.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/home/tester/x.md',
        '/home/tester',
        '/home/tester/project',
      ),
    ).toBe('~/x.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/home/tester/a',
        '/home/tester',
        '/home/tester',
      ),
    ).toBe('~/a')
  })

  test('returns the original path outside both roots and avoids prefix matches', () => {
    expect(
      getRelativeMemoryPathForRoots(
        '/var/tmp/memory.md',
        '/home/tester',
        '/work/repo',
      ),
    ).toBe('/var/tmp/memory.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/work/repository/memory.md',
        '/home/tester',
        '/work/repo',
      ),
    ).toBe('/work/repository/memory.md')
  })
})

describe('MemoryUpdateNotification', () => {
  test('uses the current home and cwd roots for display paths', () => {
    expect(getRelativeMemoryPath('/home/tester/project/.agenc/memory.md')).toBe(
      './.agenc/memory.md',
    )
  })

  test('renders the formatted memory update notice', async () => {
    const output = await renderToString(
      <MemoryUpdateNotification memoryPath="/home/tester/project/AGENC.md" />,
      100,
    )

    expect(output).toContain('Memory updated in ./AGENC.md')
    expect(output).toContain('/memory to edit')
  })
})
