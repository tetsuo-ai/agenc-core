import { homedir } from 'os'
import { join } from 'path'
import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { MemoryUpdateNotification } from './MemoryUpdateNotification.js'
import { getRelativeMemoryPathForRoots } from './path-format.js'

describe('memory path display formatting', () => {
  test('formats paths relative to home, cwd, or neither root', () => {
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('~')
    expect(
      getRelativeMemoryPathForRoots(
        '/workspace/project',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('.')
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user/.agenc/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('~/.agenc/AGENC.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/workspace/project/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('./AGENC.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/workspace/project/..config',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('./..config')
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user/project/AGENC.md',
        '/home/user',
        '/home/user/project',
      ),
    ).toBe('./AGENC.md')
    expect(
      getRelativeMemoryPathForRoots(
        '/outside/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('/outside/AGENC.md')
  })

  test('prefers home when home and cwd displays are the same length', () => {
    expect(
      getRelativeMemoryPathForRoots('/home/user', '/home/user', '/home/user'),
    ).toBe('~')
  })
})

describe('MemoryUpdateNotification', () => {
  test('renders the formatted memory path and edit command', async () => {
    const output = await renderToString(
      <MemoryUpdateNotification
        memoryPath={join(homedir(), '.agenc', 'AGENC.md')}
      />,
      80,
    )

    expect(output).toContain('Memory updated in ~/.agenc/AGENC.md')
    expect(output).toContain('/memory to edit')
  })
})
