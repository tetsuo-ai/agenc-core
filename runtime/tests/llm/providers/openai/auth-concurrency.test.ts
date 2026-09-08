import { describe, expect, test, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { OpenAIAuthSession } from '../../../../src/llm/providers/openai/auth.js'
import { OpenAIProvider } from '../../../../src/llm/providers/openai/adapter.js'
import { LLMTimeoutError } from '../../../../src/llm/errors.js'
import type { OAuthRefreshCallbacks } from '../../../../src/llm/oauth/refresh-loop.js'
import {
  createControlledPromise,
  drainMicrotasks,
  settleWithinMicrotasks,
} from '../../../helpers/controlled-async.js'

function unauthorized(): Error & { status: number } {
  return Object.assign(new Error('fixture unauthorized'), { status: 401 })
}

function createAuth(refreshAccessToken: OAuthRefreshCallbacks['refreshAccessToken']): OpenAIAuthSession {
  return new OpenAIAuthSession({
    authMode: 'oauth',
    oauth: { accessToken: 'old-token', refreshToken: 'refresh-token', refreshAccessToken },
  })
}

describe('OAuth credential generations', () => {
  test.each(['chat', 'stream'] as const)('forwards %s cancellation without aborting another refresh waiter', async mode => {
    const refreshGate = createControlledPromise<void>()
    const refreshStarted = createControlledPromise<void>()
    const secondRequestStarted = createControlledPromise<void>()
    const refresh = vi.fn(async () => {
      refreshStarted.resolve()
      await refreshGate.promise
      return { kind: 'refreshed' as const, accessToken: 'new-token' }
    })
    const tokens: Array<string | null> = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const token = new Headers(init?.headers).get('authorization')
      tokens.push(token)
      if (token === 'Bearer old-token') {
        if (tokens.length === 2) secondRequestStarted.resolve()
        return Response.json({ error: { message: 'unauthorized' } }, { status: 401 })
      }
      const response = {
        id: 'response-fixture',
        status: 'completed',
        model: 'gpt-5',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
      return mode === 'chat'
        ? Response.json(response)
        : new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
    })
    const provider = new OpenAIProvider({
      model: 'gpt-5',
      authMode: 'oauth',
      oauth: { accessToken: 'old-token', refreshToken: 'refresh-token', refreshAccessToken: refresh },
      fetchImpl,
    })
    const cancelledController = new AbortController()
    const survivingController = new AbortController()
    const run = (signal: AbortSignal) => mode === 'chat'
      ? provider.chat([{ role: 'user', content: 'hello' }], { signal })
      : provider.chatStream([{ role: 'user', content: 'hello' }], () => {}, { signal })
    const cancelled = run(cancelledController.signal).catch(error => error)
    await refreshStarted.promise
    const surviving = run(survivingController.signal)
    await secondRequestStarted.promise
    cancelledController.abort(new DOMException('cancelled waiter', 'AbortError'))
    expect(await settleWithinMicrotasks(cancelled)).toMatchObject({
      status: 'fulfilled', value: expect.any(LLMTimeoutError),
    })
    expect(getEventListeners(cancelledController.signal, 'abort')).toHaveLength(0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    refreshGate.resolve()
    await expect(surviving).resolves.toMatchObject({ content: 'ok' })
    expect(tokens).toEqual(['Bearer old-token', 'Bearer old-token', 'Bearer new-token'])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(getEventListeners(survivingController.signal, 'abort')).toHaveLength(0)
  })

  test('coalesces simultaneous unauthorized operations into one refresh', async () => {
    const refreshGate = createControlledPromise<void>()
    const refreshStarted = createControlledPromise<void>()
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) refreshStarted.resolve()
      await refreshGate.promise
      return { kind: 'refreshed' as const, accessToken: 'new-token' }
    })
    const auth = createAuth(refresh)
    const operations = Array.from({ length: 8 }, () => auth.withAuthorizedOperation(async () => {
      const headers = auth.resolveHeaders()
      if (headers.authorization === 'Bearer old-token') throw unauthorized()
      return headers.authorization
    }))
    await refreshStarted.promise
    refreshGate.resolve()
    expect(await Promise.all(operations)).toEqual(Array(8).fill('Bearer new-token'))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('does not let a delayed old-generation failure exhaust new credentials', async () => {
    const oldRequestGate = createControlledPromise<void>()
    const oldRequestStarted = createControlledPromise<void>()
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValueOnce({ kind: 'refreshed', accessToken: 'new-token' })
      .mockResolvedValueOnce({ kind: 'exhausted', reason: 'old refresh reused' })
    const auth = createAuth(refresh)
    const delayed = auth.withAuthorizedOperation(async () => {
      const token = auth.resolveHeaders().authorization
      if (token === 'Bearer old-token') {
        oldRequestStarted.resolve()
        await oldRequestGate.promise
        throw unauthorized()
      }
      return token
    })
    const observedDelayed = delayed.then(value => ({ value }), error => ({ error }))
    await oldRequestStarted.promise
    expect(await auth.withAuthorizedOperation(async () => {
      const token = auth.resolveHeaders().authorization
      if (token === 'Bearer old-token') throw unauthorized()
      return token
    })).toBe('Bearer new-token')
    oldRequestGate.resolve()
    expect(await observedDelayed).toEqual({ value: 'Bearer new-token' })
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(auth.withAuthorizedOperation(async () => 'later')).resolves.toBe('later')
  })

  test('binds headers to each operation attempt across asynchronous setup', async () => {
    const paused = createControlledPromise<void>()
    const release = createControlledPromise<void>()
    const auth = createAuth(async () => ({ kind: 'refreshed', accessToken: 'new-token' }))
    const delayed = auth.withAuthorizedOperation(async () => {
      paused.resolve()
      await release.promise
      return auth.resolveHeaders().authorization
    })
    await paused.promise
    await auth.withAuthorizedOperation(async () => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') throw unauthorized()
      return 'refreshed'
    })
    release.resolve()
    expect(await delayed).toBe('Bearer old-token')
    expect(auth.resolveHeaders().authorization).toBe('Bearer new-token')
  })

  test('single-wire failure does not claim that refresh was exhausted', async () => {
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValue({ kind: 'refreshed', accessToken: 'new-token' })
    const auth = createAuth(refresh)
    await expect(auth.withAuthorizedOperation(async () => { throw unauthorized() }, {
      singleWireAttempt: true,
    })).rejects.toMatchObject({ status: 401 })
    expect(refresh).not.toHaveBeenCalled()
    await expect(auth.withAuthorizedOperation(async () => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') throw unauthorized()
      return 'ok'
    })).resolves.toBe('ok')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('cancels one refresh waiter promptly without cancelling another', async () => {
    const refreshGate = createControlledPromise<void>()
    const refreshStarted = createControlledPromise<void>()
    const refresh = vi.fn(async () => {
      refreshStarted.resolve()
      await refreshGate.promise
      return { kind: 'refreshed' as const, accessToken: 'new-token' }
    })
    const auth = createAuth(refresh)
    const cancelledController = new AbortController()
    const survivingController = new AbortController()
    const operation = vi.fn(async () => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') throw unauthorized()
      return 'ok'
    })
    const cancelled = auth.withAuthorizedOperation(operation, { signal: cancelledController.signal })
    const cancelledResult = cancelled.catch(error => error)
    await refreshStarted.promise
    const surviving = auth.withAuthorizedOperation(operation, { signal: survivingController.signal })
    await drainMicrotasks(4)
    const reason = new DOMException('cancelled waiter', 'AbortError')
    cancelledController.abort(reason)
    const settled = await settleWithinMicrotasks(cancelledResult)
    expect(settled).toMatchObject({ status: 'fulfilled', value: reason })
    expect(getEventListeners(cancelledController.signal, 'abort')).toHaveLength(0)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    refreshGate.resolve()
    await expect(surviving).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(getEventListeners(survivingController.signal, 'abort')).toHaveLength(0)
  })

  test('observes refresh rejection after every waiter cancels', async () => {
    const refreshGate = createControlledPromise<void>()
    const refreshStarted = createControlledPromise<void>()
    const auth = createAuth(async () => {
      refreshStarted.resolve()
      await refreshGate.promise
      throw unauthorized()
    })
    const controller = new AbortController()
    const pending = auth.withAuthorizedOperation(async () => { throw unauthorized() }, {
      signal: controller.signal,
    })
    const observed = pending.catch(error => error)
    await refreshStarted.promise
    controller.abort(new DOMException('cancelled waiter', 'AbortError'))
    expect(await observed).toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    refreshGate.resolve()
    await drainMicrotasks(12)
    const later = vi.fn(async () => 'should not run')
    await expect(auth.withAuthorizedOperation(later)).rejects.toMatchObject({ statusCode: 401 })
    expect(later).not.toHaveBeenCalled()
  })

  test('does not start work for an already cancelled caller', async () => {
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
    const auth = createAuth(refresh)
    const controller = new AbortController()
    const reason = new DOMException('cancelled before start', 'AbortError')
    controller.abort(reason)
    const operation = vi.fn(async () => 'should not run')
    await expect(auth.withAuthorizedOperation(operation, { signal: controller.signal })).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  test('shares genuine exhaustion and keeps it sticky for subsequent calls', async () => {
    const gate = createControlledPromise<void>()
    const started = createControlledPromise<void>()
    const refresh = vi.fn(async () => {
      started.resolve()
      await gate.promise
      return { kind: 'exhausted' as const, reason: 'revoked' }
    })
    const auth = createAuth(refresh)
    const operation = vi.fn(async () => { throw unauthorized() })
    const results = Promise.allSettled(Array.from({ length: 4 }, () => auth.withAuthorizedOperation(operation)))
    await started.promise
    gate.resolve()
    for (const result of await results) {
      expect(result).toMatchObject({ status: 'rejected', reason: { statusCode: 401 } })
    }
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(auth.withAuthorizedOperation(operation)).rejects.toThrow('OAuth refresh exhausted')
    expect(operation).toHaveBeenCalledTimes(4)
  })

  test('does not let an older successful operation clear newer exhaustion', async () => {
    const oldSuccess = createControlledPromise<void>()
    const oldStarted = createControlledPromise<void>()
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValueOnce({ kind: 'refreshed', accessToken: 'new-token' })
      .mockResolvedValueOnce({ kind: 'exhausted', reason: 'revoked' })
    const auth = createAuth(refresh)
    const old = auth.withAuthorizedOperation(async () => {
      oldStarted.resolve()
      await oldSuccess.promise
      return 'old request succeeded'
    })
    await oldStarted.promise
    await expect(auth.withAuthorizedOperation(async () => { throw unauthorized() })).rejects.toThrow('OAuth refresh exhausted')
    oldSuccess.resolve()
    await expect(old).resolves.toBe('old request succeeded')
    const later = vi.fn(async () => 'should not run')
    await expect(auth.withAuthorizedOperation(later)).rejects.toThrow('OAuth refresh exhausted')
    expect(later).not.toHaveBeenCalled()
  })

  test('does not revive an exhausted generation when an outstanding request fails', async () => {
    const delayedFailure = createControlledPromise<void>()
    const started = createControlledPromise<void>()
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValueOnce({ kind: 'exhausted', reason: 'revoked' })
      .mockResolvedValueOnce({ kind: 'refreshed', accessToken: 'must not revive' })
    const auth = createAuth(refresh)
    const delayed = auth.withAuthorizedOperation(async () => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') {
        started.resolve()
        await delayedFailure.promise
        throw unauthorized()
      }
      return 'revived'
    })
    const observed = delayed.catch(error => error)
    await started.promise
    await expect(auth.withAuthorizedOperation(async () => { throw unauthorized() })).rejects.toThrow('OAuth refresh exhausted')
    delayedFailure.resolve()
    expect(await observed).toMatchObject({ statusCode: 401 })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('preserves current credentials after a delayed single-wire auth failure', async () => {
    const gate = createControlledPromise<void>()
    const started = createControlledPromise<void>()
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValue({ kind: 'refreshed', accessToken: 'new-token' })
    const auth = createAuth(refresh)
    const failure = unauthorized()
    const delayed = auth.withAuthorizedOperation(async () => {
      started.resolve()
      await gate.promise
      throw failure
    }, { singleWireAttempt: true }).catch(error => error)
    await started.promise
    await auth.withAuthorizedOperation(async () => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') throw unauthorized()
    })
    gate.resolve()
    expect(await delayed).toBe(failure)
    await expect(auth.withAuthorizedOperation(async () => auth.resolveHeaders().authorization))
      .resolves.toBe('Bearer new-token')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('bounds repeated rejection of refreshed credentials', async () => {
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValue({ kind: 'refreshed', accessToken: 'still-rejected' })
    const auth = createAuth(refresh)
    const operation = vi.fn(async () => { throw unauthorized() })
    await expect(auth.withAuthorizedOperation(operation)).rejects.toThrow('OAuth refresh exhausted')
    expect(operation).toHaveBeenCalledTimes(10)
    expect(refresh).toHaveBeenCalledTimes(9)
    await expect(auth.withAuthorizedOperation(operation)).rejects.toThrow('OAuth refresh exhausted')
    expect(operation).toHaveBeenCalledTimes(10)
  })

  test('tracks a new generation even if refresh returns the same token', async () => {
    const oldGate = createControlledPromise<void>()
    const oldStarted = createControlledPromise<void>()
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockResolvedValue({ kind: 'refreshed', accessToken: 'old-token' })
    const auth = createAuth(refresh)
    let oldAttempts = 0
    const delayed = auth.withAuthorizedOperation(async () => {
      if (++oldAttempts === 1) {
        oldStarted.resolve()
        await oldGate.promise
        throw unauthorized()
      }
      return 'reused new generation'
    })
    await oldStarted.promise
    let fastAttempts = 0
    await auth.withAuthorizedOperation(async () => {
      if (++fastAttempts === 1) throw unauthorized()
      return 'refreshed'
    })
    oldGate.resolve()
    await expect(delayed).resolves.toBe('reused new generation')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test.each([new Error('offline'), null, undefined, 'plain failure'])('preserves non-auth failures without refresh: %s', async error => {
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
    const auth = createAuth(refresh)
    await expect(auth.withAuthorizedOperation(async () => { throw error })).rejects.toBe(error)
    expect(refresh).not.toHaveBeenCalled()
    await expect(auth.withAuthorizedOperation(async () => 'ok')).resolves.toBe('ok')
  })

  test('allows a later retry after a transient refresh failure', async () => {
    const networkError = new Error('refresh offline')
    const refresh = vi.fn<OAuthRefreshCallbacks['refreshAccessToken']>()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ kind: 'refreshed', accessToken: 'new-token' })
    const auth = createAuth(refresh)
    const operation = async (): Promise<string> => {
      if (auth.resolveHeaders().authorization === 'Bearer old-token') throw unauthorized()
      return 'ok'
    }
    await expect(auth.withAuthorizedOperation(operation)).rejects.toBe(networkError)
    await expect(auth.withAuthorizedOperation(operation)).resolves.toBe('ok')
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
