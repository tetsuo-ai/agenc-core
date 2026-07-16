import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type ExecResult = {
  code: number
  stdout: string
  stderr: string
}

let tempRoot = ''
let tempCwd = ''

const harness = vi.hoisted(() => ({
  execCalls: [] as Array<{
    args: string[]
    options: { cwd?: string; timeout?: number }
  }>,
  execResults: [] as Array<ExecResult | Error>,
  fileIndexLoads: [] as string[][],
  gitRoot: null as string | null,
  globalConfig: {} as Record<string, unknown>,
  logError: vi.fn(),
  markdownFiles: [] as string[],
  projectSettings: {} as Record<string, unknown>,
  ripGrep: vi.fn(async () => [] as string[]),
  yieldToEventLoop: vi.fn(async () => {}),
  reset() {
    this.execCalls = []
    this.execResults = []
    this.fileIndexLoads = []
    this.gitRoot = null
    this.globalConfig = {}
    this.markdownFiles = []
    this.projectSettings = {}
    this.logError.mockClear()
    this.ripGrep.mockReset()
    this.ripGrep.mockResolvedValue([])
    this.yieldToEventLoop.mockClear()
  },
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => tempCwd,
  pwd: () => tempCwd,
  runWithCwdOverride: <T,>(_cwd: string, fn: () => T) => fn(),
}))

vi.mock('../../utils/settings/settings.js', () => ({
  getExecutionAuthoritySettings: () => harness.projectSettings,
  getInitialSettings: () => harness.projectSettings,
  getSettingsForSource: (source: string) =>
    source === 'projectSettings' ? harness.projectSettings : undefined,
}))

vi.mock('../../utils/config.js', () => ({
  checkHasTrustDialogAccepted: () => true,
  getGlobalConfig: () => harness.globalConfig,
}))

vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({ cwd: tempCwd }),
  executeFileSuggestionCommand: async () => [],
}))

vi.mock('../../utils/markdownConfigLoader.js', () => ({
  AGENC_CONFIG_DIRECTORIES: ['agents'],
  loadMarkdownFilesForSubdir: async () =>
    harness.markdownFiles.map(filePath => ({ filePath })),
}))

vi.mock('../../utils/git', () => ({
  findGitRoot: () => harness.gitRoot,
  gitExe: () => 'git',
}))

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrowWithCwd: async (
    _command: string,
    args: string[],
    options: { cwd?: string; timeout?: number },
  ) => {
    harness.execCalls.push({ args, options })
    const result = harness.execResults.shift()
    if (result instanceof Error) throw result
    return result ?? { code: 0, stdout: '', stderr: '' }
  },
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../utils/ripgrep.js', () => ({
  ripGrep: harness.ripGrep,
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../ink/native-ts/file-index/index', () => ({
  CHUNK_MS: 4,
  FileIndex: class {
    loadFromFileListAsync(paths: string[]) {
      harness.fileIndexLoads.push([...paths])
      return { done: Promise.resolve() }
    }

    search() {
      return []
    }
  },
  yieldToEventLoop: harness.yieldToEventLoop,
}))

import {
  clearFileSuggestionCaches,
  getPathsForSuggestions,
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from '../hooks/fileSuggestions.js'

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  throw lastError
}

beforeEach(() => {
  harness.reset()
  tempRoot = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-swarm-'))
  tempCwd = tempRoot
  clearFileSuggestionCaches()
})

afterEach(() => {
  clearFileSuggestionCaches()
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  tempCwd = ''
})

describe('fileSuggestions project file loading', () => {
  test('normalizes git paths from repo root to cwd and merges untracked files', async () => {
    tempCwd = join(tempRoot, 'packages', 'app')
    mkdirSync(tempCwd, { recursive: true })
    writeFileSync(
      join(tempCwd, '.agencignore'),
      'ignored.ts\nignored-untracked.ts\n',
    )

    harness.gitRoot = tempRoot
    harness.markdownFiles = ['.agenc/agents/build.md']
    harness.execResults = [
      {
        code: 0,
        stdout: 'packages/app/src/index.ts\npackages/app/ignored.ts\n',
        stderr: '',
      },
      {
        code: 0,
        stdout:
          'packages/app/new-file.ts\npackages/app/ignored-untracked.ts\n',
        stderr: '',
      },
    ]

    await getPathsForSuggestions()
    await waitFor(() => expect(harness.fileIndexLoads).toHaveLength(2))

    expect(harness.execCalls[0]?.args).toEqual([
      '-c',
      'core.quotepath=false',
      'ls-files',
      '--recurse-submodules',
    ])
    expect(harness.execCalls[0]?.options.cwd).toBe(tempRoot)
    expect(harness.execCalls[1]?.args).toEqual([
      '-c',
      'core.quotepath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
    ])

    const trackedLoad = harness.fileIndexLoads[0]!
    expect(trackedLoad).toEqual(
      expect.arrayContaining([
        'src' + sep,
        '.agenc' + sep,
        join('.agenc', 'agents') + sep,
        'src/index.ts',
        join('.agenc', 'agents', 'build.md'),
      ]),
    )
    expect(trackedLoad).not.toContain('ignored.ts')

    const mergedLoad = harness.fileIndexLoads[1]!
    expect(mergedLoad).toEqual(
      expect.arrayContaining([
        'src/index.ts',
        join('.agenc', 'agents', 'build.md'),
        'new-file.ts',
      ]),
    )
    expect(mergedLoad).not.toContain('ignored-untracked.ts')
  })

  test('falls back to ripgrep and disables ignore-vcs when configured', async () => {
    harness.gitRoot = null
    harness.projectSettings = { respectGitignore: false }
    harness.ripGrep.mockResolvedValue([
      join(tempCwd, 'src', 'index.ts'),
      join(tempCwd, 'src', 'utils', 'tool.ts'),
    ])

    await getPathsForSuggestions()

    expect(harness.execCalls).toEqual([])
    expect(harness.ripGrep).toHaveBeenCalledWith(
      expect.arrayContaining(['--no-ignore-vcs']),
      '.',
      expect.any(AbortSignal),
    )
    expect(harness.fileIndexLoads[0]).toEqual(
      expect.arrayContaining([
        'src' + sep,
        join('src', 'utils') + sep,
        join('src', 'index.ts'),
        join('src', 'utils', 'tool.ts'),
      ]),
    )
  })

  test('logs scanner failures and still returns the reusable file index', async () => {
    const scanError = new Error('scan failed')
    harness.gitRoot = null
    harness.ripGrep.mockRejectedValue(scanError)

    await expect(getPathsForSuggestions()).resolves.toBeDefined()

    expect(harness.logError).toHaveBeenCalledWith(scanError)
    expect(harness.fileIndexLoads).toEqual([])
  })

  test('background refresh coalesces in-flight work and throttles repeats', async () => {
    const listener = vi.fn()
    const unsubscribe = onIndexBuildComplete(listener)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    harness.gitRoot = null
    harness.ripGrep.mockResolvedValue([join(tempCwd, 'src', 'index.ts')])

    try {
      startBackgroundCacheRefresh()
      startBackgroundCacheRefresh()

      await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
      expect(harness.ripGrep).toHaveBeenCalledTimes(1)

      startBackgroundCacheRefresh()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(harness.ripGrep).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      nowSpy.mockRestore()
    }
  })
})
