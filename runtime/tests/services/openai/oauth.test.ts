import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callback: undefined as
    | ((request: { url?: string }, response: unknown) => void)
    | undefined,
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  proxy: vi.fn(),
}))

vi.mock('node:http', () => ({
  createServer: vi.fn((callback: typeof mocks.callback) => {
    mocks.callback = callback
    return {
      close: mocks.close,
      listen: mocks.listen,
      on: mocks.on,
    }
  }),
}))

vi.mock('../../../src/utils/proxy.js', () => ({
  getProxyFetchOptions: mocks.proxy,
}))

import { runOpenAiBrowserLogin } from '../../../src/services/openai/oauth.js'

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}.signature`
}

describe('OpenAI browser OAuth authority', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mocks.callback = undefined
    mocks.listen.mockReset()
    mocks.close.mockReset()
    mocks.on.mockReset()
    mocks.proxy.mockReset()
    mocks.proxy.mockReturnValue({ dispatcher: 'captured-proxy' })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  test('uses one captured client, callback port, and proxy for authorization and exchange', async () => {
    const environment = Object.freeze({
      PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client-id',
      PROVIDER_CODE_OAUTH_CALLBACK_PORT: '32145',
      HTTPS_PROXY: 'http://proxy.example:8443',
    })
    const idToken = jwt({ email: 'operator@example.com' })
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        access_token: 'subscription-access-token',
        id_token: idToken,
        refresh_token: 'refresh-token',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch
    const stages: string[] = []
    let authorizeUrl: URL | undefined

    const result = await runOpenAiBrowserLogin({
      environment,
      onAuthorizeUrl: url => {
        authorizeUrl = new URL(url)
        const state = authorizeUrl.searchParams.get('state')
        expect(state).not.toBeNull()
        const response = {
          writeHead: vi.fn().mockReturnThis(),
          end: vi.fn(),
        }
        mocks.callback?.(
          { url: `/auth/callback?code=authorization-code&state=${state}` },
          response,
        )
      },
      onStage: stage => stages.push(stage),
    })

    expect(mocks.listen).toHaveBeenCalledWith(32145, '127.0.0.1')
    expect(authorizeUrl?.searchParams.get('client_id')).toBe(
      'captured-client-id',
    )
    expect(authorizeUrl?.searchParams.get('redirect_uri')).toBe(
      'http://localhost:32145/auth/callback',
    )
    expect(mocks.proxy).toHaveBeenCalledWith({ environment })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [, request] = vi.mocked(globalThis.fetch).mock.calls[0]!
    expect(request).toMatchObject({ dispatcher: 'captured-proxy' })
    const body = request?.body as URLSearchParams
    expect(body.get('client_id')).toBe('captured-client-id')
    expect(body.get('redirect_uri')).toBe(
      'http://localhost:32145/auth/callback',
    )
    expect(stages).toEqual(['callback_received', 'exchanging_code'])
    expect(result).toEqual({
      accountLabel: 'operator@example.com',
      tokens: {
        accessToken: 'subscription-access-token',
        idToken,
        refreshToken: 'refresh-token',
      },
    })
  })
})
