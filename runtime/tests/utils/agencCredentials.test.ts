import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext, type HomeContext } from '../../src/config/home.js'

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'

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
  const providerEnvironment = Object.freeze({})
  const originalCodeKey = process.env.AGENC_API_KEY
  const originalProviderCodeKey = process.env.PROVIDER_CODE_API_KEY
  const originalAgencHome = process.env.AGENC_HOME
  const originalFetch = globalThis.fetch
  let homeRoot = ''
  let home: HomeContext

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'agenc-credentials-home-'))
    home = resolveHomeContext(
      { AGENC_HOME: join(homeRoot, 'agenc-home') },
      { platformHome: homeRoot },
    )
  })

  afterEach(() => {
    vi.doUnmock(secureStorageModulePath)
    vi.doUnmock(envUtilsModulePath)
    vi.clearAllMocks()
    vi.resetModules()
    globalThis.fetch = originalFetch
    rmSync(homeRoot, { recursive: true, force: true })

    if (originalCodeKey === undefined) {
      delete process.env.AGENC_API_KEY
    } else {
      process.env.AGENC_API_KEY = originalCodeKey
    }
    if (originalAgencHome === undefined) {
      delete process.env.AGENC_HOME
    } else {
      process.env.AGENC_HOME = originalAgencHome
    }
    if (originalProviderCodeKey === undefined) {
      delete process.env.PROVIDER_CODE_API_KEY
    } else {
      process.env.PROVIDER_CODE_API_KEY = originalProviderCodeKey
    }
  })

  test('save returns failure in bare mode', async () => {
    vi.doMock(envUtilsModulePath, async importOriginal => ({
      ...(await importOriginal<typeof import('../../src/utils/envUtils.js')>()),
      isBareMode: () => true,
    }))

    const { saveAgencCredentials } = await importFreshAgencCredentialsModule()

    const result = saveAgencCredentials(home, {
      accessToken: 'token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('Bare mode')
  })

  test('saveAgencCredentials refuses plaintext fallback when native secure storage is unavailable', async () => {
    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => {
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

    const result = saveAgencCredentials(home, {
      accessToken: 'token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('without plaintext fallback')
  })

  test('binds reads and writes to explicit homes while preserving unrelated namespaces', async () => {
    const otherHome = resolveHomeContext(
      { AGENC_HOME: join(homeRoot, 'other-agenc-home') },
      { platformHome: homeRoot },
    )
    const states = new Map<string, Record<string, unknown>>([
      [home.path, { pluginSecrets: { alpha: { token: 'plugin-a' } } }],
      [otherHome.path, { trustedDeviceToken: 'device-b' }],
    ])
    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: (boundHome: HomeContext) => ({
        read: () => states.get(boundHome.path) ?? null,
        readAsync: async () => states.get(boundHome.path) ?? null,
        update: (next: Record<string, unknown>) => {
          states.set(boundHome.path, next)
          return { success: true }
        },
      }),
    }))
    process.env.AGENC_HOME = join(homeRoot, 'ambient-home-that-must-not-win')

    const {
      clearAgencCredentials,
      readAgencCredentials,
      saveAgencCredentials,
    } = await importFreshAgencCredentialsModule()
    expect(saveAgencCredentials(home, {
      accessToken: 'home-a-token',
      accountId: 'account-a',
    }).success).toBe(true)
    expect(saveAgencCredentials(otherHome, {
      accessToken: 'home-b-token',
      accountId: 'account-b',
    }).success).toBe(true)

    expect(readAgencCredentials(home)?.accessToken).toBe('home-a-token')
    expect(readAgencCredentials(otherHome)?.accessToken).toBe('home-b-token')
    expect(states.get(home.path)?.pluginSecrets).toEqual({
      alpha: { token: 'plugin-a' },
    })
    expect(states.get(otherHome.path)?.trustedDeviceToken).toBe('device-b')
    expect(states.has(process.env.AGENC_HOME)).toBe(false)

    expect(clearAgencCredentials(home).success).toBe(true)
    expect(readAgencCredentials(home)).toBeUndefined()
    expect(readAgencCredentials(otherHome)?.accessToken).toBe('home-b-token')
    expect(states.get(home.path)?.pluginSecrets).toEqual({
      alpha: { token: 'plugin-a' },
    })
  })

  test('does not overwrite credentials replaced while an OAuth refresh is in flight', async () => {
    delete process.env.AGENC_API_KEY
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const refreshedToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_refreshed',
    })
    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
      pluginSecrets: { alpha: { token: 'plugin-secret' } },
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
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })
    globalThis.fetch = vi.fn(async () => {
      await refreshGate
      return new Response(JSON.stringify({
        access_token: refreshedToken,
        refresh_token: 'refresh-rotated',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const {
      readAgencCredentials,
      refreshAgencAccessTokenIfNeeded,
      saveAgencCredentials,
    } = await importFreshAgencCredentialsModule()
    const refresh = refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
    expect(saveAgencCredentials(home, {
      accessToken: 'newer-login-token',
      refreshToken: 'newer-refresh-token',
      accountId: 'acct_newer',
    }).success).toBe(true)
    releaseRefresh()

    const result = await refresh
    expect(result.refreshed).toBe(false)
    expect(result.credentials?.accessToken).toBe('newer-login-token')
    expect(readAgencCredentials(home)?.accessToken).toBe('newer-login-token')
    expect(storageState.pluginSecrets).toEqual({
      alpha: { token: 'plugin-secret' },
    })
  })

  test('does not refresh persisted OAuth when an explicit ProviderCode key wins', async () => {
    process.env.PROVIDER_CODE_API_KEY = 'ambient-key-that-must-not-win'
    const explicitEnvironment = Object.freeze({
      PROVIDER_CODE_API_KEY: 'explicit-provider-key',
    })
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
    })
    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'persisted-refresh',
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
    globalThis.fetch = vi.fn() as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()
    const result = await refreshAgencAccessTokenIfNeeded(
      home,
      explicitEnvironment,
    )

    expect(result).toEqual({ refreshed: false })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(
      (storageState.agenc as { accessToken: string }).accessToken,
    ).toBe(expiredToken)
  })

  test('refreshAgencAccessTokenIfNeeded refreshes expired stored credentials', async () => {
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

    const result = await refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    expect(result.refreshed).toBe(true)

    const stored = readAgencCredentials(home)
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBe('agenc-api-key-token')
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshAgencAccessTokenIfNeeded backs off after a failed refresh attempt', async () => {
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

    await expect(
      refreshAgencAccessTokenIfNeeded(home, providerEnvironment),
    ).rejects.toThrow(
      'Agenc token refresh failed (invalid_grant): refresh token expired',
    )

    const afterFailure = readAgencCredentials(home)
    expect(typeof afterFailure?.lastRefreshFailureAt).toBe('number')

    const secondAttempt = await refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })

  test('refreshAgencAccessTokenIfNeeded rejects malformed success payloads predictably', async () => {
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

    await expect(
      refreshAgencAccessTokenIfNeeded(home, providerEnvironment),
    ).rejects.toThrow(
      'Agenc token refresh succeeded without a new access token.',
    )
  })

  test('refreshAgencAccessTokenIfNeeded rejects non-JSON success payloads predictably', async () => {
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
      new Response('<html>login</html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
        },
      }),
    ) as unknown as typeof fetch

    const { refreshAgencAccessTokenIfNeeded } =
      await importFreshAgencCredentialsModule()

    await expect(
      refreshAgencAccessTokenIfNeeded(home, providerEnvironment),
    ).rejects.toThrow(
      'Agenc token refresh returned invalid JSON.',
    )
  })

  test('refreshAgencAccessTokenIfNeeded drops a stale api key when id-token exchange fails', async () => {
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

    const result = await refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    expect(result.refreshed).toBe(true)

    const stored = readAgencCredentials(home)
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBeUndefined()
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshAgencAccessTokenIfNeeded deduplicates concurrent refresh attempts', async () => {
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

    const firstRefresh = refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    const secondRefresh = refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
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

    const saved = saveAgencCredentials(home, {
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      accountId: 'acct_new',
    })

    expect(saved.success).toBe(true)
    expect(readAgencCredentials(home)?.profileId).toBe('profile_agenc_oauth')
  })

  test('attachAgencProfileIdToStoredCredentials links the saved profile id', async () => {
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
      attachAgencProfileIdToStoredCredentials(home, 'profile_agenc_oauth')

    expect(result.success).toBe(true)
    expect(readAgencCredentials(home)?.profileId).toBe('profile_agenc_oauth')
  })

  test('refreshAgencAccessTokenIfNeeded uses async secure-storage reads in its request path', async () => {
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

    const result = await refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    expect(result.refreshed).toBe(false)
    expect(result.credentials?.accessToken).toBe(freshToken)
  })

  test('refreshAgencAccessTokenIfNeeded keeps a cooldown in memory when secure storage cannot persist it', async () => {
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

    await expect(
      refreshAgencAccessTokenIfNeeded(home, providerEnvironment),
    ).rejects.toThrow(
      'Agenc token refresh failed (invalid_grant): refresh token expired',
    )

    const secondAttempt = await refreshAgencAccessTokenIfNeeded(
      home,
      providerEnvironment,
    )
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })
})
