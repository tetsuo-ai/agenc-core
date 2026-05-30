import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getFsImplementation,
  setFsImplementation,
} from 'src/utils/fsOperations.js'
import { walkPluginMarkdown } from 'src/utils/plugins/walkPluginMarkdown.js'

function dirent(name: string, kind: 'file' | 'dir') {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  }
}

describe('walkPluginMarkdown per-file isolation', () => {
  let original: ReturnType<typeof getFsImplementation>

  beforeEach(() => {
    original = getFsImplementation()
  })
  afterEach(() => {
    setFsImplementation(original)
  })

  it('continues processing sibling files when one onFile rejects', async () => {
    setFsImplementation({
      readdir: async () => [
        dirent('good1.md', 'file'),
        dirent('bad.md', 'file'),
        dirent('good2.md', 'file'),
        dirent('ignore.txt', 'file'),
      ],
    } as unknown as ReturnType<typeof getFsImplementation>)

    const processed: string[] = []
    await expect(
      walkPluginMarkdown('/root', async fullPath => {
        if (fullPath.endsWith('bad.md')) {
          throw new Error('boom')
        }
        processed.push(fullPath)
      }),
    ).resolves.toBeUndefined()

    // Both good files ran even though bad.md rejected; the .txt was skipped.
    expect(processed.some(p => p.endsWith('good1.md'))).toBe(true)
    expect(processed.some(p => p.endsWith('good2.md'))).toBe(true)
    expect(processed.some(p => p.endsWith('ignore.txt'))).toBe(false)
    expect(processed).toHaveLength(2)
  })

  it('discovers .md files case-insensitively', async () => {
    setFsImplementation({
      readdir: async () => [
        dirent('Upper.MD', 'file'),
        dirent('mixed.Md', 'file'),
      ],
    } as unknown as ReturnType<typeof getFsImplementation>)

    const processed: string[] = []
    await walkPluginMarkdown('/root', async fullPath => {
      processed.push(fullPath)
    })

    expect(processed).toHaveLength(2)
  })
})
