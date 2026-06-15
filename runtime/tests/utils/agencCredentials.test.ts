import { afterEach, describe, expect, test, vi } from 'vitest'

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

async function importFreshAgencCredentialsModule() {
  vi.resetModules()
  return import('../../src/utils/agencCredentials.ts')
}

describe('agencCredentials', () => {
  const originalSimple = process.env.AGENC_SIMPLE
  const originalCodeKey = process.env.AGENC_API_KEY
  const originalFetch = globalThis.fetch

  afterEach(() => {
    vi.doUnmock(secureStorageModulePath)
    vi.clearAllMocks()
    vi.resetModules()
    globalThis.fetch = originalFetch

    if (originalSimple === undefined) {
      delete process.env.AGENC_SIMPLE
    } else {
      process.env.AGENC_SIMPLE = originalSimple
    }

    if (originalCodeKey === undefined) {
      delete process.env.AGENC_API_KEY
    } else {
      process.env.AGENC_API_KEY = originalCodeKey
    }
  })

  test('save returns failure in bare mode', async () => {
    process.env.AGENC_SIMPLE = '1'

    const { saveAgencCredentials } = await importFreshAgencCredentialsModule()

    const result = saveAgencCredentials({
      accessToken: 'token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('Bare mode')
  })

  test('saveAgencCredentials refuses plaintext fallback when native secure storage is unavailable', async () => {
    delete process.env.AGENC_SIMPLE

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => null,
          readAsync: async () => null,
          update: () => ({
            success: false,
            warning:
              'Secure storage is unavailable on this platform without plaintext fallback.',
          }),
          delete: () => true,
        }
      },
    }))

    const { saveAgencCredentials } = await importFreshAgencCredentialsModule()

    const result = saveAgencCredentials({
      accessToken: 'token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('without plaintext fallback')
  })

  test('refreshAgencAccessTokenIfNeeded refreshes expired stored credentials', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = vi.fn(
      async (_input, init) => {
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : ''

        if (
          bodyText.includes('grant_type=refresh_token') ||
          bodyText.includes('"grant_type":"refresh_token"')
        ) {
          return new Response(
            JSON.stringify({
              access_token: freshAccessToken,
              refresh_token: 'refresh-new',
              id_token: freshIdToken,
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        return new Response(
          JSON.stringify({
            access_token: 'agenc-api-key-token',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        )
      },
    ) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded, readAgencCredentials } =
      await importFreshAgencCredentialsModule()

    const result = await refreshAgencAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)

    const stored = readAgencCredentials()
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBe('agenc-api-key-token')
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshAgencAccessTokenIfNeeded backs off after a failed refresh attempt', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let refreshAttempts = 0
    globalThis.fetch = vi.fn(async () => {
      refreshAttempts += 1
      return new Response(
        JSON.stringify({
          error: {
            code: 'invalid_grant',
            message: 'refresh token expired',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded, readAgencCredentials } =
      await importFreshAgencCredentialsModule()

    await expect(refreshAgencAccessTokenIfNeeded()).rejects.toThrow(
      'Agenc token refresh failed (invalid_grant): refresh token expired',
    )

    const afterFailure = readAgencCredentials()
    expect(typeof afterFailure?.lastRefreshFailureAt).toBe('number')

    const secondAttempt = await refreshAgencAccessTokenIfNeeded()
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })

  test('refreshAgencAccessTokenIfNeeded rejects malformed success payloads predictably', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = vi.fn(async () =>
      new Response('null', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    ) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()

    await expect(refreshAgencAccessTokenIfNeeded()).rejects.toThrow(
      'Agenc token refresh succeeded without a new access token.',
    )
  })

  test('refreshAgencAccessTokenIfNeeded drops a stale api key when id-token exchange fails', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        apiKey: 'stale-api-key',
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = vi.fn(
      async (_input, init) => {
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : ''

        if (bodyText.includes('grant_type=refresh_token')) {
          return new Response(
            JSON.stringify({
              access_token: freshAccessToken,
              refresh_token: 'refresh-new',
              id_token: freshIdToken,
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        return new Response('exchange failed', {
          status: 500,
        })
      },
    ) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded, readAgencCredentials } =
      await importFreshAgencCredentialsModule()

    const result = await refreshAgencAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)

    const stored = readAgencCredentials()
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBeUndefined()
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshAgencAccessTokenIfNeeded deduplicates concurrent refresh attempts', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let refreshAttempts = 0
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })

    globalThis.fetch = vi.fn(async (_input, init) => {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : ''

      if (bodyText.includes('grant_type=refresh_token')) {
        refreshAttempts += 1
        await refreshGate
        return new Response(
          JSON.stringify({
            access_token: freshAccessToken,
            refresh_token: 'refresh-new',
            id_token: freshIdToken,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        )
      }

      return new Response(
        JSON.stringify({
          access_token: 'agenc-api-key-token',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()

    const firstRefresh = refreshAgencAccessTokenIfNeeded()
    const secondRefresh = refreshAgencAccessTokenIfNeeded()
    releaseRefresh?.()

    const [firstResult, secondResult] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ])

    expect(refreshAttempts).toBe(1)
    expect(firstResult).toEqual(secondResult)
    expect(firstResult.refreshed).toBe(true)
    expect(firstResult.credentials?.accessToken).toBe(freshAccessToken)
  })

  test('saveAgencCredentials preserves an existing linked profile id', async () => {
    delete process.env.AGENC_SIMPLE

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
        profileId: 'profile_agenc_oauth',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const { readAgencCredentials, saveAgencCredentials } =
      await importFreshAgencCredentialsModule()

    const saved = saveAgencCredentials({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      accountId: 'acct_new',
    })

    expect(saved.success).toBe(true)
    expect(readAgencCredentials()?.profileId).toBe('profile_agenc_oauth')
  })

  test('attachAgencProfileIdToStoredCredentials links the saved profile id', async () => {
    delete process.env.AGENC_SIMPLE

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const {
      attachAgencProfileIdToStoredCredentials,
      readAgencCredentials,
    } = await importFreshAgencCredentialsModule()

    const result =
      attachAgencProfileIdToStoredCredentials('profile_agenc_oauth')

    expect(result.success).toBe(true)
    expect(readAgencCredentials()?.profileId).toBe('profile_agenc_oauth')
  })

  test('refreshAgencAccessTokenIfNeeded uses async secure-storage reads in its request path', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_async',
    })

    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: freshToken,
        refreshToken: 'refresh-async',
        accountId: 'acct_async',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => {
          throw new Error(
            'sync storage read should not run during refresh checks',
          )
        },
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()

    const result = await refreshAgencAccessTokenIfNeeded()
    expect(result.refreshed).toBe(false)
    expect(result.credentials?.accessToken).toBe(freshToken)
  })

  test('refreshAgencAccessTokenIfNeeded keeps a cooldown in memory when secure storage cannot persist it', async () => {
    delete process.env.AGENC_SIMPLE
    delete process.env.AGENC_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })

    const storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: () => ({
          success: false,
          warning: 'secure storage unavailable',
        }),
      }),
    }))

    let refreshAttempts = 0
    globalThis.fetch = vi.fn(async () => {
      refreshAttempts += 1
      return new Response(
        JSON.stringify({
          error: {
            code: 'invalid_grant',
            message: 'refresh token expired',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()

    await expect(refreshAgencAccessTokenIfNeeded()).rejects.toThrow(
      'Agenc token refresh failed (invalid_grant): refresh token expired',
    )

    const secondAttempt = await refreshAgencAccessTokenIfNeeded()
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })
})
