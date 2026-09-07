import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as logging from '../../src/utils/log.js'

vi.mock('../../src/utils/model/providers.js', () => ({
  getSelectedProviderName: () => 'grok',
}))
vi.mock('../../src/utils/privacyLevel.js', () => ({
  isEssentialTrafficOnly: () => false,
}))

beforeEach(() => {
  logging._resetErrorLogForTesting()
  vi.stubEnv('DISABLE_ERROR_REPORTING', '')
})
afterEach(() => {
  logging._resetErrorLogForTesting()
  vi.unstubAllEnvs()
})

function makeSink() {
  return {
    logError: vi.fn(),
    logMCPError: vi.fn(),
    logMCPDebug: vi.fn(),
    getErrorsPath: () => '/errors',
    getMCPLogsPath: () => '/mcp',
  }
}

describe('startup error log queue', () => {
  it.each(['error', 'mcpError', 'mcpDebug'] as const)('evicts the oldest %s events at the startup cap', (type) => {
    for (let i = 0; i < 107; i++) {
      if (type === 'error') logging.logError(new Error(`event-${i}`))
      else if (type === 'mcpError') logging.logMCPError('server', `event-${i}`)
      else logging.logMCPDebug('server', `event-${i}`)
    }
    const sink = makeSink()
    logging.attachErrorLogSink(sink)
    const calls = type === 'error' ? sink.logError.mock.calls
      : type === 'mcpError' ? sink.logMCPError.mock.calls
      : sink.logMCPDebug.mock.calls
    expect(calls).toHaveLength(100)
    expect(type === 'error' ? calls[0]?.[0].message : calls[0]?.[1]).toBe('event-7')
    expect(type === 'error' ? calls[99]?.[0].message : calls[99]?.[1]).toBe('event-106')
  })

  it('keeps error capacity available when debug events overflow', () => {
    logging.logError(new Error('retained error'))
    for (let i = 0; i < 250; i++) logging.logMCPDebug('server', String(i))
    const sink = makeSink()
    logging.attachErrorLogSink(sink)
    expect(sink.logError.mock.calls[0]?.[0].message).toBe('retained error')
    expect(sink.logMCPDebug).toHaveBeenCalledTimes(100)
  })

  it('snapshots errors before callers mutate their object graphs', () => {
    const original = Object.assign(new Error('original message'), { payload: new Uint8Array(1024 * 1024) })
    logging.logError(original)
    logging.logMCPError('server', original)
    original.message = 'mutated message'
    original.stack = 'mutated stack'
    const sink = makeSink()
    logging.attachErrorLogSink(sink)
    const replayed = sink.logError.mock.calls[0]?.[0]
    expect(replayed).not.toBe(original)
    expect(replayed.message).toBe('original message')
    expect(replayed).not.toHaveProperty('payload')
    expect(sink.logMCPError.mock.calls[0]?.[1]).toContain('original message')
    expect(sink.logMCPError.mock.calls[0]?.[1]).not.toBe(original)
  })

  it('bounds UTF-8 payloads and the visible error history', () => {
    const large = '🙂'.repeat(100_000)
    logging.logError(new Error(large))
    logging.logMCPError(large, large)
    logging.logMCPDebug(large, large)
    const sink = makeSink()
    logging.attachErrorLogSink(sink)
    expect(Buffer.byteLength(sink.logError.mock.calls[0]?.[0].message)).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(sink.logError.mock.calls[0]?.[0].stack)).toBeLessThanOrEqual(8192)
    for (const calls of [sink.logMCPError.mock.calls, sink.logMCPDebug.mock.calls]) {
      expect(Buffer.byteLength(calls[0]?.[0])).toBeLessThanOrEqual(256)
      expect(Buffer.byteLength(calls[0]?.[1])).toBeLessThanOrEqual(8192)
    }
    expect(Buffer.byteLength(logging.getInMemoryErrors()[0]!.error)).toBeLessThanOrEqual(8192)
  })

  it('reports bounded retained bytes and separate overflow counts without logging', () => {
    for (let i = 0; i < 107; i++) logging.logMCPError('server', 'x'.repeat(20_000))
    for (let i = 0; i < 109; i++) logging.logMCPDebug('server', 'x'.repeat(20_000))
    const stats = logging.getErrorLogQueueStats()
    expect(stats).toMatchObject({ errors: 100, debug: 100, droppedErrors: 7, droppedDebug: 9 })
    expect(stats.retainedBytes).toBeLessThanOrEqual(200 * (8192 + 256 + 8))
    const sink = makeSink()
    logging.attachErrorLogSink(sink)
    expect(sink.logMCPError).toHaveBeenCalledTimes(100)
    expect(sink.logMCPDebug).toHaveBeenCalledTimes(100)
    expect(logging.getErrorLogQueueStats()).toMatchObject({ errors: 0, debug: 0, retainedBytes: 0, droppedErrors: 7, droppedDebug: 9 })
  })

  it('shares the error quota and preserves FIFO order across event types', () => {
    const delivered: string[] = []
    for (let i = 0; i < 102; i++) {
      if (i % 2) logging.logMCPError('server', String(i))
      else logging.logError(new Error(String(i)))
      if (i === 10) logging.logMCPDebug('server', 'debug')
    }
    logging.attachErrorLogSink({
      ...makeSink(),
      logError: error => { delivered.push(error.message) },
      logMCPError: (_, error) => { delivered.push(String(error)) },
      logMCPDebug: (_, message) => { delivered.push(message) },
    })
    const expected = Array.from({ length: 100 }, (_, i) => String(i + 2))
    expected.splice(9, 0, 'debug')
    expect(delivered).toEqual(expected)
  })

  it('continues draining when a sink fails and records dropped events', () => {
    logging.logMCPDebug('server', 'first')
    logging.logMCPDebug('server', 'second')
    const sink = makeSink()
    sink.logMCPDebug.mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => logging.attachErrorLogSink(sink)).not.toThrow()
    expect(sink.logMCPDebug).toHaveBeenCalledTimes(2)
    expect(logging.getErrorLogQueueStats()).toMatchObject({ debug: 0, droppedDebug: 1 })
  })

  it('detaches and clears state without allowing stale disposers to detach a new sink', () => {
    const sink = makeSink()
    const detach = logging.attachErrorLogSink(sink)
    const duplicateDetach = logging.attachErrorLogSink(makeSink())
    duplicateDetach()
    logging.logError(new Error('first lifetime'))
    expect(sink.logError).toHaveBeenCalledOnce()
    detach()
    expect(logging.getInMemoryErrors()).toEqual([])
    logging.logMCPDebug('server', 'new startup')
    const nextDetach = logging.attachErrorLogSink(sink)
    detach()
    logging.logMCPDebug('server', 'new lifetime')
    expect(sink.logMCPDebug.mock.calls.map(call => call[1])).toEqual(['new startup', 'new lifetime'])
    nextDetach()
    expect(logging.getErrorLogQueueStats()).toEqual({ errors: 0, debug: 0, retainedBytes: 0, droppedErrors: 0, droppedDebug: 0 })
  })
})
