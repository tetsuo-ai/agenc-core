import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const watcherHandlers = vi.hoisted(
  () => new Map<string, (path: string) => void | Promise<void>>(),
)
const closeWatcher = vi.hoisted(() => vi.fn(async () => undefined))
const watch = vi.hoisted(() =>
  vi.fn(() => ({
    close: closeWatcher,
    on(event: string, handler: (path: string) => void | Promise<void>) {
      watcherHandlers.set(event, handler)
      return this
    },
  })),
)

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('chokidar', () => ({
  default: { watch },
  watch,
}))

import {
  disposeKeybindingWatcher,
  getCachedKeybindingWarnings,
  getKeybindingsPath,
  initializeKeybindingWatcher,
  isKeybindingCustomizationEnabled,
  loadKeybindings,
  loadKeybindingsSync,
  loadKeybindingsSyncWithWarnings,
  resetKeybindingLoaderForTesting,
  subscribeToKeybindingChanges,
} from './loadUserBindings.ts'

const originalConfigDir = process.env.AGENC_CONFIG_DIR
const tempDirs: string[] = []

async function createConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agenc-keybindings-'))
  tempDirs.push(dir)
  process.env.AGENC_CONFIG_DIR = dir
  resetKeybindingLoaderForTesting()
  return dir
}

async function writeKeybindings(content: string): Promise<void> {
  await writeFile(getKeybindingsPath(), content)
}

function findAction(bindings: { action: string | null }[], action: string): boolean {
  return bindings.some(binding => binding.action === action)
}

beforeEach(() => {
  watcherHandlers.clear()
  watch.mockClear()
  closeWatcher.mockClear()
  process.env.AGENC_CONFIG_DIR = originalConfigDir
  resetKeybindingLoaderForTesting()
})

afterEach(async () => {
  disposeKeybindingWatcher()
  resetKeybindingLoaderForTesting()
  if (originalConfigDir === undefined) {
    delete process.env.AGENC_CONFIG_DIR
  } else {
    process.env.AGENC_CONFIG_DIR = originalConfigDir
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('loadUserBindings', () => {
  test('uses the configured keybindings path and falls back to defaults when missing', async () => {
    const dir = await createConfigDir()

    expect(isKeybindingCustomizationEnabled()).toBe(true)
    expect(getKeybindingsPath()).toBe(join(dir, 'keybindings.json'))

    const asyncResult = await loadKeybindings()
    expect(asyncResult.warnings).toEqual([])
    expect(asyncResult.bindings.length).toBeGreaterThan(0)

    const syncBindings = loadKeybindingsSync()
    expect(syncBindings).toHaveLength(asyncResult.bindings.length)
    expect(getCachedKeybindingWarnings()).toEqual([])
  })

  test('reports async parse and shape errors with default bindings', async () => {
    await createConfigDir()

    await writeKeybindings('{}')
    let result = await loadKeybindings()
    expect(result.bindings.length).toBeGreaterThan(0)
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: 'keybindings.json must have a "bindings" array',
        severity: 'error',
        type: 'parse_error',
      }),
    ])

    resetKeybindingLoaderForTesting()
    await writeKeybindings('{"bindings":{}}')
    result = await loadKeybindings()
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: '"bindings" must be an array',
        type: 'parse_error',
      }),
    ])

    resetKeybindingLoaderForTesting()
    await writeKeybindings('{"bindings":[{}]}')
    result = await loadKeybindings()
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: 'keybindings.json contains invalid block structure',
        type: 'parse_error',
      }),
    ])

    resetKeybindingLoaderForTesting()
    await writeKeybindings('{')
    result = await loadKeybindings()
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('Failed to parse keybindings.json:'),
        type: 'parse_error',
      }),
    ])
  })

  test('merges valid user bindings and caches sync loads with warnings', async () => {
    await createConfigDir()
    await writeKeybindings(`{
      "bindings": [
        {
          "context": "Chat",
          "bindings": {
            "ctrl+x": "chat:submit",
            "ctrl+x": "chat:newline"
          }
        }
      ]
    }`)

    const first = loadKeybindingsSyncWithWarnings()
    expect(findAction(first.bindings, 'chat:newline')).toBe(true)
    expect(first.warnings).toEqual([
      expect.objectContaining({
        context: 'Chat',
        key: 'ctrl+x',
        type: 'duplicate',
      }),
    ])
    expect(getCachedKeybindingWarnings()).toBe(first.warnings)

    await writeKeybindings('{}')
    const cached = loadKeybindingsSyncWithWarnings()
    expect(cached.bindings).toBe(first.bindings)
    expect(cached.warnings).toBe(first.warnings)

    resetKeybindingLoaderForTesting()
    const invalid = loadKeybindingsSyncWithWarnings()
    expect(invalid.warnings).toEqual([
      expect.objectContaining({
        message: 'keybindings.json must have a "bindings" array',
        type: 'parse_error',
      }),
    ])
  })

  test('starts, emits, deletes, and disposes the keybinding watcher', async () => {
    await createConfigDir()
    const changes: Awaited<ReturnType<typeof loadKeybindings>>[] = []
    const unsubscribe = subscribeToKeybindingChanges(result => {
      changes.push(result)
    })

    await initializeKeybindingWatcher()

    expect(watch).toHaveBeenCalledWith(
      getKeybindingsPath(),
      expect.objectContaining({
        atomic: true,
        ignoreInitial: true,
        persistent: true,
      }),
    )
    expect(watcherHandlers.has('add')).toBe(true)
    expect(watcherHandlers.has('change')).toBe(true)
    expect(watcherHandlers.has('unlink')).toBe(true)

    await writeKeybindings(`{
      "bindings": [
        {
          "context": "Chat",
          "bindings": {
            "ctrl+y": "chat:newline"
          }
        }
      ]
    }`)
    await watcherHandlers.get('change')?.(getKeybindingsPath())

    expect(changes).toHaveLength(1)
    expect(findAction(changes[0]!.bindings, 'chat:newline')).toBe(true)

    watcherHandlers.get('unlink')?.(getKeybindingsPath())
    expect(changes).toHaveLength(2)
    expect(changes[1]!.warnings).toEqual([])

    unsubscribe()
    disposeKeybindingWatcher()
    expect(closeWatcher).toHaveBeenCalled()
    expect(getCachedKeybindingWarnings()).toEqual([])
  })

  test('does not initialize a watcher when the config directory is unavailable', async () => {
    const dir = await createConfigDir()
    await rm(dir, { recursive: true, force: true })

    await initializeKeybindingWatcher()

    expect(watch).not.toHaveBeenCalled()
  })
})
