import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'
import type { HomeContext } from '../../src/config/home.js'
import { snapshotProviderEnvironment } from '../../src/llm/provider-options.js'
import type { ProviderEnvironment } from '../../src/llm/provider-options.js'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'

const SECURE_STORAGE_MODULE = '../../src/utils/secureStorage/index.js'
const ENV_UTILS_MODULE = '../../src/utils/envUtils.js'
const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
const EMPTY_ENVIRONMENT: ProviderEnvironment = Object.freeze({})

const HOME_A = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-ai-oauth-home-a' },
  { platformHome: '/tmp' },
)
const HOME_B = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-ai-oauth-home-b' },
  { platformHome: '/tmp' },
)

let storageByIdentity = new Map<string, SecureStorageData>()
let asyncReads = new Map<string, number>()

function secureStorageKey(home: HomeContext): string {
  return `${home.identityKey}\0${home.oauthFileSuffix}\0${home.secureStorageAccount}`
}

async function loadAuthModule() {
  vi.resetModules()
  vi.doMock(SECURE_STORAGE_MODULE, () => ({
    getSecureStorage: (home: HomeContext) => ({
      name: `test-native-secure-storage:${home.path}`,
      read: () =>
        structuredClone(storageByIdentity.get(secureStorageKey(home)) ?? {}),
      readAsync: async () => {
        const key = secureStorageKey(home)
        asyncReads.set(key, (asyncReads.get(key) ?? 0) + 1)
        return structuredClone(storageByIdentity.get(key) ?? {})
      },
      update: (next: SecureStorageData) => {
        storageByIdentity.set(secureStorageKey(home), structuredClone(next))
        return { success: true }
      },
      delete: () => true,
    }),
  }))
  return import('../../src/utils/auth.js')
}

beforeEach(() => {
  process.env = { ...originalEnv, AGENC_HOME: HOME_A.path }
  delete process.env.AGENC_OAUTH_TOKEN
  delete process.env.AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageByIdentity = new Map([
    [
      secureStorageKey(HOME_A),
      {
        agencAiOauth: {
          accessToken: 'access-a',
          refreshToken: 'refresh-a',
          expiresAt: 1,
        },
        remoteAuth: { bearerToken: 'remote-a', createdAt: '2026-08-24T00:00:00Z' },
      },
    ],
    [
      secureStorageKey(HOME_B),
      {
        agencAiOauth: {
          accessToken: 'access-b',
          refreshToken: 'refresh-b',
          expiresAt: 1,
        },
        remoteAuth: { bearerToken: 'remote-b', createdAt: '2026-08-24T00:00:00Z' },
      },
    ],
  ])
  asyncReads = new Map()
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  vi.doUnmock(SECURE_STORAGE_MODULE)
  vi.doUnmock(ENV_UTILS_MODULE)
  vi.clearAllMocks()
  vi.resetModules()
})

describe('AgenC AI OAuth native authority', () => {
  test('bare mode preserves captured OAuth reads and refresh inputs', async () => {
    vi.doMock(ENV_UTILS_MODULE, async importOriginal => {
      const actual = await importOriginal<
        typeof import('../../src/utils/envUtils.ts')
      >()
      return { ...actual, isBareMode: () => true }
    })
    const { getAgenCAIOAuthTokens, getAgenCAIOAuthTokensAsync } =
      await loadAuthModule()

    expect(getAgenCAIOAuthTokens(HOME_A, EMPTY_ENVIRONMENT)).toMatchObject({
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })
    await expect(
      getAgenCAIOAuthTokensAsync(HOME_A, EMPTY_ENVIRONMENT),
    ).resolves.toMatchObject({
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })
  })

  test('A/B session snapshots remain isolated after process environment mutation', async () => {
    const { getAgenCAIOAuthTokens, getAgenCAIOAuthTokensAsync } =
      await loadAuthModule()
    const sessionA = snapshotProviderEnvironment({
      AGENC_OAUTH_TOKEN: 'session-a',
    })
    const sessionB = snapshotProviderEnvironment({
      AGENC_OAUTH_TOKEN: 'session-b',
    })

    process.env.AGENC_OAUTH_TOKEN = 'ambient-before'
    expect(getAgenCAIOAuthTokens(HOME_A, sessionA)?.accessToken).toBe(
      'session-a',
    )
    expect(getAgenCAIOAuthTokens(HOME_B, sessionB)?.accessToken).toBe(
      'session-b',
    )
    await expect(
      getAgenCAIOAuthTokensAsync(HOME_A, sessionA),
    ).resolves.toMatchObject({ accessToken: 'session-a' })
    await expect(
      getAgenCAIOAuthTokensAsync(HOME_B, sessionB),
    ).resolves.toMatchObject({ accessToken: 'session-b' })

    process.env.AGENC_OAUTH_TOKEN = 'ambient-after'
    expect(getAgenCAIOAuthTokens(HOME_A, sessionA)?.accessToken).toBe(
      'session-a',
    )
    expect(getAgenCAIOAuthTokens(HOME_B, sessionB)?.accessToken).toBe(
      'session-b',
    )
    await expect(
      getAgenCAIOAuthTokensAsync(HOME_A, sessionA),
    ).resolves.toMatchObject({ accessToken: 'session-a' })
    await expect(
      getAgenCAIOAuthTokensAsync(HOME_B, sessionB),
    ).resolves.toMatchObject({ accessToken: 'session-b' })

    expect(
      getAgenCAIOAuthTokens(HOME_A, EMPTY_ENVIRONMENT)?.accessToken,
    ).toBe('access-a')
  })

  test('explicit homes isolate memoized reads from the ambient home', async () => {
    const {
      clearOAuthTokenCache,
      getAgenCAIOAuthTokens,
      getAgenCAIOAuthTokensAsync,
    } = await loadAuthModule()

    expect(getAgenCAIOAuthTokens(HOME_A, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-a',
    )
    expect(getAgenCAIOAuthTokens(HOME_B, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-b',
    )

    storageByIdentity.set(secureStorageKey(HOME_A), {
      ...storageByIdentity.get(secureStorageKey(HOME_A)),
      agencAiOauth: {
        accessToken: 'access-a-new',
        refreshToken: 'refresh-a-new',
        expiresAt: 2,
      },
    })
    expect(getAgenCAIOAuthTokens(HOME_A, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-a',
    )
    expect(
      (await getAgenCAIOAuthTokensAsync(HOME_A, EMPTY_ENVIRONMENT))
        ?.accessToken,
    ).toBe('access-a-new')
    expect(getAgenCAIOAuthTokens(HOME_B, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-b',
    )

    clearOAuthTokenCache(HOME_A)
    expect(getAgenCAIOAuthTokens(HOME_A, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-a-new',
    )
    expect(getAgenCAIOAuthTokens(HOME_B, EMPTY_ENVIRONMENT)?.accessToken).toBe(
      'access-b',
    )
  })

  test('same-path OAuth secure-storage identities isolate memoized and 401 reads', async () => {
    const prodHome = resolveHomeContext({ AGENC_HOME: HOME_A.path })
    const localHome = resolveHomeContext({
      AGENC_HOME: HOME_A.path,
      USER_TYPE: 'ant',
      USE_LOCAL_OAUTH: '1',
    })
    const customHome = resolveHomeContext({
      AGENC_HOME: HOME_A.path,
      AGENC_CUSTOM_OAUTH_URL: 'https://agenc.tech',
    })
    const homes = [
      [prodHome, 'prod'],
      [localHome, 'local'],
      [customHome, 'custom'],
    ] as const
    for (const [credentialHome, label] of homes) {
      storageByIdentity.set(secureStorageKey(credentialHome), {
        agencAiOauth: {
          accessToken: `access-${label}`,
          refreshToken: `refresh-${label}`,
          expiresAt: Date.now() + 60_000,
        },
      })
    }

    const { getAgenCAIOAuthTokens, handleOAuth401Error } =
      await loadAuthModule()
    expect(
      homes.map(([credentialHome]) =>
        getAgenCAIOAuthTokens(credentialHome, EMPTY_ENVIRONMENT)?.accessToken
      ),
    ).toEqual(['access-prod', 'access-local', 'access-custom'])

    await expect(
      Promise.all(
        homes.map(([credentialHome]) =>
          handleOAuth401Error(
            credentialHome,
            'same-rejected-token',
            EMPTY_ENVIRONMENT,
          )
        ),
      ),
    ).resolves.toEqual([true, true, true])
    expect(
      homes.map(([credentialHome]) =>
        asyncReads.get(secureStorageKey(credentialHome)),
      ),
    ).toEqual([1, 1, 1])
  })

  test('401 single-flight keys include home and cannot cross-adopt credentials', async () => {
    const { handleOAuth401Error } = await loadAuthModule()
    storageByIdentity.set(secureStorageKey(HOME_A), {
      agencAiOauth: {
        accessToken: 'new-a',
        refreshToken: 'refresh-a',
        expiresAt: Date.now() + 60_000,
      },
    })
    storageByIdentity.set(secureStorageKey(HOME_B), {
      agencAiOauth: {
        accessToken: 'new-b',
        refreshToken: 'refresh-b',
        expiresAt: Date.now() + 60_000,
      },
    })

    await expect(
      Promise.all([
        handleOAuth401Error(
          HOME_A,
          'same-rejected-token',
          EMPTY_ENVIRONMENT,
        ),
        handleOAuth401Error(
          HOME_B,
          'same-rejected-token',
          EMPTY_ENVIRONMENT,
        ),
      ]),
    ).resolves.toEqual([true, true])
    expect(asyncReads.get(secureStorageKey(HOME_A))).toBe(1)
    expect(asyncReads.get(secureStorageKey(HOME_B))).toBe(1)
  })
})
