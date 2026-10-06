import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext, type HomeContext } from '../../src/config/home.js'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'

const nativeModulePath = '../../src/utils/secureStorage/native.js'
const secureStorageByIdentity = new Map<string, SecureStorageData>()

function home(path: string): HomeContext {
  return resolveHomeContext(
    { AGENC_HOME: path },
    { platformHome: '/tmp' },
  )
}

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}.signature`
}

async function loadRepository(asyncRead?: (bound: HomeContext) => Promise<SecureStorageData>) {
  vi.resetModules()
  vi.doMock(nativeModulePath, () => ({
    NativeSecureStorageError: class NativeSecureStorageError extends Error {},
    readNativeSecureStorage: (bound: HomeContext) =>
      structuredClone(secureStorageByIdentity.get(bound.identityKey) ?? {}),
    readNativeSecureStorageAsync: asyncRead ?? (async (bound: HomeContext) =>
      structuredClone(secureStorageByIdentity.get(bound.identityKey) ?? {})),
    updateNativeSecureStorage: (
      bound: HomeContext,
      updater: (current: Readonly<SecureStorageData>) => SecureStorageData,
    ) => {
      const previous = structuredClone(
        secureStorageByIdentity.get(bound.identityKey) ?? {},
      )
      const written = structuredClone(updater(previous))
      secureStorageByIdentity.set(bound.identityKey, written)
      return { previous, written }
    },
  }))
  return import('../../src/utils/openAiOauthCredentials.ts')
}

describe('OpenAI OAuth credential authority', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => secureStorageByIdentity.clear())

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.doUnmock(nativeModulePath)
    vi.clearAllMocks()
    vi.resetModules()
  })

  test('isolates secure-storage identities and preserves unrelated namespaces', async () => {
    const first = home('/tmp/agenc-openai-home-a')
    const second = home('/tmp/agenc-openai-home-b')
    secureStorageByIdentity.set(first.identityKey, {
      pluginSecrets: { demo: { token: 'keep-me' } },
    })
    secureStorageByIdentity.set(second.identityKey, {
      trustedDeviceToken: 'keep-too',
    })
    const repository = await loadRepository()

    expect(repository.saveOpenAiOauthCredentials(first, {
      accessToken: 'access-a',
      accountId: 'account-a',
    }).success).toBe(true)
    expect(repository.saveOpenAiOauthCredentials(second, {
      apiKey: 'platform-b',
    }).success).toBe(true)
    expect(repository.readOpenAiOauthCredentials(first)?.accessToken).toBe(
      'access-a',
    )
    expect(repository.readOpenAiOauthApiKey(second)).toBe('platform-b')
    expect(
      secureStorageByIdentity.get(first.identityKey)?.pluginSecrets,
    ).toEqual({
      demo: { token: 'keep-me' },
    })

    expect(repository.clearOpenAiOauthCredentials(first).success).toBe(true)
    expect(repository.readOpenAiOauthCredentials(first)).toBeUndefined()
    expect(repository.readOpenAiOauthApiKey(second)).toBe('platform-b')
    expect(
      secureStorageByIdentity.get(second.identityKey)?.trustedDeviceToken,
    ).toBe('keep-too')
  })

  test('single-flights refresh and preserves a newer concurrent login', async () => {
    const bound = home('/tmp/agenc-openai-refresh-home')
    const expired = jwt({ exp: 1, chatgpt_account_id: 'old-account' })
    const fresh = jwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'refreshed-account',
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    globalThis.fetch = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify({
        access_token: fresh,
        refresh_token: 'rotated-refresh',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const repository = await loadRepository()
    expect(repository.saveOpenAiOauthCredentials(bound, {
      accessToken: expired,
      refreshToken: 'old-refresh',
      accountId: 'old-account',
    }).success).toBe(true)
    const environment = Object.freeze({
      PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client',
    })

    const first = repository.refreshOpenAiSubscriptionIfNeeded(
      bound,
      environment,
    )
    const second = repository.refreshOpenAiSubscriptionIfNeeded(
      bound,
      environment,
    )
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
    expect(repository.saveOpenAiOauthCredentials(bound, {
      accessToken: 'new-login',
      refreshToken: 'new-login-refresh',
      accountId: 'new-account',
    }).success).toBe(true)
    release()

    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left.refreshed).toBe(false)
    expect(repository.readOpenAiOauthCredentials(bound)?.accessToken).toBe(
      'new-login',
    )
  })

  test('single-flights before independently delayed credential reads can reuse a rotated token', async () => {
    const bound = home('/tmp/agenc-openai-delayed-read-home')
    const expired = jwt({ exp: 1, chatgpt_account_id: 'account-1' })
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3_600, chatgpt_account_id: 'account-1' })
    secureStorageByIdentity.set(bound.identityKey, { openAiOauth: {
      accessToken: expired, refreshToken: 'old-refresh', accountId: 'account-1', authMode: 'chatgpt',
    } })
    let releaseSecondRead!: () => void
    const secondRead = new Promise<void>(resolve => { releaseSecondRead = resolve })
    let reads = 0
    const repository = await loadRepository(async storageHome => {
      const snapshot = structuredClone(secureStorageByIdentity.get(storageHome.identityKey) ?? {})
      if (++reads === 2) await secondRead
      return snapshot
    })
    const exchanged: string[] = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const token = new URLSearchParams(String(init?.body)).get('refresh_token') ?? ''
      exchanged.push(token)
      if (exchanged.length > 1) return new Response('{"error":"invalid_grant"}', { status: 400 })
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'new-refresh' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const environment = Object.freeze({ PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client' })
    const first = repository.refreshOpenAiSubscriptionIfNeeded(bound, environment)
    const second = repository.refreshOpenAiSubscriptionIfNeeded(bound, environment)
    await first
    releaseSecondRead()
    const results = await Promise.all([first, second])
    expect(results.every(result => result.credentials?.accessToken === fresh)).toBe(true)
    expect(exchanged).toEqual(['old-refresh'])
  })

  test('refreshes the subscription token even when the same login also minted a platform key', async () => {
    const bound = home('/tmp/agenc-openai-dual-credential-refresh-home')
    const expired = jwt({ exp: 1, chatgpt_account_id: 'account-1' })
    const fresh = jwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'account-1',
    })
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        access_token: fresh,
        refresh_token: 'rotated-refresh',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch
    const repository = await loadRepository()
    expect(repository.saveOpenAiOauthCredentials(bound, {
      apiKey: 'platform-key',
      accessToken: expired,
      refreshToken: 'old-refresh',
      accountId: 'account-1',
    }).success).toBe(true)

    const result = await repository.refreshOpenAiSubscriptionIfNeeded(
      bound,
      Object.freeze({ PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client' }),
    )

    expect(result.refreshed).toBe(true)
    expect(result.credentials).toMatchObject({
      apiKey: 'platform-key',
      accessToken: fresh,
      refreshToken: 'rotated-refresh',
      accountId: 'account-1',
      authMode: 'apiKey',
    })
  })

  test('refuses a refresh-token redirect away from the trusted token endpoint', async () => {
    const bound = home('/tmp/agenc-openai-refresh-redirect-home')
    const expired = jwt({ exp: 1, chatgpt_account_id: 'account-1' })
    secureStorageByIdentity.set(bound.identityKey, { openAiOauth: {
      accessToken: expired, refreshToken: 'old-refresh', accountId: 'account-1', authMode: 'chatgpt',
    } })
    const leaked: string[] = []
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).startsWith('https://attacker.example')) {
        leaked.push(String(init?.body))
        return new Response('{}', { status: 200 })
      }
      if (init?.redirect !== 'manual') {
        leaked.push(String(init?.body))
        return new Response('{}', { status: 200 })
      }
      return Response.redirect('https://attacker.example/token', 307)
    }) as typeof fetch
    const repository = await loadRepository()
    await expect(repository.refreshOpenAiSubscriptionIfNeeded(bound,
      Object.freeze({ PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client' })))
      .rejects.toThrow(/token endpoint redirect/u)
    expect(leaked).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
