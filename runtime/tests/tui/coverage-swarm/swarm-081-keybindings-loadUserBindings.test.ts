import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const state = {
    cleanup: undefined as undefined | (() => Promise<void>),
    closeWatcher: vi.fn(async () => undefined),
    debug: vi.fn(),
    handlers: new Map<string, (path: string) => void | Promise<void>>(),
    readFile: vi.fn(),
    registerCleanup: undefined as unknown as ReturnType<typeof vi.fn>,
    watch: undefined as unknown as ReturnType<typeof vi.fn>,
  }

  state.registerCleanup = vi.fn((cleanup: () => Promise<void>) => {
    state.cleanup = cleanup
    return () => {
      if (state.cleanup === cleanup) {
        state.cleanup = undefined
      }
    }
  })

  state.watch = vi.fn(() => ({
    close: state.closeWatcher,
    on(event: string, handler: (path: string) => void | Promise<void>) {
      state.handlers.set(event, handler)
      return this
    },
  }))

  return state
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>(
    'fs/promises',
  )

  harness.readFile.mockImplementation((...args: unknown[]) =>
    actual.readFile(...(args as Parameters<typeof actual.readFile>)),
  )

  return {
    ...actual,
    readFile: harness.readFile,
  }
})

vi.mock('chokidar', () => ({
  default: { watch: harness.watch },
  watch: harness.watch,
}))

vi.mock('../../../src/utils/cleanupRegistry.js', () => ({
  registerCleanup: harness.registerCleanup,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

import {
  disposeKeybindingWatcher,
  getCachedKeybindingWarnings,
  getKeybindingsPath,
  initializeKeybindingWatcher,
  loadKeybindings,
  loadKeybindingsSyncWithWarnings,
  resetKeybindingLoaderForTesting,
  subscribeToKeybindingChanges,
} from '../../../src/tui/keybindings/loadUserBindings.ts'

const originalConfigDir = process.env.AGENC_CONFIG_DIR
const tempDirs: string[] = []

async function createConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agenc-keybindings-row081-'))
  tempDirs.push(dir)
  process.env.AGENC_CONFIG_DIR = dir
  resetKeybindingLoaderForTesting()
  return dir
}

async function writeKeybindings(content: string): Promise<void> {
  await writeFile(getKeybindingsPath(), content)
}

beforeEach(() => {
  harness.cleanup = undefined
  harness.closeWatcher.mockClear()
  harness.debug.mockClear()
  harness.handlers.clear()
  harness.readFile.mockClear()
  harness.registerCleanup.mockClear()
  harness.watch.mockClear()
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
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })),
  )
})

describe('loadUserBindings coverage swarm row 081', () => {
  test('reports sync shape errors for non-array and malformed block variants', async () => {
    await createConfigDir()

    await writeKeybindings('{"bindings":{}}')
    let result = loadKeybindingsSyncWithWarnings()

    expect(result.bindings.length).toBeGreaterThan(0)
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: '"bindings" must be an array',
        severity: 'error',
        suggestion: 'Set "bindings" to an array of keybinding blocks',
        type: 'parse_error',
      }),
    ])
    expect(getCachedKeybindingWarnings()).toBe(result.warnings)

    resetKeybindingLoaderForTesting()
    await writeKeybindings('{"bindings":[{"context":"Chat","bindings":null}]}')
    result = loadKeybindingsSyncWithWarnings()

    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: 'keybindings.json contains invalid block structure',
        suggestion: 'Each block must have "context" (string) and "bindings" (object)',
        type: 'parse_error',
      }),
    ])
    expect(getCachedKeybindingWarnings()).toBe(result.warnings)
  })

  test('formats non-Error async read failures as parse warnings', async () => {
    await createConfigDir()
    harness.readFile.mockRejectedValueOnce('permission denied as string')

    const result = await loadKeybindings()

    expect(result.bindings.length).toBeGreaterThan(0)
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message:
          'Failed to parse keybindings.json: permission denied as string',
        severity: 'error',
        type: 'parse_error',
      }),
    ])
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('permission denied as string'),
    )
  })

  test('does not start a watcher after disposal before initialization', async () => {
    await createConfigDir()
    disposeKeybindingWatcher()

    await initializeKeybindingWatcher()

    expect(harness.watch).not.toHaveBeenCalled()
    expect(harness.registerCleanup).not.toHaveBeenCalled()
  })

  test('logs reload failures from keybinding change subscribers', async () => {
    await createConfigDir()
    await initializeKeybindingWatcher()
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

    subscribeToKeybindingChanges(() => {
      throw new Error('subscriber failed')
    })

    await expect(
      harness.handlers.get('add')?.(getKeybindingsPath()),
    ).resolves.toBeUndefined()

    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('[keybindings] Error reloading: subscriber failed'),
    )
  })
})
