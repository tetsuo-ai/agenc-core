import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
  type FsOperations,
} from '../../utils/fsOperations.js'

let tempCwd = ''

const harness = vi.hoisted(() => ({
  commandError: null as Error | null,
  commandInputs: [] as unknown[],
  commandResults: [] as string[],
  fileIndexLoads: [] as string[][],
  fileIndexSearchError: null as Error | null,
  fileIndexSearchQueries: [] as { limit: number; query: string }[],
  fileIndexSearchResults: [] as { path: string; score?: number }[],
  gitRoot: null as string | null,
  logError: vi.fn(),
  ripGrep: vi.fn(async () => [] as string[]),
  settings: {} as Record<string, unknown>,
  yieldToEventLoop: vi.fn(async () => {}),
  reset() {
    this.commandError = null
    this.commandInputs = []
    this.commandResults = []
    this.fileIndexLoads = []
    this.fileIndexSearchError = null
    this.fileIndexSearchQueries = []
    this.fileIndexSearchResults = []
    this.gitRoot = null
    this.settings = {}
    this.logError.mockClear()
    this.ripGrep.mockClear()
    this.yieldToEventLoop.mockClear()
  },
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => tempCwd,
  pwd: () => tempCwd,
  runWithCwdOverride: <T,>(_cwd: string, fn: () => T) => fn(),
}))

vi.mock('../../utils/settings/settings.js', () => ({
  getExecutionAuthoritySettings: () => harness.settings,
  getInitialSettings: () => harness.settings,
  getSettingsForSource: () => undefined,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  checkHasTrustDialogAccepted: () => true,
}))

// hooks.js pulls in 60+ heavyweight transitive deps (tools registry, telemetry,
// shell prefix providers, etc) that aren't reachable from the tested code
// paths. Stub the few helpers fileSuggestions.ts imports so the module graph
// stays small.
vi.mock('../../utils/hooks.js', () => ({
  createBaseHookInput: () => ({ base: true }),
  executeFileSuggestionCommand: async (input: unknown) => {
    harness.commandInputs.push(input)
    if (harness.commandError) throw harness.commandError
    return harness.commandResults
  },
}))

vi.mock('../../utils/markdownConfigLoader.js', () => ({
  AGENC_CONFIG_DIRECTORIES: [],
  loadMarkdownFilesForSubdir: async () => [],
}))

vi.mock('../../utils/git', () => ({
  findGitRoot: () => harness.gitRoot,
  gitExe: () => 'git',
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../utils/path.js', () => ({
  expandPath: (value: string) => value.replace(/^~/, '/home/tester'),
}))

vi.mock('../../utils/ripgrep.js', () => ({
  ripGrep: harness.ripGrep,
}))

vi.mock('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

// FileIndex is a Rust-backed native module the empty-query path does not need
// directly, but it sits in the same module graph. Provide a no-op stand-in so
// the import resolves without a build step.
vi.mock('../ink/native-ts/file-index/index', () => ({
  CHUNK_MS: 4,
  FileIndex: class {
    loadFromFileListAsync(paths: string[]) {
      harness.fileIndexLoads.push([...paths])
      return { done: Promise.resolve() }
    }
    search(query: string, limit: number) {
      harness.fileIndexSearchQueries.push({ query, limit })
      if (harness.fileIndexSearchError) throw harness.fileIndexSearchError
      return harness.fileIndexSearchResults.slice(0, limit)
    }
    get readyCount() {
      return 0
    }
  },
  yieldToEventLoop: harness.yieldToEventLoop,
}))

import {
  annotateBrokenSymlinks,
  applyFileSuggestion,
  clearFileSuggestionCaches,
  findLongestCommonPrefix,
  generateFileSuggestions,
  getDirectoryNames,
  getDirectoryNamesAsync,
  getHiddenTopLevelMatches,
  pathListSignature,
} from './fileSuggestions.js'

beforeEach(() => {
  harness.reset()
})

describe('fileSuggestions pure helpers', () => {
  test('pathListSignature is stable and changes when sampled contents change', () => {
    const original = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    const same = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    const middleChanged = ['src/a.ts', 'src/b-renamed.ts', 'src/c.ts']
    const tailChanged = ['src/a.ts', 'src/b.ts', 'src/d.ts']

    expect(pathListSignature([])).toBe(pathListSignature([]))
    expect(pathListSignature(original)).toBe(pathListSignature(same))
    expect(pathListSignature(original)).not.toBe(
      pathListSignature(middleChanged),
    )
    expect(pathListSignature(original)).not.toBe(pathListSignature(tailChanged))
  })

  test('pathListSignature changes for unsampled large-list renames', () => {
    const original = Array.from(
      { length: 1_000 },
      (_, index) => `src/file-${index}.ts`,
    )
    const renamedOddEntry = [...original]
    renamedOddEntry[501] = 'src/file-501-renamed.ts'

    expect(pathListSignature(renamedOddEntry)).not.toBe(
      pathListSignature(original),
    )
  })

  test('getDirectoryNames returns unique parent directories only', () => {
    const dirs = getDirectoryNames([
      'README.md',
      'src/index.ts',
      'src/utils/file.ts',
      'src/utils/other.ts',
    ])

    expect(dirs).toEqual(['src' + sep, join('src', 'utils') + sep])
    expect(dirs).not.toContain('.' + sep)
  })

  test('getDirectoryNamesAsync matches sync output and yields during long scans', async () => {
    const files = Array.from(
      { length: 257 },
      (_, index) => join('src', `dir-${index}`, 'file.ts'),
    )
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValue(10)

    try {
      await expect(getDirectoryNamesAsync(files)).resolves.toEqual(
        getDirectoryNames(files),
      )
      expect(harness.yieldToEventLoop).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  test('findLongestCommonPrefix handles empty, shared, and disjoint suggestions', () => {
    expect(findLongestCommonPrefix([])).toBe('')
    expect(
      findLongestCommonPrefix([
        { id: 'file-src/index.ts', displayText: 'src/index.ts' },
        { id: 'file-src/input.ts', displayText: 'src/input.ts' },
        { id: 'file-src/infra.ts', displayText: 'src/infra.ts' },
      ]),
    ).toBe('src/in')
    expect(
      findLongestCommonPrefix([
        { id: 'file-src/index.ts', displayText: 'src/index.ts' },
        { id: 'file-test/index.ts', displayText: 'test/index.ts' },
      ]),
    ).toBe('')
  })

  test('applyFileSuggestion accepts plain strings and suggestion items', () => {
    const stringChange = vi.fn()
    const stringCursor = vi.fn()
    applyFileSuggestion(
      'src/index.ts',
      'open @sr now',
      'sr',
      6,
      stringChange,
      stringCursor,
    )

    expect(stringChange).toHaveBeenCalledWith('open @src/index.ts now')
    expect(stringCursor).toHaveBeenCalledWith(18)

    const itemChange = vi.fn()
    const itemCursor = vi.fn()
    applyFileSuggestion(
      { id: 'file-tests/unit.ts', displayText: 'tests/unit.ts' },
      'run @te',
      'te',
      5,
      itemChange,
      itemCursor,
    )

    expect(itemChange).toHaveBeenCalledWith('run @tests/unit.ts')
    expect(itemCursor).toHaveBeenCalledWith(18)
  })
})

describe('fileSuggestions hidden-file visibility', () => {
  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-'))
    clearFileSuggestionCaches()
  })

  afterEach(() => {
    setOriginalFsImplementation()
    rmSync(tempCwd, { recursive: true, force: true })
    tempCwd = ''
  })

  test('empty @ query lists hidden dotfiles in the cwd', async () => {
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')
    writeFileSync(join(tempCwd, 'visible.txt'), '')

    const items = await generateFileSuggestions('', true)
    const names = items.map(i => i.displayText)
    expect(names).toContain('.hidden-file.txt')
    expect(names).toContain('visible.txt')
  })

  test('dotted prefix query (.hid) surfaces matching hidden dotfiles', async () => {
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')
    writeFileSync(join(tempCwd, '.hideme'), '')
    writeFileSync(join(tempCwd, '.other'), '')

    const matches = await getHiddenTopLevelMatches('.hid')
    expect(matches).toContain('.hidden-file.txt')
    expect(matches).toContain('.hideme')
    expect(matches).not.toContain('.other')
  })

  test('dotted prefix query with two literal dots surfaces matching top-level files', async () => {
    writeFileSync(join(tempCwd, '..hidden-file.txt'), '')
    writeFileSync(join(tempCwd, '..hideme'), '')
    writeFileSync(join(tempCwd, '..other'), '')

    const items = await generateFileSuggestions('..hid')
    const names = items.map(i => i.displayText)

    expect(names).toContain('..hidden-file.txt')
    expect(names).toContain('..hideme')
    expect(names).not.toContain('..other')
  })

  test('getHiddenTopLevelMatches marks directories with a trailing separator', async () => {
    mkdirSync(join(tempCwd, '.config'), { recursive: true })

    const matches = await getHiddenTopLevelMatches('.config')
    expect(matches).toContain('.config' + sep)
  })

  test('empty @ query excludes paths ignored by .agencignore', async () => {
    writeFileSync(join(tempCwd, '.agencignore'), 'ignored.txt\nignored-dir/\n')
    writeFileSync(join(tempCwd, 'ignored.txt'), '')
    writeFileSync(join(tempCwd, 'visible.txt'), '')
    mkdirSync(join(tempCwd, 'ignored-dir'), { recursive: true })

    const items = await generateFileSuggestions('', true)
    const names = items.map(i => i.displayText)

    expect(names).toContain('visible.txt')
    expect(names).not.toContain('ignored.txt')
    expect(names).not.toContain('ignored-dir' + sep)
  })

  test('logs unreadable picker ignore files without hiding suggestions', async () => {
    const readError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    const originalFs = getFsImplementation()
    setFsImplementation({
      ...originalFs,
      async readFile(filePath, options) {
        if (filePath === join(tempCwd, '.agencignore')) {
          throw readError
        }
        return originalFs.readFile(filePath, options)
      },
    } as FsOperations)
    writeFileSync(join(tempCwd, '.agencignore'), 'secret.txt\n')
    writeFileSync(join(tempCwd, 'secret.txt'), '')

    const items = await generateFileSuggestions('', true)

    expect(items.map(item => item.displayText)).toContain('secret.txt')
    expect(harness.logError).toHaveBeenCalledWith(readError)
  })

  test('dotted prefix query excludes hidden paths ignored by .agencignore', async () => {
    writeFileSync(join(tempCwd, '.agencignore'), '.hidden-file.txt\n')
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')
    writeFileSync(join(tempCwd, '.hideme'), '')

    const matches = await getHiddenTopLevelMatches('.hid')

    expect(matches).toContain('.hideme')
    expect(matches).not.toContain('.hidden-file.txt')
  })

  test('getHiddenTopLevelMatches returns no matches when cwd cannot be read', async () => {
    rmSync(tempCwd, { recursive: true, force: true })

    await expect(getHiddenTopLevelMatches('.hid')).resolves.toEqual([])
  })
})

describe('fileSuggestions broken symlink annotation', () => {
  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-'))
    clearFileSuggestionCaches()
  })

  afterEach(() => {
    rmSync(tempCwd, { recursive: true, force: true })
    tempCwd = ''
  })

  test('annotateBrokenSymlinks flags symlinks whose target does not exist', () => {
    writeFileSync(join(tempCwd, 'real.txt'), '')
    symlinkSync(
      join(tempCwd, 'does-not-exist'),
      join(tempCwd, 'broken-link'),
    )
    symlinkSync(join(tempCwd, 'real.txt'), join(tempCwd, 'good-link'))

    const annotated = annotateBrokenSymlinks([
      { id: 'file-real.txt', displayText: 'real.txt' },
      { id: 'file-broken-link', displayText: 'broken-link' },
      { id: 'file-good-link', displayText: 'good-link' },
    ])

    const byName = new Map(annotated.map(i => [i.displayText, i.description]))
    expect(byName.get('real.txt')).toBeUndefined()
    expect(byName.get('good-link')).toBeUndefined()
    expect(byName.get('broken-link')).toBe('(broken)')
  })

  test('annotateBrokenSymlinks leaves vanished rows and absolute paths unchanged', () => {
    writeFileSync(join(tempCwd, 'absolute.txt'), '')

    const vanished = { id: 'file-vanished.txt', displayText: 'vanished.txt' }
    const absolute = {
      id: 'file-absolute.txt',
      displayText: join(tempCwd, 'absolute.txt'),
    }

    expect(annotateBrokenSymlinks([vanished, absolute])).toEqual([
      vanished,
      absolute,
    ])
  })

  test('empty @ query annotates broken symlinks in the cwd', async () => {
    symlinkSync(
      join(tempCwd, 'missing-target'),
      join(tempCwd, 'dangling'),
    )

    const items = await generateFileSuggestions('', true)
    const dangling = items.find(i => i.displayText === 'dangling')
    expect(dangling).toBeDefined()
    expect(dangling!.description).toBe('(broken)')
  })
})

describe('generateFileSuggestions edge branches', () => {
  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-'))
    clearFileSuggestionCaches()
  })

  afterEach(() => {
    rmSync(tempCwd, { recursive: true, force: true })
    tempCwd = ''
  })

  test('empty query returns nothing when showOnEmpty is disabled', async () => {
    writeFileSync(join(tempCwd, 'visible.txt'), '')

    await expect(generateFileSuggestions('', false)).resolves.toEqual([])
    expect(harness.fileIndexSearchQueries).toEqual([])
    expect(harness.ripGrep).not.toHaveBeenCalled()
  })

  test('custom command suggestions are query-aware and capped at max suggestions', async () => {
    harness.settings = { fileSuggestion: { type: 'command' } }
    harness.commandResults = Array.from(
      { length: 20 },
      (_, index) => `result-${index}.ts`,
    )

    const items = await generateFileSuggestions('src')

    expect(harness.commandInputs).toEqual([{ base: true, query: 'src' }])
    expect(items).toHaveLength(15)
    expect(items[0]).toMatchObject({
      displayText: 'result-0.ts',
      id: 'file-result-0.ts',
    })
    expect(items[0]?.metadata).toBeUndefined()
    expect(items[1]?.metadata).toBeUndefined()
    expect(items.at(-1)?.displayText).toBe('result-14.ts')
  })

  test('custom command suggestion failures are logged and return no suggestions', async () => {
    const error = new Error('custom command failed')
    harness.settings = { fileSuggestion: { type: 'command' } }
    harness.commandError = error

    await expect(generateFileSuggestions('src')).resolves.toEqual([])
    expect(harness.commandInputs).toEqual([{ base: true, query: 'src' }])
    expect(harness.logError).toHaveBeenCalledWith(error)
  })

  test('non-empty search normalizes current-directory prefixes and backfills hidden matches', async () => {
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')
    writeFileSync(join(tempCwd, '.hideme'), '')
    harness.fileIndexSearchResults = [{ path: '.hideme', score: 42 }]

    const items = await generateFileSuggestions('./.hid')
    const names = items.map(item => item.displayText)

    expect(harness.fileIndexSearchQueries[0]).toEqual({
      limit: 15,
      query: '.hid',
    })
    expect(names.filter(name => name === '.hideme')).toHaveLength(1)
    expect(names).toContain('.hidden-file.txt')
    expect(items.find(item => item.displayText === '.hideme')?.metadata).toEqual(
      { score: 42 },
    )
  })

  test('tilde-prefixed search is expanded before querying the index', async () => {
    await generateFileSuggestions('~/project')

    expect(harness.fileIndexSearchQueries[0]).toEqual({
      limit: 15,
      query: '/home/tester/project',
    })
  })

  test('parent-directory dotted searches do not backfill top-level dotfiles', async () => {
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')

    await expect(generateFileSuggestions('..')).resolves.toEqual([])
    expect(harness.fileIndexSearchQueries[0]).toEqual({
      limit: 15,
      query: '..',
    })
  })

  test('search errors are logged and return no suggestions', async () => {
    const error = new Error('search failed')
    harness.fileIndexSearchError = error

    await expect(generateFileSuggestions('src')).resolves.toEqual([])
    expect(harness.logError).toHaveBeenCalledWith(error)
  })
})
