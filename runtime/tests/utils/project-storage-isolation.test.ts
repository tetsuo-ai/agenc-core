import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findProjectDir,
  getProjectDir,
  getProjectsDir,
  resolveSessionFilePath,
  sanitizePath,
} from '../../src/utils/sessionStoragePortable.js'
import { buildProjectMemoryDirectory } from '../../src/memory/paths.js'
import { sanitizePathForProjectKey } from '../../src/services/extractMemories/memory-paths.js'
import { getWorktreePathsPortable } from '../../src/utils/getWorktreePathsPortable.js'
import { listSessionsImpl } from '../../src/utils/listSessionsImpl.js'

vi.mock('../../src/utils/getWorktreePathsPortable.js', () => ({
  getWorktreePathsPortable: vi.fn(async () => []),
}))

describe('project storage isolation', () => {
  let home: string
  let legacyDirectories: string[]

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agenc-project-keys-'))
    legacyDirectories = []
    vi.mocked(getWorktreePathsPortable).mockResolvedValue([])
  })

  afterEach(() => {
    for (const directory of legacyDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
    rmSync(home, { recursive: true, force: true })
  })

  test.each([
    ['/work/acme/api', '/work/acme-api'],
    ['/work/a.b', '/work/a-b'],
    ['C:\\work\\acme\\api', 'C:\\work\\acme-api'],
  ])('separates project state for %s and %s', (firstRoot, secondRoot) => {
    expect(getProjectDir(firstRoot)).not.toBe(getProjectDir(secondRoot))
    expect(buildProjectMemoryDirectory(home, firstRoot)).not.toBe(
      buildProjectMemoryDirectory(home, secondRoot),
    )
    expect(sanitizePathForProjectKey(firstRoot)).not.toBe(
      sanitizePathForProjectKey(secondRoot),
    )
  })

  test('does not claim an ambiguous legacy directory for either root', async () => {
    const firstRoot = join(home, 'acme', 'api')
    const secondRoot = join(home, 'acme-api')
    const legacyDir = join(getProjectsDir(), sanitizePath(firstRoot))
    legacyDirectories.push(legacyDir)
    expect(sanitizePath(firstRoot)).toBe(sanitizePath(secondRoot))
    mkdirSync(legacyDir, { recursive: true })
    expect(await findProjectDir(firstRoot)).toBeUndefined()
    expect(await findProjectDir(secondRoot)).toBeUndefined()
  })

  test('does not choose an arbitrary long-prefix legacy directory', async () => {
    const projectRoot = join(home, 'deep'.repeat(80))
    const legacyPrefix = sanitizePath(projectRoot).slice(0, 200)
    const legacyDir = join(getProjectsDir(), `${legacyPrefix}-old-runtime`)
    legacyDirectories.push(legacyDir)
    mkdirSync(legacyDir, {
      recursive: true,
    })
    expect(await findProjectDir(projectRoot)).toBeUndefined()
  })

  test('keeps explicit global legacy selection without project ownership', async () => {
    const projectRoot = join(home, 'workspace')
    const sessionId = '00000000-0000-4000-8000-000000002059'
    const legacyDir = join(getProjectsDir(), sanitizePath(projectRoot))
    legacyDirectories.push(legacyDir)
    mkdirSync(legacyDir, { recursive: true })
    const filePath = join(legacyDir, `${sessionId}.jsonl`)
    writeFileSync(filePath, '{}\n')
    expect(await resolveSessionFilePath(sessionId)).toMatchObject({
      filePath,
      projectPath: undefined,
    })
    expect(await resolveSessionFilePath(sessionId, projectRoot)).toBeUndefined()
  })

  test('worktree listing accepts exact keys, never legacy or suffixed prefix matches', async () => {
    const firstRoot = join(home, 'deep/'.repeat(50), 'first')
    const secondRoot = join(home, 'deep/'.repeat(50), 'second')
    vi.mocked(getWorktreePathsPortable).mockResolvedValue([firstRoot, secondRoot])
    const ownedId = '00000000-0000-4000-8000-000000002059'
    const foreignId = '00000000-0000-4000-8000-000000002060'
    const candidates = [
      [getProjectDir(secondRoot), ownedId],
      [`${getProjectDir(firstRoot)}-old`, foreignId],
      [join(getProjectsDir(), sanitizePath(firstRoot)), foreignId],
    ] as const
    for (const [directory, sessionId] of candidates) {
      legacyDirectories.push(directory)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `${sessionId}.jsonl`), JSON.stringify({
        type: 'last-prompt',
        sessionId,
        lastPrompt: 'retained session',
      }) + '\n')
    }
    const sessions = await listSessionsImpl({ dir: firstRoot, includeWorktrees: true })
    expect(sessions.map(session => session.sessionId)).toEqual([ownedId])
  })
})
