import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, get } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  runXaiBrowserLogin,
  waitForXaiLoopbackCallback,
  XAI_OAUTH_REDIRECT_URI,
} from '../../../src/services/xai/oauth.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

const discovery = {
  authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
}
const tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }

function request(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.setTimeout(1000, () => req.destroy(new Error('Loopback request timed out')))
  })
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback address')
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function portIsFree(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function callbackUrl(authorizeUrl: string, state?: string): string {
  const authorize = new URL(authorizeUrl)
  const callback = new URL(XAI_OAUTH_REDIRECT_URI)
  callback.searchParams.set('code', 'test-code')
  callback.searchParams.set('state', state ?? authorize.searchParams.get('state')!)
  return callback.toString()
}

afterEach(async () => {
  // The protocol fixes this port; let the previous response flush before reuse.
  await expect.poll(() => portIsFree(Number(new URL(XAI_OAUTH_REDIRECT_URI).port))).toBe(true)
})

describe('browser login cancellation', () => {
  test('does not discover or display authorization for an already cancelled attempt', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(async () => jsonResponse(discovery))
    const onAuthorizeUrl = vi.fn()
    await expect(runXaiBrowserLogin({
      fetchImpl, onAuthorizeUrl, timeoutMs: 100, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(onAuthorizeUrl).not.toHaveBeenCalled()
  })

  test('does not fall back to discovery defaults or open a callback listener after cancellation', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort()
      throw new Error('Discovery request aborted')
    })
    const onAuthorizeUrl = vi.fn()
    await expect(runXaiBrowserLogin({
      fetchImpl, onAuthorizeUrl, timeoutMs: 100, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    expect(onAuthorizeUrl).not.toHaveBeenCalled()
  })

  test('aborts a waiting loopback listener and releases its port before the timeout', async () => {
    const controller = new AbortController()
    const port = await unusedPort()
    const callback = waitForXaiLoopbackCallback({
      state: 'test-state', port, timeoutMs: 1000, signal: controller.signal,
    })
    const outcome = callback.promise.catch((error: unknown) => error)
    let unfinishedRequest: Socket | undefined
    let disconnectError: NodeJS.ErrnoException | undefined
    try {
      expect(await request(`http://127.0.0.1:${port}/not-callback`)).toBe(404)
      unfinishedRequest = createConnection({ host: '127.0.0.1', port })
      unfinishedRequest.on('error', (error: NodeJS.ErrnoException) => { disconnectError = error })
      unfinishedRequest.resume()
      await once(unfinishedRequest, 'connect')
      // Cancellation must also close a browser connection with partial headers.
      unfinishedRequest.write('GET /callback HTTP/1.1\r\n')
      controller.abort()
      await expect(outcome).resolves.toMatchObject({ code: 'cancelled' })
      await expect.poll(() => unfinishedRequest?.destroyed).toBe(true)
      expect([undefined, 'ECONNRESET']).toContain(disconnectError?.code)
      await expect.poll(() => portIsFree(port)).toBe(true)
      await expect(request(`http://127.0.0.1:${port}/callback?code=late&state=test-state`)).rejects.toThrow()
    } finally {
      unfinishedRequest?.destroy()
      callback.close()
      await outcome
    }
  })

  test('cancels immediately while the listener is still binding', async () => {
    const controller = new AbortController()
    const port = await unusedPort()
    const callback = waitForXaiLoopbackCallback({
      state: 'test-state', port, timeoutMs: 100, signal: controller.signal,
    })
    controller.abort()
    await expect(callback.promise).rejects.toMatchObject({ code: 'cancelled' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect.poll(() => portIsFree(port)).toBe(true)
  })

  test('an already cancelled callback wait never binds its port', async () => {
    const controller = new AbortController()
    const port = await unusedPort()
    controller.abort()
    const callback = waitForXaiLoopbackCallback({
      state: 'test-state', port, timeoutMs: 100, signal: controller.signal,
    })
    const outcome = callback.promise.catch((error: unknown) => error)
    try {
      await expect(outcome).resolves.toMatchObject({ code: 'cancelled' })
      expect(await portIsFree(port)).toBe(true)
    } finally {
      callback.close()
      await outcome
    }
  })

  test('cancels the browser callback wait without exchanging a code', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => jsonResponse(discovery))
    await expect(runXaiBrowserLogin({
      fetchImpl, timeoutMs: 100, signal: controller.signal,
      onAuthorizeUrl: async () => {
        expect(await request(new URL('/not-callback', XAI_OAUTH_REDIRECT_URI).toString())).toBe(404)
        controller.abort()
      },
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  test('does not exchange an accepted callback after a progress handler cancels the attempt', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(init?.method === 'POST' ? tokens : discovery))
    await expect(runXaiBrowserLogin({
      fetchImpl, timeoutMs: 1000, signal: controller.signal,
      onAuthorizeUrl: async (url) => { expect(await request(callbackUrl(url))).toBe(200) },
      onStage: () => controller.abort(),
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  test.each(['headers', 'body'])('rejects token %s that arrive after cancellation', async (stage) => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return jsonResponse(discovery)
      const response = jsonResponse(tokens)
      if (stage === 'headers') controller.abort()
      else {
        const text = response.text.bind(response)
        response.text = async () => { controller.abort(); return text() }
      }
      return response
    })
    await expect(runXaiBrowserLogin({
      fetchImpl, timeoutMs: 1000, signal: controller.signal,
      onAuthorizeUrl: async (url) => { expect(await request(callbackUrl(url))).toBe(200) },
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBe(controller.signal)
  })

  test('preserves exact callback routing, state validation and PKCE exchange', async () => {
    let authorize: URL | undefined
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return jsonResponse(discovery)
      const body = new URLSearchParams(String(init.body))
      expect(body.get('code')).toBe('test-code')
      expect(body.get('redirect_uri')).toBe(XAI_OAUTH_REDIRECT_URI)
      expect(body.get('code_challenge')).toBe(authorize?.searchParams.get('code_challenge'))
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'))
        .toBe(authorize?.searchParams.get('code_challenge'))
      return jsonResponse(tokens)
    })
    const result = await runXaiBrowserLogin({
      fetchImpl, timeoutMs: 1000,
      onAuthorizeUrl: async (url) => {
        authorize = new URL(url)
        const wrongPath = new URL(callbackUrl(url))
        wrongPath.pathname = '/callback/extra'
        expect(await request(wrongPath.toString())).toBe(404)
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(await request(callbackUrl(url))).toBe(200)
      },
    })
    expect(result.tokens.accessToken).toBe('test-access')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('rejects a callback with the wrong state before exchanging its code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(discovery))
    await expect(runXaiBrowserLogin({
      fetchImpl, timeoutMs: 1000,
      onAuthorizeUrl: (url) => { void request(callbackUrl(url, 'wrong-state')).catch(() => {}) },
    })).rejects.toMatchObject({ code: 'callback_failed' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
