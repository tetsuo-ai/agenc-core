import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let tempCwd = ''

const harness = vi.hoisted(() => ({
  fileIndexLoads: [] as string[][],
  logError: vi.fn(),
  ripGrep: vi.fn(async () => [] as string[]),
  reset() {
    this.fileIndexLoads = []
    this.logError.mockClear()
    this.ripGrep.mockClear()
  },
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => tempCwd,
  pwd: () => tempCwd,
  runWithCwdOverride: <T,>(_cwd: string, fn: () => T) => fn(),
}))

vi.mock('../../utils/settings/settings.js', () => ({
  getExecutionAuthoritySettings: () => ({ respectGitignore: false }),
  getInitialSettings: () => ({ respectGitignore: false }),
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
  findGitRoot: () => null,
  gitExe: () => 'git',
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../utils/path.js', () => ({
  expandPath: (value: string) => value,
}))

vi.mock('../../utils/ripgrep.js', () => ({
  ripGrep: harness.ripGrep,
}))

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrowWithCwd: vi.fn(async () => ({
    code: 1,
    stderr: '',
    stdout: '',
  })),
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

describe('fileSuggestions ripgrep fallback coverage', () => {
  beforeEach(() => {
    harness.reset()
    tempCwd = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-rg-'))
    mkdirSync(join(tempCwd, 'src'), { recursive: true })
    mkdirSync(join(tempCwd, 'ignored-dir'), { recursive: true })
    writeFileSync(join(tempCwd, '.ignore'), 'ignored.tmp\nignored-dir/\n')
    clearFileSuggestionCaches()
  })

  afterEach(() => {
    clearFileSuggestionCaches()
    rmSync(tempCwd, { recursive: true, force: true })
    tempCwd = ''
  })

  test('falls back to ripgrep with no-ignore-vcs and filters picker ignore patterns', async () => {
    harness.ripGrep.mockResolvedValueOnce([
      join(tempCwd, 'src', 'keep.ts'),
      join(tempCwd, 'ignored.tmp'),
      join(tempCwd, 'ignored-dir', 'drop.ts'),
    ])

    await getPathsForSuggestions()

    expect(harness.ripGrep).toHaveBeenCalledTimes(1)
    const [args, cwdArg] = harness.ripGrep.mock.calls[0]!
    expect(args).toEqual(expect.arrayContaining(['--files', '--no-ignore-vcs']))
    expect(cwdArg).toBe('.')
    expect(harness.fileIndexLoads).toEqual([
      [
        'src' + sep,
        `.agenc${sep}commands` + sep,
        '.agenc' + sep,
        `src${sep}keep.ts`,
        `.agenc${sep}commands${sep}context.md`,
      ],
    ])
    expect(harness.logError).not.toHaveBeenCalled()
  })
})
