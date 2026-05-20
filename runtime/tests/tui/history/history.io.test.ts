import { beforeEach, describe, expect, test, vi } from 'vitest'

type LogEntryLike = {
  display: string
  pastedContents?: Record<string, unknown>
  project: string
  sessionId?: string
  timestamp: number
}

const harness = vi.hoisted(() => ({
  appendFile: vi.fn(),
  cleanup: undefined as undefined | (() => Promise<void>),
  configHome: '/tmp/agenc-home',
  debug: vi.fn(),
  hashPastedText: vi.fn((content: string) => `hash:${content.length}`),
  lines: [] as string[],
  lock: vi.fn(),
  lockRelease: vi.fn(),
  projectRoot: '/workspace/project',
  readError: null as null | NodeJS.ErrnoException,
  readPath: undefined as undefined | string,
  registerCleanup: vi.fn((cleanup: () => Promise<void>) => {
    harness.cleanup = cleanup
  }),
  retrievePastedText: vi.fn(),
  sessionId: 'session-current',
  skipHistory: false,
  sleep: vi.fn(async () => {}),
  storePastedText: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  appendFile: harness.appendFile,
  writeFile: harness.writeFile,
}))

vi.mock('../../bootstrap/state.js', () => ({
  getProjectRoot: () => harness.projectRoot,
  getSessionId: () => harness.sessionId,
}))

vi.mock('../../utils/cleanupRegistry.js', () => ({
  registerCleanup: harness.registerCleanup,
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

vi.mock('../../utils/envUtils.js', () => ({
  getAgenCConfigHomeDir: () => harness.configHome,
  isEnvTruthy: () => harness.skipHistory,
}))

vi.mock('../../utils/errors.js', () => ({
  getErrnoCode: (error: NodeJS.ErrnoException) => error.code,
}))

vi.mock('../../utils/fsOperations.js', () => ({
  readLinesReverse: async function* (path: string) {
    harness.readPath = path
    if (harness.readError) throw harness.readError
    for (const line of harness.lines) {
      yield line
    }
  },
}))

vi.mock('../../utils/lockfile.js', () => ({
  lock: harness.lock,
}))

vi.mock('../../utils/pasteStore.js', () => ({
  hashPastedText: harness.hashPastedText,
  retrievePastedText: harness.retrievePastedText,
  storePastedText: harness.storePastedText,
}))

vi.mock('../../utils/sleep.js', () => ({
  sleep: harness.sleep,
}))

vi.mock('../../utils/slowOperations.js', () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}))

function entry(overrides: Partial<LogEntryLike>): LogEntryLike {
  return {
    display: 'prompt',
    pastedContents: {},
    project: harness.projectRoot,
    sessionId: harness.sessionId,
    timestamp: 1,
    ...overrides,
  }
}

async function loadHistoryModule(): Promise<typeof import('./history.js')> {
  vi.resetModules()
  return import('./history.js')
}

async function waitFor(
  assertion: () => void,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
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
  harness.appendFile.mockReset()
  harness.appendFile.mockResolvedValue(undefined)
  harness.cleanup = undefined
  harness.configHome = '/tmp/agenc-home'
  harness.debug.mockReset()
  harness.hashPastedText.mockClear()
  harness.lines = []
  harness.lock.mockReset()
  harness.lockRelease.mockReset()
  harness.lockRelease.mockResolvedValue(undefined)
  harness.lock.mockResolvedValue(harness.lockRelease)
  harness.projectRoot = '/workspace/project'
  harness.readError = null
  harness.readPath = undefined
  harness.registerCleanup.mockClear()
  harness.retrievePastedText.mockReset()
  harness.retrievePastedText.mockResolvedValue(null)
  harness.sessionId = 'session-current'
  harness.skipHistory = false
  harness.sleep.mockClear()
  harness.storePastedText.mockReset()
  harness.storePastedText.mockResolvedValue(undefined)
  harness.writeFile.mockReset()
  harness.writeFile.mockResolvedValue(undefined)
})

describe('history io', () => {
  test('reads current-session history before other sessions and resolves stored paste content', async () => {
    harness.retrievePastedText.mockResolvedValue('retrieved large paste')
    harness.lines = [
      JSON.stringify(
        entry({
          display: 'other newest',
          sessionId: 'other-session',
          timestamp: 3,
        }),
      ),
      JSON.stringify(
        entry({
          display: 'current older',
          pastedContents: {
            1: {
              id: 1,
              type: 'text',
              content: 'inline paste',
              filename: 'inline.txt',
            },
            2: {
              id: 2,
              type: 'text',
              contentHash: 'large-hash',
              mediaType: 'text/plain',
            },
            3: {
              id: 3,
              type: 'image',
              content: 'base64-image',
              mediaType: 'image/png',
            },
          },
          timestamp: 2,
        }),
      ),
      JSON.stringify(
        entry({
          display: 'wrong project',
          project: '/workspace/other',
          timestamp: 1,
        }),
      ),
    ]
    const history = await loadHistoryModule()

    const results = await Array.fromAsync(history.getHistory())

    expect(harness.readPath).toBe('/tmp/agenc-home/history.jsonl')
    expect(results.map(result => result.display)).toEqual([
      'current older',
      'other newest',
    ])
    expect(results[0]!.pastedContents).toMatchObject({
      1: {
        id: 1,
        type: 'text',
        content: 'inline paste',
        filename: 'inline.txt',
      },
      2: {
        id: 2,
        type: 'text',
        content: 'retrieved large paste',
        mediaType: 'text/plain',
      },
      3: {
        id: 3,
        type: 'image',
        content: 'base64-image',
        mediaType: 'image/png',
      },
    })
    expect(harness.retrievePastedText).toHaveBeenCalledWith('large-hash')
  })

  test('deduplicates timestamped project history and skips malformed lines', async () => {
    harness.retrievePastedText.mockResolvedValue('lazy paste')
    harness.lines = [
      'not json',
      JSON.stringify(entry({ display: 'same', timestamp: 4 })),
      JSON.stringify(entry({ display: 'wrong', project: '/elsewhere', timestamp: 3 })),
      JSON.stringify(entry({ display: 'same', timestamp: 2 })),
      JSON.stringify(
        entry({
          display: 'unique',
          pastedContents: {
            7: { id: 7, type: 'text', contentHash: 'lazy-hash' },
          },
          timestamp: 1,
        }),
      ),
    ]
    const history = await loadHistoryModule()

    const timestamped = await Array.fromAsync(history.getTimestampedHistory())

    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse history line:'),
    )
    expect(timestamped.map(item => [item.display, item.timestamp])).toEqual([
      ['same', 4],
      ['unique', 1],
    ])
    await expect(timestamped[1]!.resolve()).resolves.toMatchObject({
      display: 'unique',
      pastedContents: {
        7: { content: 'lazy paste' },
      },
    })
  })

  test('treats missing history files as empty and rethrows other read failures', async () => {
    const history = await loadHistoryModule()
    harness.readError = Object.assign(new Error('missing'), { code: 'ENOENT' })
    await expect(Array.fromAsync(history.makeHistoryReader())).resolves.toEqual(
      [],
    )

    harness.readError = Object.assign(new Error('denied'), { code: 'EACCES' })
    await expect(Array.fromAsync(history.makeHistoryReader())).rejects.toThrow(
      'denied',
    )
  })

  test('writes history entries with inline and externalized text paste content', async () => {
    const history = await loadHistoryModule()
    const longPaste = 'x'.repeat(1025)

    history.addToHistory({
      display: 'run command',
      pastedContents: {
        1: {
          id: 1,
          type: 'text',
          content: 'short paste',
          mediaType: 'text/plain',
          filename: 'short.txt',
        },
        2: {
          id: 2,
          type: 'text',
          content: longPaste,
          mediaType: 'text/plain',
        },
        3: {
          id: 3,
          type: 'image',
          content: 'base64-image',
          mediaType: 'image/png',
        },
      },
    })

    await waitFor(() => {
      expect(harness.appendFile).toHaveBeenCalledTimes(1)
    })

    expect(harness.registerCleanup).toHaveBeenCalledTimes(1)
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
    expect(harness.storePastedText).toHaveBeenCalledWith(
      'hash:1025',
      longPaste,
    )

    const payload = String(harness.appendFile.mock.calls[0]![1])
    const written = JSON.parse(payload.trim())
    expect(written).toMatchObject({
      display: 'run command',
      project: '/workspace/project',
      sessionId: 'session-current',
    })
    expect(written.pastedContents).toEqual({
      1: {
        id: 1,
        type: 'text',
        content: 'short paste',
        mediaType: 'text/plain',
        filename: 'short.txt',
      },
      2: {
        id: 2,
        type: 'text',
        contentHash: 'hash:1025',
        mediaType: 'text/plain',
      },
    })
  })

  test('skips disabled prompt history and removes flushed history from readers', async () => {
    const history = await loadHistoryModule()

    harness.skipHistory = true
    history.addToHistory('skipped command')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.registerCleanup).not.toHaveBeenCalled()
    expect(harness.appendFile).not.toHaveBeenCalled()

    harness.skipHistory = false
    history.addToHistory('temporary command')
    await waitFor(() => {
      expect(harness.appendFile).toHaveBeenCalledTimes(1)
    })
    const flushedLine = String(harness.appendFile.mock.calls[0]![1]).trim()

    history.removeLastFromHistory()
    harness.lines = [flushedLine]

    await expect(Array.fromAsync(history.getHistory())).resolves.toEqual([])

    history.clearPendingHistoryEntries()
    harness.lines = [flushedLine]
    await expect(Array.fromAsync(history.getHistory())).resolves.toEqual([
      { display: 'temporary command', pastedContents: {} },
    ])
  })
})
