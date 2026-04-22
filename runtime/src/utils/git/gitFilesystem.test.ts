import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { clearResolveGitDirCache, resolveGitDir } from './gitFilesystem.js'

const cleanupPaths: string[] = []

afterEach(() => {
  clearResolveGitDirCache()
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()
    if (path) {
      rmSync(path, { recursive: true, force: true })
    }
  }
})

describe('resolveGitDir', () => {
  test('resolves a nested repository to its .git directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-gitfs-'))
    cleanupPaths.push(root)

    mkdirSync(join(root, '.git'))
    const nested = join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })

    await expect(resolveGitDir(nested)).resolves.toBe(join(root, '.git'))
  })
})
