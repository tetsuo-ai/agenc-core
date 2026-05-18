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

let tempCwd = ''

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => tempCwd,
  pwd: () => tempCwd,
  runWithCwdOverride: <T,>(_cwd: string, fn: () => T) => fn(),
}))

// Avoid hitting the real analytics path during tests.
vi.mock('../../services/analytics/index', () => ({
  logEvent: () => {},
}))

// Stable settings: file suggestions use the in-process index path, not the
// configurable hook command.
vi.mock('../../utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
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
  createBaseHookInput: () => ({}),
  executeFileSuggestionCommand: async () => [],
}))

vi.mock('../../utils/markdownConfigLoader.js', () => ({
  AGENC_CONFIG_DIRECTORIES: [],
  loadMarkdownFilesForSubdir: async () => [],
}))

// FileIndex is a Rust-backed native module the empty-query path does not need
// directly, but it sits in the same module graph. Provide a no-op stand-in so
// the import resolves without a build step.
vi.mock('../ink/native-ts/file-index/index', () => ({
  CHUNK_MS: 4,
  FileIndex: class {
    loadFromFileListAsync() {
      return { done: Promise.resolve() }
    }
    search() {
      return []
    }
    get readyCount() {
      return 0
    }
  },
  yieldToEventLoop: async () => {},
}))

import {
  annotateBrokenSymlinks,
  clearFileSuggestionCaches,
  generateFileSuggestions,
  getHiddenTopLevelMatches,
} from './fileSuggestions.js'

describe('fileSuggestions hidden-file visibility', () => {
  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'agenc-file-suggestions-'))
    clearFileSuggestionCaches()
  })

  afterEach(() => {
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

  test('dotted prefix query excludes hidden paths ignored by .agencignore', async () => {
    writeFileSync(join(tempCwd, '.agencignore'), '.hidden-file.txt\n')
    writeFileSync(join(tempCwd, '.hidden-file.txt'), '')
    writeFileSync(join(tempCwd, '.hideme'), '')

    const matches = await getHiddenTopLevelMatches('.hid')

    expect(matches).toContain('.hideme')
    expect(matches).not.toContain('.hidden-file.txt')
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
