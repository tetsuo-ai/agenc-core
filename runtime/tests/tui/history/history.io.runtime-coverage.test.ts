import { beforeEach, describe, expect, test, vi } from 'vitest'

const historyFixture = vi.hoisted(() => ({
  appendFile: vi.fn(async () => {}),
  configHome: '/tmp/agenc-test',
  lock: vi.fn(async () => historyFixture.release),
  logForDebugging: vi.fn(),
  projectRoot: '/repo/project',
  readLines: [] as string[],
  registerCleanup: vi.fn(),
  release: vi.fn(async () => {}),
  retrievePastedText: vi.fn(async (hash: string) =>
    hash === 'hash-large' ? 'retrieved large text' : null,
  ),
  sessionId: 'session-current',
  skipHistory: false,
  sleep: vi.fn(async () => {}),
  storePastedText: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}))

vi.mock('fs/promises', () => ({
  appendFile: historyFixture.appendFile,
  writeFile: historyFixture.writeFile,
}))

vi.mock('../../bootstrap/state.js', () => ({
  getProjectRoot: () => historyFixture.projectRoot,
  getSessionId: () => historyFixture.sessionId,
}))

vi.mock('../../utils/cleanupRegistry.js', () => ({
  registerCleanup: historyFixture.registerCleanup,
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: historyFixture.logForDebugging,
}))

vi.mock('../../utils/envUtils.js', () => ({
  getAgenCConfigHomeDir: () => historyFixture.configHome,
  isEnvTruthy: () => historyFixture.skipHistory,
}))

vi.mock('../../utils/errors.js', () => ({
  getErrnoCode: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: string }).code
      : undefined,
}))

vi.mock('../../utils/fsOperations.js', () => ({
  readLinesReverse: async function* () {
    for (const line of historyFixture.readLines) {
      yield line
    }
  },
}))

vi.mock('../../utils/lockfile.js', () => ({
  lock: historyFixture.lock,
}))

vi.mock('../../utils/pasteStore.js', () => ({
  hashPastedText: (text: string) =>
    text.length > 1024 ? 'hash-large' : `hash-${text.length}`,
  retrievePastedText: historyFixture.retrievePastedText,
  storePastedText: historyFixture.storePastedText,
}))

vi.mock('../../utils/sleep.js', () => ({
  sleep: historyFixture.sleep,
}))

vi.mock('../../utils/slowOperations.js', () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}))

type HistoryModule = typeof import('./history.js')

async function loadHistory(): Promise<HistoryModule> {
  vi.resetModules()
  return import('./history.js')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for history side effect')
}

async function collect<T>(iterable: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) {
    result.push(item)
  }
  return result
}

function logLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    display: 'prompt',
    pastedContents: {},
    project: historyFixture.projectRoot,
    sessionId: historyFixture.sessionId,
    timestamp: 1,
    ...overrides,
  })
}

beforeEach(() => {
  historyFixture.appendFile.mockClear()
  historyFixture.lock.mockClear()
  historyFixture.logForDebugging.mockClear()
  historyFixture.projectRoot = '/repo/project'
  historyFixture.readLines = []
  historyFixture.registerCleanup.mockClear()
  historyFixture.release.mockClear()
  historyFixture.retrievePastedText.mockClear()
  historyFixture.sessionId = 'session-current'
  historyFixture.skipHistory = false
  historyFixture.sleep.mockClear()
  historyFixture.storePastedText.mockClear()
  historyFixture.writeFile.mockClear()
})

describe('history persistence', () => {
  test('skips writing history when prompt history is disabled', async () => {
    historyFixture.skipHistory = true
    const history = await loadHistory()

    history.addToHistory('ignored prompt')
    await Promise.resolve()

    expect(historyFixture.registerCleanup).not.toHaveBeenCalled()
    expect(historyFixture.writeFile).not.toHaveBeenCalled()
    expect(historyFixture.appendFile).not.toHaveBeenCalled()
  })

  test('writes inline pasted text, hashes large pasted text, drops images, and registers cleanup once', async () => {
    const history = await loadHistory()
    const largeText = 'x'.repeat(1_025)

    history.addToHistory({
      display: 'run command',
      pastedContents: {
        1: {
          content: 'small paste',
          id: 1,
          mediaType: 'text/plain',
          type: 'text',
        },
        2: {
          content: '<binary>',
          filename: 'image.png',
          id: 2,
          mediaType: 'image/png',
          type: 'image',
        },
        3: {
          content: largeText,
          id: 3,
          mediaType: 'text/plain',
          type: 'text',
        },
      },
    })

    await waitFor(() => historyFixture.appendFile.mock.calls.length === 1)

    expect(historyFixture.registerCleanup).toHaveBeenCalledTimes(1)
    expect(historyFixture.writeFile).toHaveBeenCalledWith(
      '/tmp/agenc-test/history.jsonl',
      '',
      expect.objectContaining({ encoding: 'utf8', flag: 'a', mode: 0o600 }),
    )
    expect(historyFixture.lock).toHaveBeenCalledWith(
      '/tmp/agenc-test/history.jsonl',
      expect.objectContaining({ stale: 10000 }),
    )
    expect(historyFixture.release).toHaveBeenCalledTimes(1)
    expect(historyFixture.storePastedText).toHaveBeenCalledWith(
      'hash-large',
      largeText,
    )

    const appended = historyFixture.appendFile.mock.calls[0]?.[1] as string
    const entry = JSON.parse(appended.trim())
    expect(entry).toMatchObject({
      display: 'run command',
      project: '/repo/project',
      sessionId: 'session-current',
    })
    expect(entry.pastedContents).toEqual({
      1: {
        content: 'small paste',
        id: 1,
        mediaType: 'text/plain',
        type: 'text',
      },
      3: {
        contentHash: 'hash-large',
        id: 3,
        mediaType: 'text/plain',
        type: 'text',
      },
    })
  })

  test('reads current-session history before other sessions and resolves stored paste hashes', async () => {
    historyFixture.readLines = [
      logLine({
        display: 'other session',
        pastedContents: {
          1: { content: 'inline text', id: 1, type: 'text' },
        },
        sessionId: 'session-other',
        timestamp: 3,
      }),
      'not json',
      logLine({
        display: 'current session',
        pastedContents: {
          2: { contentHash: 'hash-large', id: 2, type: 'text' },
          3: { contentHash: 'missing-hash', id: 3, type: 'text' },
        },
        sessionId: 'session-current',
        timestamp: 2,
      }),
      logLine({
        display: 'wrong project',
        project: '/other/project',
        sessionId: 'session-current',
        timestamp: 1,
      }),
    ]
    const history = await loadHistory()

    const entries = await collect(history.getHistory())

    expect(entries.map(entry => entry.display)).toEqual([
      'current session',
      'other session',
    ])
    expect(entries[0]?.pastedContents).toEqual({
      2: {
        content: 'retrieved large text',
        id: 2,
        type: 'text',
      },
    })
    expect(entries[1]?.pastedContents[1]?.content).toBe('inline text')
    expect(historyFixture.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse history line:'),
    )
  })

  test('dedupes timestamped history by display and resolves entries lazily', async () => {
    historyFixture.readLines = [
      logLine({
        display: 'repeat',
        pastedContents: {
          1: { content: 'first', id: 1, type: 'text' },
        },
        timestamp: 20,
      }),
      logLine({
        display: 'repeat',
        pastedContents: {
          1: { content: 'duplicate', id: 1, type: 'text' },
        },
        timestamp: 10,
      }),
      logLine({
        display: 'unique',
        pastedContents: {},
        timestamp: 5,
      }),
      JSON.stringify({ display: 'malformed shape', timestamp: 1 }),
    ]
    const history = await loadHistory()

    const entries = await collect(history.getTimestampedHistory())

    expect(entries.map(entry => [entry.display, entry.timestamp])).toEqual([
      ['repeat', 20],
      ['unique', 5],
    ])
    await expect(entries[0]?.resolve()).resolves.toEqual({
      display: 'repeat',
      pastedContents: {
        1: {
          content: 'first',
          id: 1,
          type: 'text',
        },
      },
    })
  })

  test('removes the most recent flushed history entry from subsequent reads', async () => {
    const history = await loadHistory()

    history.addToHistory('remove me')
    await waitFor(() => historyFixture.appendFile.mock.calls.length === 1)
    const flushed = JSON.parse(
      (historyFixture.appendFile.mock.calls[0]?.[1] as string).trim(),
    )

    history.removeLastFromHistory()
    historyFixture.readLines = [
      JSON.stringify(flushed),
      logLine({
        display: 'keep me',
        sessionId: 'session-current',
        timestamp: flushed.timestamp - 1,
      }),
    ]

    const entries = await collect(history.getHistory())

    expect(entries.map(entry => entry.display)).toEqual(['keep me'])
  })
})
