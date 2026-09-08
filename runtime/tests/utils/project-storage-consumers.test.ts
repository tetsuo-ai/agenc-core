import { afterEach, describe, expect, test } from 'vitest'
import { basename, dirname, join, sep } from 'node:path'
import {
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../src/bootstrap/state.js'
import { tasksDir } from '../../src/bin/task-store.js'
import { getProjectDir as rolloutProjectDir } from '../../src/session/session-store.js'
import { resolveSessionMemoryDirectory } from '../../src/memory/session/sessionMemoryUtils.js'
import { CACHE_PATHS } from '../../src/utils/cachePaths.js'
import { getFsImplementation } from '../../src/utils/fsOperations.js'
import { getProjectTempDir } from '../../src/utils/permissions/filesystem.js'
import { projectStorageKey } from '../../src/utils/project-storage-key.js'
import { getProjectDir as transcriptProjectDir } from '../../src/utils/sessionStorage.js'
import { getProjectDir as portableProjectDir } from '../../src/utils/sessionStoragePortable.js'

const previousOriginal = getOriginalCwd()
const previousRoot = getProjectRoot()
const previousCwd = getCwdState()

afterEach(() => {
  setOriginalCwd(previousOriginal)
  setProjectRoot(previousRoot)
  setCwdState(previousCwd)
})

describe('shared project storage consumers', () => {
  test('uses the same key for rollouts, transcripts, memory, tasks, cache and temp state', () => {
    const cwd = getFsImplementation().cwd()
    const key = projectStorageKey(cwd)
    const home = dirname(dirname(portableProjectDir(cwd)))
    setOriginalCwd(cwd)
    expect(basename(portableProjectDir(cwd))).toBe(key)
    expect(basename(transcriptProjectDir(cwd))).toBe(key)
    expect(basename(rolloutProjectDir(cwd, [], home))).toBe(key)
    expect(basename(CACHE_PATHS.baseLogs())).toBe(key)
    expect(basename(getProjectTempDir())).toBe(key)
    expect(tasksDir({ workspaceRoot: cwd, agencHome: home })).toBe(
      join(home, 'projects', key, 'tasks'),
    )
  })

  test('keeps generic session identifiers separate from project keys', () => {
    const cwd = getFsImplementation().cwd()
    const home = dirname(dirname(portableProjectDir(cwd)))
    const path = resolveSessionMemoryDirectory({ cwd, configHomeDir: home, sessionId: 'session:identifier' })
    expect(path.endsWith(`${sep}session-identifier${sep}session-memory${sep}`)).toBe(true)
    expect(path).toContain(`${sep}projects${sep}v2-`)
  })

  test('does not fold distinct Unicode project roots in bootstrap state', () => {
    const decomposed = join(getFsImplementation().cwd(), 'cafe\u0301')
    const composed = decomposed.normalize('NFC')
    expect(decomposed).not.toBe(composed)
    setOriginalCwd(decomposed)
    setProjectRoot(decomposed)
    setCwdState(decomposed)
    expect(getOriginalCwd()).toBe(decomposed)
    expect(getProjectRoot()).toBe(decomposed)
    expect(getCwdState()).toBe(decomposed)
    expect(transcriptProjectDir(decomposed)).not.toBe(transcriptProjectDir(composed))
  })
})
