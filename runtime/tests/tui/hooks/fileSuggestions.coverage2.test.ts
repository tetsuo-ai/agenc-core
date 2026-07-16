import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let tempRepoRoot = ''
let tempCwd = ''

const harness = vi.hoisted(() => ({
  execCalls: [] as { args: string[]; cwd?: string }[],
  fileIndexLoads: [] as string[][],
  logError: vi.fn(),
  reset() {
    this.execCalls = []
    this.fileIndexLoads = []
    this.logError.mockClear()
  },
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => tempCwd,
  pwd: () => tempCwd,
  runWithCwdOverride: <T,>(_cwd: string, fn: () => T) => fn(),
}))

vi.mock('../../utils/settings/settings.js', () => ({
  getExecutionAuthoritySettings: () => ({}),
  getInitialSettings: () => ({}),
  getSettingsForSource: () => undefined,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  checkHasTrustDialogAccepted: () => true,
}))

vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({ base: true }),
  executeFileSuggestionCommand: async () => [],
}))

vi.mock('../../utils/markdownConfigLoader.js', () => ({
  AGENC_CONFIG_DIRECTORIES: ['commands'],
  loadMarkdownFilesForSubdir: async () => [
    { filePath: `.agenc${sep}commands${sep}context.md` },
  ],
}))

vi.mock('../../utils/git', () => ({
  findGitRoot: () => tempRepoRoot,
  gitExe: () => 'git',
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../utils/path.js', () => ({
  expandPath: (value: string) => value,
}))

vi.mock('../../utils/ripgrep.js', () => ({
  ripGrep: vi.fn(async () => []),
}))

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrowWithCwd: vi.fn(
    async (_file: string, args: string[], options?: { cwd?: string }) => {
      harness.execCalls.push({ args, cwd: options?.cwd })
      if (args.includes('--recurse-submodules')) {
        return {
          code: 0,
          stderr: '',
          stdout:
            'workspace/src/tracked.ts\nworkspace/ignored.tmp\nworkspace/nested/deep.ts\n',
        }
      }
      if (args.includes('--others')) {
        return {
          code: 0,
          stderr: '',
          stdout:
            'workspace/loose.txt\nworkspace/ignored.tmp\nworkspace/nested/untracked.ts\n',
        }
      }
      return { code: 1, stderr: 'unexpected git args', stdout: '' }
    },
  ),
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
    get readyCount() {
      return 0
    }
  },
  yieldToEventLoop: vi.fn(async () => {}),
}))

import {
  clearFileSuggestionCaches,
  getPathsForSuggestions,
} from './fileSuggestions.js'

async function waitForFileIndexLoads(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (harness.fileIndexLoads.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`expected ${count} file index loads`)
}

describe('fileSuggestions git-backed coverage', () => {
  beforeEach(() => {
    harness.reset()
    tempRepoRoot = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-repo-'))
    tempCwd = join(tempRepoRoot, 'workspace')
    mkdirSync(tempCwd, { recursive: true })
    writeFileSync(join(tempCwd, '.agencignore'), 'ignored.tmp\n')
    clearFileSuggestionCaches()
  })

  afterEach(() => {
    clearFileSuggestionCaches()
    rmSync(tempRepoRoot, { recursive: true, force: true })
    tempRepoRoot = ''
    tempCwd = ''
  })

  test('loads git-tracked paths relative to cwd and merges untracked paths after ignore filtering', async () => {
    await getPathsForSuggestions()
    await waitForFileIndexLoads(2)

    expect(harness.execCalls).toEqual([
      {
        args: [
          '-c',
          'core.quotepath=false',
          'ls-files',
          '--recurse-submodules',
        ],
        cwd: tempRepoRoot,
      },
      {
        args: [
          '-c',
          'core.quotepath=false',
          'ls-files',
          '--others',
          '--exclude-standard',
        ],
        cwd: tempRepoRoot,
      },
    ])

    expect(harness.fileIndexLoads.at(-1)).toEqual([
      `src${sep}tracked.ts`,
      `nested${sep}deep.ts`,
      `.agenc${sep}commands${sep}context.md`,
      'src' + sep,
      'nested' + sep,
      `.agenc${sep}commands${sep}`,
      '.agenc' + sep,
      'loose.txt',
      `nested${sep}untracked.ts`,
      'nested' + sep,
    ])
  })
})
