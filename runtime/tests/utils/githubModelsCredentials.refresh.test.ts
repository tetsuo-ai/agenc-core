import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resolveHomeContext } from '../../src/config/home.js'

const HOME = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-github-refresh-home' },
  { platformHome: '/tmp' },
)

async function importFreshModule() {
  vi.resetModules()
  vi.doMock(providerModulePath, () => ({
    getSelectedProviderName: () => 'github',
  }))
  return import('../../src/utils/githubModelsCredentials.ts')
}

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const deviceFlowModulePath = '../../src/services/github/deviceFlow.js'
const providerModulePath = '../../src/utils/model/providers.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'

describe('refreshGithubModelsTokenIfNeeded', () => {
  const orig = {
    AGENC_PROVIDER: process.env.AGENC_PROVIDER,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  }

  beforeEach(() => {
    vi.doUnmock(secureStorageModulePath)
    vi.doUnmock(deviceFlowModulePath)
    vi.doUnmock(providerModulePath)
    vi.doUnmock(envUtilsModulePath)
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock(secureStorageModulePath)
    vi.doUnmock(deviceFlowModulePath)
    vi.doUnmock(providerModulePath)
    vi.doUnmock(envUtilsModulePath)
    vi.resetModules()
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) {
        delete process.env[k as keyof typeof orig]
      } else {
        process.env[k as keyof typeof orig] = v
      }
    }
  })

  test('refreshes expired Copilot token using stored OAuth token', async () => {
    process.env.AGENC_PROVIDER = 'github'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    let store: Record<string, unknown> = {
      githubModels: {
        accessToken: 'tid=stale;exp=1;sku=free',
        oauthAccessToken: 'ghu_oauth_secret',
      },
    }

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => store,
        readAsync: async () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))

    vi.doMock(deviceFlowModulePath, () => ({
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: async () => ({
        token: `tid=fresh;exp=${futureExp};sku=free`,
        expires_at: futureExp,
        refresh_in: 1500,
        endpoints: { api: 'https://api.githubcopilot.com' },
      }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded(HOME)
    expect(refreshed).toBe(true)
    expect(process.env.GITHUB_TOKEN).toBeUndefined()

    const githubModels = (store.githubModels ?? {}) as {
      accessToken?: string
      oauthAccessToken?: string
    }
    expect(githubModels.accessToken?.startsWith('tid=fresh;exp=')).toBe(true)
    expect(githubModels.oauthAccessToken).toBe('ghu_oauth_secret')
  })

  test('bare mode preserves GitHub credential read, refresh, save, and clear authority', async () => {
    process.env.AGENC_PROVIDER = 'github'
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    let store: Record<string, unknown> = {
      githubModels: {
        accessToken: 'tid=stale;exp=1;sku=free',
        oauthAccessToken: 'ghu_oauth_secret',
      },
    }
    vi.doMock(envUtilsModulePath, async importOriginal => {
      const actual = await importOriginal<
        typeof import('../../src/utils/envUtils.ts')
      >()
      return { ...actual, isBareMode: () => true }
    })
    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => store,
        readAsync: async () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))
    vi.doMock(deviceFlowModulePath, () => ({
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: async () => ({
        token: `tid=fresh;exp=${futureExp};sku=free`,
        expires_at: futureExp,
        refresh_in: 1500,
        endpoints: { api: 'https://api.githubcopilot.com' },
      }),
    }))

    const {
      clearGithubModelsToken,
      readGithubModelsToken,
      readGithubModelsTokenAsync,
      refreshGithubModelsTokenIfNeeded,
      saveGithubModelsToken,
    } = await importFreshModule()

    expect(readGithubModelsToken(HOME)).toContain('tid=stale')
    await expect(readGithubModelsTokenAsync(HOME)).resolves.toContain(
      'tid=stale',
    )
    await expect(refreshGithubModelsTokenIfNeeded(HOME)).resolves.toBe(true)
    expect(readGithubModelsToken(HOME)).toContain('tid=fresh')
    expect(saveGithubModelsToken(HOME, 'tid=saved;exp=9999999999'))
      .toMatchObject({ success: true })
    expect(clearGithubModelsToken(HOME)).toMatchObject({ success: true })
    expect(store).not.toHaveProperty('githubModels')
  })

  test('does not refresh when current Copilot token is valid', async () => {
    process.env.AGENC_PROVIDER = 'github'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const exchangeSpy = vi.fn(async () => ({
      token: `tid=unexpected;exp=${futureExp};sku=free`,
      expires_at: futureExp,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    }))

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: `tid=already-valid;exp=${futureExp};sku=free`,
            oauthAccessToken: 'ghu_oauth_secret',
          },
        }),
        readAsync: async () => ({
          githubModels: {
            accessToken: `tid=already-valid;exp=${futureExp};sku=free`,
            oauthAccessToken: 'ghu_oauth_secret',
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    vi.doMock(deviceFlowModulePath, () => ({
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: exchangeSpy,
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded(HOME)
    expect(refreshed).toBe(false)
    expect(exchangeSpy).not.toHaveBeenCalled()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test('does not overwrite a newer login while a stale refresh is in flight', async () => {
    process.env.AGENC_PROVIDER = 'github'
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    let store: Record<string, unknown> = {
      remoteAuth: { bearerToken: 'preserve-me' },
      githubModels: {
        accessToken: 'tid=stale;exp=1;sku=free',
        oauthAccessToken: 'ghu_stale_oauth',
      },
    }
    let releaseExchange: ((value: unknown) => void) | undefined

    vi.doMock(secureStorageModulePath, () => ({
      getSecureStorage: () => ({
        read: () => store,
        readAsync: async () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))
    vi.doMock(deviceFlowModulePath, () => ({
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: () =>
        new Promise(resolve => {
          releaseExchange = resolve
        }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()
    const pending = refreshGithubModelsTokenIfNeeded(HOME)
    await vi.waitFor(() => expect(releaseExchange).toBeTypeOf('function'))
    store = {
      ...store,
      githubModels: {
        accessToken: `tid=new-login;exp=${futureExp};sku=free`,
        oauthAccessToken: 'ghu_new_oauth',
      },
    }
    releaseExchange?.({
      token: `tid=stale-refresh;exp=${futureExp};sku=free`,
      expires_at: futureExp,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    })

    expect(await pending).toBe(false)
    expect(store.githubModels).toEqual({
      accessToken: `tid=new-login;exp=${futureExp};sku=free`,
      oauthAccessToken: 'ghu_new_oauth',
    })
    expect(store.remoteAuth).toEqual({ bearerToken: 'preserve-me' })
  })
})
