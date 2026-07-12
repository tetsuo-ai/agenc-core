import { describe, expect, test, vi } from 'vitest'

import {
  buildXaiAuthorizeUrl,
  createXaiPkcePair,
  decodeXaiJwtClaims,
  discoverXaiOauthEndpoints,
  exchangeXaiAuthorizationCode,
  isTrustedXaiOauthEndpoint,
  isTrustedXaiOauthInferenceBaseUrl,
  pollXaiDeviceToken,
  refreshXaiOauthTokens,
  requestXaiDeviceCode,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPE,
  XaiOauthError,
} from '../../../src/services/xai/oauth.ts'

function jwtWith(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${enc({ alg: 'ES256' })}.${enc(claims)}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('endpoint trust', () => {
  test('accepts https x.ai origins only', () => {
    expect(isTrustedXaiOauthEndpoint('https://auth.x.ai/oauth2/token')).toBe(true)
    expect(isTrustedXaiOauthEndpoint('https://x.ai/anything')).toBe(true)
    expect(isTrustedXaiOauthEndpoint('http://auth.x.ai/oauth2/token')).toBe(false)
    expect(isTrustedXaiOauthEndpoint('https://evil-x.ai/oauth2/token')).toBe(false)
    expect(isTrustedXaiOauthEndpoint('https://auth.x.ai.attacker.example/t')).toBe(false)
    expect(isTrustedXaiOauthEndpoint('not a url')).toBe(false)
  })

  test('inference base URL allows api.x.ai and the grok.com CLI proxy', () => {
    expect(isTrustedXaiOauthInferenceBaseUrl('https://api.x.ai/v1')).toBe(true)
    expect(
      isTrustedXaiOauthInferenceBaseUrl('https://cli-chat-proxy.grok.com/v1'),
    ).toBe(true)
    expect(isTrustedXaiOauthInferenceBaseUrl('https://attacker.example/v1')).toBe(false)
    expect(isTrustedXaiOauthInferenceBaseUrl('http://api.x.ai/v1')).toBe(false)
    expect(isTrustedXaiOauthInferenceBaseUrl(undefined)).toBe(false)
  })
})

describe('authorize URL', () => {
  test('carries PKCE, state, plan, and the agenc referrer attribution', () => {
    const pkce = createXaiPkcePair()
    const url = new URL(
      buildXaiAuthorizeUrl({
        authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
        codeChallenge: pkce.challenge,
        state: 'state-1',
        nonce: 'nonce-1',
      }),
    )
    expect(url.origin).toBe('https://auth.x.ai')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(XAI_OAUTH_REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe(XAI_OAUTH_SCOPE)
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('nonce')).toBe('nonce-1')
    expect(url.searchParams.get('plan')).toBe('generic')
    expect(url.searchParams.get('referrer')).toBe('agenc')
  })
})

describe('discovery', () => {
  test('parses trusted endpoints', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: 'https://auth.x.ai/oauth2/token',
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
      }),
    )
    const endpoints = await discoverXaiOauthEndpoints(fetchImpl)
    expect(endpoints.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
    expect(endpoints.deviceAuthorizationEndpoint).toBe(
      'https://auth.x.ai/oauth2/device/code',
    )
  })

  test('rejects a poisoned discovery document', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: 'https://attacker.example/oauth2/token',
      }),
    )
    await expect(discoverXaiOauthEndpoints(fetchImpl)).rejects.toMatchObject({
      code: 'untrusted_endpoint',
    })
  })

  test('falls back to static endpoints when discovery is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    const endpoints = await discoverXaiOauthEndpoints(fetchImpl)
    expect(endpoints.tokenEndpoint).toBe('https://auth.x.ai/oauth2/token')
    expect(endpoints.authorizationEndpoint).toBe('https://auth.x.ai/oauth2/authorize')
  })
})

describe('authorization code exchange', () => {
  test('sends code_verifier and echoes code_challenge', async () => {
    let sentBody = ''
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body ?? '')
      return jsonResponse({
        access_token: jwtWith({ exp: Math.floor(Date.now() / 1000) + 21600 }),
        refresh_token: 'refresh-1',
        id_token: jwtWith({ email: 'user@example.com' }),
        expires_in: 21600,
      })
    })
    const tokens = await exchangeXaiAuthorizationCode({
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      codeChallenge: 'challenge-1',
      fetchImpl,
    })
    const body = new URLSearchParams(sentBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe('verifier-1')
    expect(body.get('code_challenge')).toBe('challenge-1')
    expect(body.get('code_challenge_method')).toBe('S256')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  test('fails when offline_access was rejected (no refresh_token)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a', expires_in: 100 }),
    )
    await expect(
      exchangeXaiAuthorizationCode({
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        code: 'c',
        codeVerifier: 'v',
        codeChallenge: 'ch',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' })
  })

  test('refuses to post credentials to an untrusted token endpoint', async () => {
    const fetchImpl = vi.fn()
    await expect(
      exchangeXaiAuthorizationCode({
        tokenEndpoint: 'https://attacker.example/token',
        code: 'c',
        codeVerifier: 'v',
        codeChallenge: 'ch',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'untrusted_endpoint' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('device flow', () => {
  test('requests and parses a device code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.x.ai/activate',
        verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-1234',
        expires_in: 600,
        interval: 5,
      }),
    )
    const code = await requestXaiDeviceCode({
      deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
      fetchImpl,
    })
    expect(code.deviceCode).toBe('dev-1')
    expect(code.userCode).toBe('ABCD-1234')
    expect(code.verificationUriComplete).toContain('user_code=')
    const body = new URLSearchParams(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body ?? ''),
    )
    expect(body.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID)
    expect(body.get('scope')).toBe(XAI_OAUTH_SCOPE)
  })

  test('polls through authorization_pending to tokens', async () => {
    const responses = [
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 21600,
      }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const tokens = await pollXaiDeviceToken({
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      deviceCode: {
        deviceCode: 'dev-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.x.ai/activate',
        expiresIn: 30,
        interval: 1,
      },
      fetchImpl,
    })
    expect(tokens.accessToken).toBe('access-1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  }, 15_000)

  test('access_denied aborts the poll', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'access_denied' }, 400),
    )
    await expect(
      pollXaiDeviceToken({
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        deviceCode: {
          deviceCode: 'dev-1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://auth.x.ai/activate',
          expiresIn: 30,
          interval: 1,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'access_denied' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('refresh', () => {
  test('does NOT retry transport failures (rotating refresh token)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection reset')
    })
    await expect(
      refreshXaiOauthTokens({
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        refreshToken: 'refresh-1',
        fetchImpl,
      }),
    ).rejects.toThrow('connection reset')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('retries Cloudflare challenge pages, bounded', async () => {
    const challenge = new Response(
      '<html>Just a moment... cloudflare challenge-platform</html>',
      { status: 403 },
    )
    const responses = [
      challenge,
      new Response('<html>Just a moment... cloudflare</html>', { status: 503 }),
      jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift()!)
    const tokens = await refreshXaiOauthTokens({
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      refreshToken: 'refresh-1',
      fetchImpl,
    })
    expect(tokens.accessToken).toBe('access-2')
    expect(tokens.refreshToken).toBe('refresh-2')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  test('invalid_grant surfaces as a typed terminal error', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    )
    await expect(
      refreshXaiOauthTokens({
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
        refreshToken: 'refresh-dead',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  test('missing expires_in falls back to the JWT exp claim', async () => {
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: jwtWith({ exp }) }),
    )
    const tokens = await refreshXaiOauthTokens({
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      refreshToken: 'refresh-1',
      fetchImpl,
    })
    expect(tokens.expiresAt).toBe(exp * 1000)
    // Refresh responses may omit the rotated token; that is not an error.
    expect(tokens.refreshToken).toBeUndefined()
  })
})

describe('jwt claim decoding', () => {
  test('decodes payload claims without verification', () => {
    const claims = decodeXaiJwtClaims(jwtWith({ email: 'u@x.ai', exp: 123 }))
    expect(claims?.email).toBe('u@x.ai')
    expect(claims?.exp).toBe(123)
    expect(decodeXaiJwtClaims('not-a-jwt')).toBeUndefined()
    expect(decodeXaiJwtClaims(undefined)).toBeUndefined()
  })
})

describe('XaiOauthError', () => {
  test('carries code and status', () => {
    const err = new XaiOauthError('oauth_error', 'boom', 400)
    expect(err.code).toBe('oauth_error')
    expect(err.status).toBe(400)
    expect(err.name).toBe('XaiOauthError')
  })
})
