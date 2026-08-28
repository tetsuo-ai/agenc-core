import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { HomeContext } from '../../src/config/home.js'
import { resolveHomeContext } from '../../src/config/home.js'

type MockStorageData = Record<string, unknown>

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const oauthServiceModulePath = '../../src/services/xai/oauth.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'
const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
let storageByHome = new Map<string, MockStorageData>()
let home: HomeContext

function secureStorageKey(storageHome: HomeContext): string {
  return `${storageHome.identityKey}\0${storageHome.oauthFileSuffix}\0${storageHome.secureStorageAccount}`
}

const refreshMock = vi.fn()
const discoveryMock = vi.fn()

async function importFreshModule() {
  vi.resetModules()
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (storageHome: HomeContext) => ({
      name: 'mock-secure-storage',
      read: () => storageByHome.get(secureStorageKey(storageHome)) ?? {},
      readAsync: async () =>
        storageByHome.get(secureStorageKey(storageHome)) ?? {},
      update: (next: MockStorageData) => {
        storageByHome.set(secureStorageKey(storageHome), next)
        return { success: true }
      },
      delete: () => {
        storageByHome.delete(secureStorageKey(storageHome))
        return true
      },
    }),
  }))
  vi.doMock(oauthServiceModulePath, async () => {
    const actual = await vi.importActual<
      typeof import('../../src/services/xai/oauth.ts')
    >(oauthServiceModulePath)
    return {
      ...actual,
      refreshXaiOauthTokens: refreshMock,
      discoverXaiOauthEndpoints: discoveryMock,
    }
  })
  return import('../../src/utils/xaiOauthCredentials.ts')
}

function storedBlob(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    expiresAt: Date.now() + 6 * 3600 * 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  process.env = { ...originalEnv }
  // Hermetic per-test home for the cross-process refresh lock.
  // Override the canonical home per test so lock contention cannot leak
  // between tests. The memoize is keyed off the env var, so each test dir
  // gets a fresh value.
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.AGENC_HOME = await mkdtemp(join(tmpdir(), 'xai-oauth-test-'))
  home = resolveHomeContext(process.env)
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageByHome = new Map()
  refreshMock.mockReset()
  discoveryMock.mockReset()
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  storageByHome = new Map()
  vi.doUnmock(secureStorageModulePath)
  vi.doUnmock(oauthServiceModulePath)
  vi.doUnmock(envUtilsModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

test('save/read/clear round trip', async () => {
  const {
    clearXaiOauthCredentials,
    readXaiOauthAccessToken,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  expect(readXaiOauthCredentials(home)).toBeUndefined()
  expect(saveXaiOauthCredentials(home, storedBlob()).success).toBe(true)
  expect(readXaiOauthAccessToken(home)).toBe('access-1')
  expect(readXaiOauthCredentials(home)?.refreshToken).toBe('refresh-1')
  expect(clearXaiOauthCredentials(home).success).toBe(true)
  expect(readXaiOauthCredentials(home)).toBeUndefined()
})

test('quarantined credentials do not surface a bearer', async () => {
  const { readXaiOauthAccessToken, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(
    home,
    storedBlob({ quarantinedAt: Date.now(), quarantineReason: 'invalid_grant' }),
  )
  expect(readXaiOauthAccessToken(home)).toBeUndefined()
})

test('isXaiOauthBearer matches only the stored access token', async () => {
  const { isXaiOauthBearer, saveXaiOauthCredentials } = await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  expect(isXaiOauthBearer(home, 'access-1')).toBe(true)
  expect(isXaiOauthBearer(home, 'xai-real-api-key')).toBe(false)
  expect(isXaiOauthBearer(home, undefined)).toBe(false)
})

test('refreshIfNeeded no-ops when the token is far from expiry', async () => {
  const { refreshXaiOauthCredentialsIfNeeded, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  const result = await refreshXaiOauthCredentialsIfNeeded(home)
  expect(result?.accessToken).toBe('access-1')
  expect(refreshMock).not.toHaveBeenCalled()
})

test('force refresh rotates tokens and persists them', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockResolvedValue({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: Date.now() + 6 * 3600 * 1000,
  })

  const refreshed = await forceRefreshXaiOauthCredentials(home)
  expect(refreshed?.accessToken).toBe('access-2')
  const stored = readXaiOauthCredentials(home)
  expect(stored?.accessToken).toBe('access-2')
  expect(stored?.refreshToken).toBe('refresh-2')
  expect(refreshMock).toHaveBeenCalledWith({
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    refreshToken: 'refresh-1',
  })
})

test('bare mode preserves xAI OAuth read, refresh, login, and logout authority', async () => {
  storageByHome.set(secureStorageKey(home), { xaiOauth: storedBlob() })
  vi.doMock(envUtilsModulePath, async importOriginal => {
    const actual = await importOriginal<
      typeof import('../../src/utils/envUtils.ts')
    >()
    return { ...actual, isBareMode: () => true }
  })
  refreshMock.mockResolvedValue({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: Date.now() + 6 * 3600 * 1000,
  })
  const {
    clearXaiOauthCredentials,
    forceRefreshXaiOauthCredentials,
    readXaiOauthAccessToken,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  expect(readXaiOauthAccessToken(home)).toBe('access-1')
  await expect(forceRefreshXaiOauthCredentials(home)).resolves.toMatchObject({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
  })
  expect(readXaiOauthCredentials(home)?.accessToken).toBe('access-2')
  expect(saveXaiOauthCredentials(home, storedBlob({ accessToken: 'access-3' })))
    .toMatchObject({ success: true })
  expect(readXaiOauthAccessToken(home)).toBe('access-3')
  expect(clearXaiOauthCredentials(home)).toMatchObject({ success: true })
  expect(readXaiOauthCredentials(home)).toBeUndefined()
})

test('refresh response without a rotated token keeps the previous grant', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockResolvedValue({ accessToken: 'access-2' })

  await forceRefreshXaiOauthCredentials(home)
  expect(readXaiOauthCredentials(home)?.refreshToken).toBe('refresh-1')
})

test('terminal invalid_grant quarantines instead of retrying', async () => {
  const module = await importFreshModule()
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthAccessToken,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = module
  const { XaiOauthError } = await vi.importActual<
    typeof import('../../src/services/xai/oauth.ts')
  >(oauthServiceModulePath)

  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockRejectedValue(
    new XaiOauthError('invalid_grant', 'xAI OAuth error invalid_grant', 400),
  )

  expect(await forceRefreshXaiOauthCredentials(home)).toBeUndefined()
  expect(readXaiOauthCredentials(home)?.quarantinedAt).toBeTypeOf('number')
  expect(readXaiOauthAccessToken(home)).toBeUndefined()

  // Quarantined: further refreshes bail without touching the endpoint.
  refreshMock.mockClear()
  expect(await forceRefreshXaiOauthCredentials(home)).toBeUndefined()
  expect(refreshMock).not.toHaveBeenCalled()
})

test('transient refresh failure leaves the blob untouched', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockRejectedValue(new Error('connection reset'))

  expect(await forceRefreshXaiOauthCredentials(home)).toBeUndefined()
  const stored = readXaiOauthCredentials(home)
  expect(stored?.accessToken).toBe('access-1')
  expect(stored?.quarantinedAt).toBeUndefined()
})

test('concurrent force refreshes share a single flight', async () => {
  const { forceRefreshXaiOauthCredentials, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob())
  let release: (value: unknown) => void = () => {}
  refreshMock.mockImplementation(
    () =>
      new Promise(resolve => {
        release = () =>
          resolve({
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
          })
      }),
  )

  const first = forceRefreshXaiOauthCredentials(home)
  const second = forceRefreshXaiOauthCredentials(home)
  // The refresh now acquires a cross-process lock before hitting the
  // endpoint; wait for the exchange to actually start before releasing.
  await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  release(undefined)
  const [a, b] = await Promise.all([first, second])
  expect(a?.accessToken).toBe('access-2')
  expect(b?.accessToken).toBe('access-2')
  expect(refreshMock).toHaveBeenCalledTimes(1)
})

test('cache and single-flight state are isolated by explicit home', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const otherHome = resolveHomeContext({
    AGENC_HOME: await mkdtemp(join(tmpdir(), 'xai-oauth-other-home-')),
  })
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob({
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
  }))
  saveXaiOauthCredentials(otherHome, storedBlob({
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  }))
  expect(readXaiOauthCredentials(home)?.accessToken).toBe('access-a')
  expect(readXaiOauthCredentials(otherHome)?.accessToken).toBe('access-b')

  refreshMock.mockImplementation(async ({ refreshToken }: { refreshToken: string }) => ({
    accessToken: `rotated-${refreshToken}`,
    refreshToken: `next-${refreshToken}`,
  }))
  const [a, b] = await Promise.all([
    forceRefreshXaiOauthCredentials(home),
    forceRefreshXaiOauthCredentials(otherHome),
  ])
  expect(a?.accessToken).toBe('rotated-refresh-a')
  expect(b?.accessToken).toBe('rotated-refresh-b')
  expect(refreshMock).toHaveBeenCalledTimes(2)
})

test('same-path OAuth secure-storage identities isolate caches and refresh flights', async () => {
  const prodHome = resolveHomeContext({ AGENC_HOME: home.path })
  const localHome = resolveHomeContext({
    AGENC_HOME: home.path,
    USER_TYPE: 'ant',
    USE_LOCAL_OAUTH: '1',
  })
  const customHome = resolveHomeContext({
    AGENC_HOME: home.path,
    AGENC_CUSTOM_OAUTH_URL: 'https://agenc.tech',
  })
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  for (const [credentialHome, label] of [
    [prodHome, 'prod'],
    [localHome, 'local'],
    [customHome, 'custom'],
  ] as const) {
    saveXaiOauthCredentials(credentialHome, storedBlob({
      accessToken: `access-${label}`,
      refreshToken: `refresh-${label}`,
    }))
  }

  expect(readXaiOauthCredentials(prodHome)?.accessToken).toBe('access-prod')
  expect(readXaiOauthCredentials(localHome)?.accessToken).toBe('access-local')
  expect(readXaiOauthCredentials(customHome)?.accessToken).toBe('access-custom')

  refreshMock.mockImplementation(
    async ({ refreshToken }: { refreshToken: string }) => ({
      accessToken: `rotated-${refreshToken}`,
      refreshToken: `next-${refreshToken}`,
    }),
  )
  const refreshed = await Promise.all([
    forceRefreshXaiOauthCredentials(prodHome),
    forceRefreshXaiOauthCredentials(localHome),
    forceRefreshXaiOauthCredentials(customHome),
  ])
  expect(refreshed.map(blob => blob?.accessToken)).toEqual([
    'rotated-refresh-prod',
    'rotated-refresh-local',
    'rotated-refresh-custom',
  ])
  expect(refreshMock).toHaveBeenCalledTimes(3)
})

test('successful stale refresh cannot overwrite a newer login', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()
  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockImplementation(async () => {
    storageByHome.set(secureStorageKey(home), {
      remoteAuth: { bearerToken: 'preserve-me' },
      xaiOauth: storedBlob({
        accessToken: 'access-new-login',
        refreshToken: 'refresh-new-login',
      }),
    })
    return {
      accessToken: 'access-stale-refresh',
      refreshToken: 'refresh-stale-refresh',
    }
  })

  const result = await forceRefreshXaiOauthCredentials(home)
  expect(result?.accessToken).toBe('access-new-login')
  expect(readXaiOauthCredentials(home)?.refreshToken).toBe('refresh-new-login')
  expect(storageByHome.get(secureStorageKey(home))?.remoteAuth).toEqual({
    bearerToken: 'preserve-me',
  })
})

test('refresh adopts a sibling rotation instead of exchanging a stale token', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()
  const lockfileMod = await import('../../src/utils/lockfile.js')
  const { join } = await import('node:path')
  const { mkdir } = await import('node:fs/promises')

  saveXaiOauthCredentials(home, storedBlob())
  refreshMock.mockImplementation(async () => {
    throw new Error('endpoint must not be called when a sibling rotated')
  })

  // Simulate a sibling process holding the refresh lock: acquire the same
  // lock target first, start the refresh (it waits on lock retries), rotate
  // the stored grant "from the sibling", then release. The under-lock
  // re-read must observe the rotation and adopt it without hitting the
  // token endpoint.
  await mkdir(home.path, { recursive: true })
  const releaseSibling = await lockfileMod.lock(
    join(home.path, '.xai-oauth-refresh'),
    { realpath: false },
  )
  const pending = forceRefreshXaiOauthCredentials(home)
  await new Promise(resolve => setTimeout(resolve, 50))
  storageByHome.set(secureStorageKey(home), {
    xaiOauth: storedBlob({
      accessToken: 'access-sibling',
      refreshToken: 'refresh-sibling',
    }),
  })
  await releaseSibling()

  const result = await pending
  expect(result?.accessToken).toBe('access-sibling')
  expect(refreshMock).not.toHaveBeenCalled()
  expect(readXaiOauthCredentials(home)?.refreshToken).toBe('refresh-sibling')
})

test('terminal invalid_grant must not clobber a sibling rotation with quarantine', async () => {
  const module = await importFreshModule()
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthAccessToken,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = module
  const { XaiOauthError } = await vi.importActual<
    typeof import('../../src/services/xai/oauth.ts')
  >(oauthServiceModulePath)

  saveXaiOauthCredentials(home, storedBlob())
  // The exchange fails with terminal invalid_grant because a sibling
  // process consumed refresh-1 first — and by the time the failure lands,
  // the sibling has persisted its rotated grant. Quarantining now would
  // destroy the sibling's good credentials (the observed live failure:
  // grok session flaps to "Not logged in" mid-turn).
  refreshMock.mockImplementation(async () => {
    storageByHome.set(secureStorageKey(home), {
      xaiOauth: storedBlob({
        accessToken: 'access-sibling',
        refreshToken: 'refresh-sibling',
      }),
    })
    throw new XaiOauthError('invalid_grant', 'xAI OAuth error invalid_grant', 400)
  })

  const result = await forceRefreshXaiOauthCredentials(home)
  expect(result?.accessToken).toBe('access-sibling')
  const stored = readXaiOauthCredentials(home)
  expect(stored?.quarantinedAt).toBeUndefined()
  expect(stored?.refreshToken).toBe('refresh-sibling')
  expect(readXaiOauthAccessToken(home)).toBe('access-sibling')
})

test('xaiOauthRequiresRelogin distinguishes dead grants from viable ones', async () => {
  const { saveXaiOauthCredentials, xaiOauthRequiresRelogin, clearXaiOauthCredentials } =
    await importFreshModule()

  // No credentials at all → re-login required.
  expect(xaiOauthRequiresRelogin(home)).toBe(true)

  // Viable grant → no re-login.
  saveXaiOauthCredentials(home, storedBlob())
  expect(xaiOauthRequiresRelogin(home)).toBe(false)

  // Quarantined grant → re-login required.
  saveXaiOauthCredentials(
    home,
    storedBlob({ quarantinedAt: Date.now(), quarantineReason: 'invalid_grant' }),
  )
  expect(xaiOauthRequiresRelogin(home)).toBe(true)

  // Grant without a refresh token → re-login required.
  clearXaiOauthCredentials(home)
  saveXaiOauthCredentials(home, storedBlob({ refreshToken: undefined }))
  expect(xaiOauthRequiresRelogin(home)).toBe(true)
})

test('missing token endpoint falls back to discovery', async () => {
  const { forceRefreshXaiOauthCredentials, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(home, storedBlob({ tokenEndpoint: undefined }))
  discoveryMock.mockResolvedValue({
    authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
  })
  refreshMock.mockResolvedValue({ accessToken: 'access-2' })

  const refreshed = await forceRefreshXaiOauthCredentials(home)
  expect(refreshed?.accessToken).toBe('access-2')
  expect(discoveryMock).toHaveBeenCalledTimes(1)
})
