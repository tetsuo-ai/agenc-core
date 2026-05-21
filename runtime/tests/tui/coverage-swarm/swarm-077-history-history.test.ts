import { beforeEach, describe, expect, test, vi } from 'vitest'

type Deferred<T = void> = {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

type LogLineInput = {
  display: string
  pastedContents?: Record<string, unknown>
  project?: string
  sessionId?: string
  timestamp?: number
}

const harness = vi.hoisted(() => ({
  appendFile: vi.fn(async () => {}),
  configHome: '/tmp/agenc-row-077',
  debug: vi.fn(),
  lock: vi.fn(),
  lockRelease: vi.fn(async () => {}),
  projectRoot: '/workspace/project',
  readLines: [] as string[],
  registerCleanup: vi.fn(),
  retrievePastedText: vi.fn(async () => null as string | null),
  sessionId: 'session-current',
  skipHistory: false,
  sleep: vi.fn(async () => {}),
  storePastedText: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}))

vi.mock('fs/promises', () => ({
  appendFile: harness.appendFile,
  writeFile: harness.writeFile,
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  getProjectRoot: () => harness.projectRoot,
  getSessionId: () => harness.sessionId,
}))

vi.mock('../../../src/utils/cleanupRegistry.js', () => ({
  registerCleanup: harness.registerCleanup,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: harness.debug,
}))

vi.mock('../../../src/utils/envUtils.js', () => ({
  getAgenCConfigHomeDir: () => harness.configHome,
  isEnvTruthy: () => harness.skipHistory,
}))

vi.mock('../../../src/utils/errors.js', () => ({
  getErrnoCode: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: string }).code
      : undefined,
}))

vi.mock('../../../src/utils/fsOperations.js', () => ({
  readLinesReverse: async function* () {
    for (const line of harness.readLines) {
      yield line
    }
  },
}))

vi.mock('../../../src/utils/lockfile.js', () => ({
  lock: harness.lock,
}))

vi.mock('../../../src/utils/pasteStore.js', () => ({
  hashPastedText: (content: string) => `hash:${content.length}`,
  retrievePastedText: harness.retrievePastedText,
  storePastedText: harness.storePastedText,
}))

vi.mock('../../../src/utils/sleep.js', () => ({
  sleep: harness.sleep,
}))

vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}))

async function loadHistory(): Promise<
  typeof import('../../../src/tui/history/history.js')
> {
  vi.resetModules()
  return import('../../../src/tui/history/history.js')
}

async function collect<T>(iterable: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

function logLine(input: LogLineInput): string {
  return JSON.stringify({
    pastedContents: {},
    project: harness.projectRoot,
    sessionId: harness.sessionId,
    timestamp: 1,
    ...input,
  })
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
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  throw lastError
}

beforeEach(() => {
  harness.appendFile.mockReset()
  harness.appendFile.mockResolvedValue(undefined)
  harness.configHome = '/tmp/agenc-row-077'
  harness.debug.mockClear()
  harness.lock.mockReset()
  harness.lockRelease.mockReset()
  harness.lockRelease.mockResolvedValue(undefined)
  harness.lock.mockResolvedValue(harness.lockRelease)
  harness.projectRoot = '/workspace/project'
  harness.readLines = []
  harness.registerCleanup.mockClear()
  harness.retrievePastedText.mockClear()
  harness.retrievePastedText.mockResolvedValue(null)
  harness.sessionId = 'session-current'
  harness.skipHistory = false
  harness.sleep.mockReset()
  harness.sleep.mockResolvedValue(undefined)
  harness.storePastedText.mockClear()
  harness.writeFile.mockReset()
  harness.writeFile.mockResolvedValue(undefined)
})

describe('coverage swarm row 077 history module', () => {
  test('reads pending entries newest first and removes the most recent pending entry', async () => {
    const writeStarted = deferred<void>()
    harness.writeFile.mockImplementationOnce(() => writeStarted.promise)
    const history = await loadHistory()

    history.addToHistory('first pending')
    history.addToHistory('second pending')

    await Promise.resolve()
    await expect(collect(history.getHistory())).resolves.toMatchObject([
      { display: 'second pending', pastedContents: {} },
      { display: 'first pending', pastedContents: {} },
    ])

    history.removeLastFromHistory()

    await expect(collect(history.getHistory())).resolves.toMatchObject([
      { display: 'first pending', pastedContents: {} },
    ])

    writeStarted.resolve()
    await waitFor(() => {
      expect(harness.appendFile).toHaveBeenCalledTimes(1)
    })
  })

  test('caps timestamped project history at one hundred unique displays', async () => {
    harness.readLines = Array.from({ length: 101 }, (_, index) =>
      logLine({
        display: `prompt ${index}`,
        timestamp: 200 - index,
      }),
    )
    const history = await loadHistory()

    const timestamped = await collect(history.getTimestampedHistory())

    expect(timestamped).toHaveLength(100)
    expect(timestamped[0]).toMatchObject({
      display: 'prompt 0',
      timestamp: 200,
    })
    expect(timestamped[99]).toMatchObject({
      display: 'prompt 99',
      timestamp: 101,
    })
  })

  test('drops unresolved stored paste references while preserving empty history entries', async () => {
    harness.readLines = [
      logLine({
        display: 'missing paste content',
        pastedContents: {
          1: {
            contentHash: 'missing-hash',
            id: 1,
            type: 'text',
          },
          2: {
            id: 2,
            type: 'text',
          },
        },
      }),
    ]
    const history = await loadHistory()

    await expect(collect(history.makeHistoryReader())).resolves.toEqual([
      {
        display: 'missing paste content',
        pastedContents: {},
      },
    ])
    expect(harness.retrievePastedText).toHaveBeenCalledWith('missing-hash')
  })

  test('logs write failures and stops retrying after the retry budget', async () => {
    harness.writeFile.mockRejectedValue(new Error('disk unavailable'))
    const history = await loadHistory()

    history.addToHistory('retry prompt')

    await waitFor(() => {
      expect(harness.writeFile).toHaveBeenCalledTimes(6)
      expect(harness.sleep).toHaveBeenCalledTimes(6)
    })

    expect(harness.appendFile).not.toHaveBeenCalled()
    expect(harness.lock).not.toHaveBeenCalled()
    expect(harness.debug).toHaveBeenCalledTimes(6)
    expect(harness.debug).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write prompt history:'),
    )

    history.clearPendingHistoryEntries()
  })
})
