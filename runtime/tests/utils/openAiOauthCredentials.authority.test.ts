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

async function loadRepository() {
  vi.resetModules()
  vi.doMock(nativeModulePath, () => ({
    NativeSecureStorageError: class NativeSecureStorageError extends Error {},
    readNativeSecureStorage: (bound: HomeContext) =>
      structuredClone(secureStorageByIdentity.get(bound.identityKey) ?? {}),
    readNativeSecureStorageAsync: async (bound: HomeContext) =>
      structuredClone(secureStorageByIdentity.get(bound.identityKey) ?? {}),
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
})
