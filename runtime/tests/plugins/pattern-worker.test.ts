import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { matchConfigPatterns } from '../../src/utils/plugins/pattern-worker.js'

const factory = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('node:worker_threads', () => ({ Worker: class {
  constructor(...args: unknown[]) { return factory.create(...args) }
} }))

class FakeWorker extends EventEmitter {
  postMessage = vi.fn()
  terminate = vi.fn().mockResolvedValue(0)
}
const checks = [{ pattern: '^ok$', entries: ['ok'] }]

describe('plugin pattern worker stage ownership', () => {
  let worker: FakeWorker
  beforeEach(() => {
    vi.useFakeTimers()
    worker = new FakeWorker()
    factory.create.mockReset().mockReturnValue(worker)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  test('does not send manifest data before readiness; startup does not spend regex budget', async () => {
    const result = matchConfigPatterns(checks)
    await vi.advanceTimersByTimeAsync(500)
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.emit('message', { type: 'ready' })
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith(checks)
    await vi.advanceTimersByTimeAsync(124)
    worker.emit('message', { type: 'result', results: [1] })
    await expect(result).resolves.toEqual([1])
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('bounds startup independently and never submits work after timeout', async () => {
    const diagnostic = vi.fn()
    const result = matchConfigPatterns(checks, diagnostic)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toEqual([3])
    worker.emit('message', { type: 'ready' })
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('startup_timeout')
  })

  test('snapshots input and result count before caller mutation during startup', async () => {
    const input = [{ pattern: '^ok$', entries: ['ok'] }]
    const result = matchConfigPatterns(input)
    input[0]!.pattern = '^changed$'
    input[0]!.entries[0] = 'changed'
    input.push({ pattern: '^more$', entries: ['more'] })
    worker.emit('message', { type: 'ready' })
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith([{ pattern: '^ok$', entries: ['ok'] }])
    worker.emit('message', { type: 'result', results: [1] })
    await expect(result).resolves.toEqual([1])
  })

  test('uncloneable inputs fail closed before constructing a worker', async () => {
    const diagnostic = vi.fn()
    await expect(matchConfigPatterns([{ pattern: '^ok$', entries: [() => 'bad'] }], diagnostic))
      .resolves.toEqual([3])
    expect(factory.create).not.toHaveBeenCalled()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('input_clone_failed')
  })

  test('timeout result cardinality is also fixed before caller mutation', async () => {
    const input = [{ pattern: '^ok$', entries: ['ok'] }]
    const result = matchConfigPatterns(input)
    input.length = 0
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toEqual([3])
  })

  test('rejects late readiness even before a delayed timer callback runs', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const diagnostic = vi.fn()
    const result = matchConfigPatterns(checks, diagnostic)
    now.mockReturnValue(1_001)
    worker.emit('message', { type: 'ready' })
    await expect(result).resolves.toEqual([3])
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('startup_timeout')
  })

  test('rejects late success even before a delayed execution timer runs', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const diagnostic = vi.fn()
    const result = matchConfigPatterns(checks, diagnostic)
    now.mockReturnValue(500)
    worker.emit('message', { type: 'ready' })
    now.mockReturnValue(625)
    worker.emit('message', { type: 'result', results: [1] })
    await expect(result).resolves.toEqual([3])
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('execution_timeout')
  })

  test('retains one 125ms execution budget across the entire pass', async () => {
    const diagnostic = vi.fn()
    const result = matchConfigPatterns([...checks, ...checks], diagnostic)
    worker.emit('message', { type: 'ready' })
    await vi.advanceTimersByTimeAsync(125)
    await expect(result).resolves.toEqual([3, 3])
    worker.emit('message', { type: 'result', results: [1, 1] })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith('execution_timeout')
  })

  test.each([
    ['premature result', { type: 'result', results: [1] }, false],
    ['duplicate ready', { type: 'ready' }, true],
    ['invalid result code', { type: 'result', results: [0] }, true],
    ['wrong result count', { type: 'result', results: [] }, true],
    ['extra result field', { type: 'result', results: [1], extra: true }, true],
    ['extra ready field', { type: 'ready', extra: true }, false],
    ['non-message', null, false],
  ])('fails closed for %s', async (_, message, ready) => {
    const result = matchConfigPatterns(checks)
    if (ready) worker.emit('message', { type: 'ready' })
    worker.emit('message', message)
    await expect(result).resolves.toEqual([3])
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['error', 'exit'])('fails closed on worker %s without retry', async event => {
    const result = matchConfigPatterns(checks)
    worker.emit(event, event === 'error' ? new Error('synthetic') : 0)
    await expect(result).resolves.toEqual([3])
    expect(factory.create).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  test('fails closed when worker construction or submission throws', async () => {
    factory.create.mockImplementationOnce(() => { throw new Error('synthetic') })
    await expect(matchConfigPatterns(checks)).resolves.toEqual([3])
    const result = matchConfigPatterns(checks)
    worker.postMessage.mockImplementationOnce(() => { throw new Error('synthetic') })
    worker.emit('message', { type: 'ready' })
    await expect(result).resolves.toEqual([3])
  })

  test('handles termination rejection without accepting late success', async () => {
    const diagnostic = vi.fn()
    worker.terminate.mockRejectedValueOnce(new Error('synthetic'))
    const result = matchConfigPatterns(checks, diagnostic)
    worker.emit('error', new Error('synthetic'))
    worker.emit('message', { type: 'ready' })
    await expect(result).resolves.toEqual([3])
    await vi.advanceTimersByTimeAsync(0)
    expect(worker.postMessage).not.toHaveBeenCalled()
    expect(diagnostic.mock.calls).toEqual([['worker_error'], ['termination_failed']])
  })

  test('retains synchronous termination failure as a fixed diagnostic', async () => {
    const diagnostic = vi.fn()
    worker.terminate.mockImplementationOnce(() => { throw new Error('sensitive synthetic value') })
    const result = matchConfigPatterns(checks, diagnostic)
    worker.emit('exit', 1)
    await expect(result).resolves.toEqual([3])
    expect(diagnostic.mock.calls).toEqual([['worker_exit'], ['termination_failed']])
  })

  test('reports cleanup uncertainty separately after an already verified result', async () => {
    const diagnostic = vi.fn()
    worker.terminate.mockRejectedValueOnce(new Error('synthetic'))
    const result = matchConfigPatterns(checks, diagnostic)
    worker.emit('message', { type: 'ready' })
    worker.emit('message', { type: 'result', results: [1] })
    await expect(result).resolves.toEqual([1])
    await vi.advanceTimersByTimeAsync(0)
    expect(diagnostic.mock.calls).toEqual([['termination_failed']])
  })

  test('a throwing diagnostic sink cannot skip termination or fail-open', async () => {
    const result = matchConfigPatterns(checks, () => { throw new Error('synthetic sink') })
    worker.emit('error', new Error('synthetic'))
    await expect(result).resolves.toEqual([3])
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  test('does not construct a worker for an empty pass', async () => {
    await expect(matchConfigPatterns([])).resolves.toEqual([])
    expect(factory.create).not.toHaveBeenCalled()
  })
})
