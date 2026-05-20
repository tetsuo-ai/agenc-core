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

vi.mock('chokidar', () => ({
  default: { watch: harness.watch },
  watch: harness.watch,
}))

vi.mock('../../utils/cleanupRegistry.js', () => ({
  registerCleanup: harness.registerCleanup,
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

import {
  disposeKeybindingWatcher,
  getKeybindingsPath,
  initializeKeybindingWatcher,
  resetKeybindingLoaderForTesting,
} from './loadUserBindings.ts'

const originalConfigDir = process.env.AGENC_CONFIG_DIR
const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agenc-keybindings-wave137-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  harness.cleanup = undefined
  harness.closeWatcher.mockClear()
  harness.debug.mockClear()
  harness.handlers.clear()
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

describe('loadUserBindings watcher lifecycle', () => {
  test('handles duplicate initialization, registered cleanup, reset, and non-directory config parents', async () => {
    const dir = await createTempDir()
    process.env.AGENC_CONFIG_DIR = dir

    await initializeKeybindingWatcher()

    expect(harness.watch).toHaveBeenCalledTimes(1)
    expect(harness.watch).toHaveBeenCalledWith(
      getKeybindingsPath(),
      expect.objectContaining({
        awaitWriteFinish: {
          pollInterval: 200,
          stabilityThreshold: 500,
        },
        ignoreInitial: true,
        ignorePermissionErrors: true,
      }),
    )
    expect(harness.handlers.has('add')).toBe(true)
    expect(harness.handlers.has('change')).toBe(true)
    expect(harness.handlers.has('unlink')).toBe(true)
    expect(harness.registerCleanup).toHaveBeenCalledTimes(1)

    await initializeKeybindingWatcher()
    expect(harness.watch).toHaveBeenCalledTimes(1)

    resetKeybindingLoaderForTesting()
    expect(harness.closeWatcher).toHaveBeenCalledTimes(1)

    await initializeKeybindingWatcher()
    expect(harness.watch).toHaveBeenCalledTimes(2)
    expect(harness.registerCleanup).toHaveBeenCalledTimes(2)

    await harness.cleanup?.()
    expect(harness.closeWatcher).toHaveBeenCalledTimes(2)

    await initializeKeybindingWatcher()
    expect(harness.watch).toHaveBeenCalledTimes(2)

    resetKeybindingLoaderForTesting()
    const configParentFile = join(dir, 'config-parent-file')
    await writeFile(configParentFile, '')
    process.env.AGENC_CONFIG_DIR = configParentFile

    await initializeKeybindingWatcher()

    expect(harness.watch).toHaveBeenCalledTimes(2)
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('is not a directory'),
    )
  })
})
