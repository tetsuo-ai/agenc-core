import { beforeEach, describe, expect, test, vi } from 'vitest'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const harness = vi.hoisted(() => ({
  appendDeferred: undefined as Deferred | undefined,
  appendFile: vi.fn(),
  cleanup: undefined as undefined | (() => Promise<void>),
  lock: vi.fn(),
  lockRelease: vi.fn(),
  registerCleanup: vi.fn((cleanup: () => Promise<void>) => {
    harness.cleanup = cleanup
  }),
  writeFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  appendFile: harness.appendFile,
  writeFile: harness.writeFile,
}))

vi.mock('../../bootstrap/state.js', () => ({
  getProjectRoot: () => '/workspace/project',
  getSessionId: () => 'session-current',
}))

vi.mock('../../utils/cleanupRegistry.js', () => ({
  registerCleanup: harness.registerCleanup,
}))

vi.mock('../../utils/envUtils.js', () => ({
  getAgenCConfigHomeDir: () => '/tmp/agenc-home',
  isEnvTruthy: () => false,
}))

vi.mock('../../utils/lockfile.js', () => ({
  lock: harness.lock,
}))

vi.mock('../../utils/pasteStore.js', () => ({
  hashPastedText: (content: string) => `hash:${content.length}`,
  retrievePastedText: vi.fn(),
  storePastedText: vi.fn(),
}))

vi.mock('../../utils/slowOperations.js', () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}))

async function loadHistoryModule(): Promise<typeof import('./history.js')> {
  vi.resetModules()
  return import('./history.js')
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < 1000) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  throw lastError
}

beforeEach(() => {
  harness.appendDeferred = deferred()
  harness.appendFile.mockReset()
  harness.appendFile.mockImplementation(() => harness.appendDeferred!.promise)
  harness.cleanup = undefined
  harness.lock.mockReset()
  harness.lockRelease.mockReset()
  harness.lockRelease.mockResolvedValue(undefined)
  harness.lock.mockResolvedValue(harness.lockRelease)
  harness.registerCleanup.mockClear()
  harness.writeFile.mockReset()
  harness.writeFile.mockResolvedValue(undefined)
})

describe('history prompt cleanup coverage', () => {
  test('registered cleanup waits for an in-flight prompt history flush', async () => {
    const history = await loadHistoryModule()

    history.addToHistory('cleanup command')

    await waitFor(() => {
      expect(harness.appendFile).toHaveBeenCalledTimes(1)
    })
    expect(harness.registerCleanup).toHaveBeenCalledTimes(1)
    expect(harness.cleanup).toBeDefined()

    const onCleanupSettled = vi.fn()
    const cleanupPromise = harness.cleanup!().then(onCleanupSettled)

    await Promise.resolve()
    expect(onCleanupSettled).not.toHaveBeenCalled()

    harness.appendDeferred!.resolve()
    await cleanupPromise

    expect(harness.writeFile).toHaveBeenCalledWith(
      '/tmp/agenc-home/history.jsonl',
      '',
      { encoding: 'utf8', mode: 0o600, flag: 'a' },
    )
    expect(harness.lock).toHaveBeenCalledWith('/tmp/agenc-home/history.jsonl', {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })
    expect(harness.lockRelease).toHaveBeenCalledTimes(1)

    const [historyPath, payload, options] = harness.appendFile.mock.calls[0]!
    expect(historyPath).toBe('/tmp/agenc-home/history.jsonl')
    expect(options).toEqual({ mode: 0o600 })
    expect(JSON.parse(String(payload).trim())).toMatchObject({
      display: 'cleanup command',
      pastedContents: {},
      project: '/workspace/project',
      sessionId: 'session-current',
    })
    expect(onCleanupSettled).toHaveBeenCalledTimes(1)
  })
})
