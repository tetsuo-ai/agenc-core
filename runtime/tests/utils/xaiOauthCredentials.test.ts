import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type MockStorageData = Record<string, unknown>

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const oauthServiceModulePath = '../../src/services/xai/oauth.js'
const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
let storageState: MockStorageData = {}

const refreshMock = vi.fn()
const discoveryMock = vi.fn()

async function importFreshModule() {
  vi.resetModules()
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: () => ({
      name: 'mock-secure-storage',
      read: () => storageState,
      readAsync: async () => storageState,
      update: (next: MockStorageData) => {
        storageState = next
        return { success: true }
      },
      delete: () => {
        storageState = {}
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
  delete process.env.AGENC_SIMPLE
  // Hermetic per-test home for the cross-process refresh lock.
  // AGENC_CONFIG_DIR (not AGENC_HOME) is what getAgenCConfigHomeDir prefers,
  // and the shared vitest setup already pins it per worker — override it per
  // test so lock contention cannot leak between tests. The memoize is keyed
  // off the env var, so each test dir gets a fresh value.
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.AGENC_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'xai-oauth-test-'))
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageState = {}
  refreshMock.mockReset()
  discoveryMock.mockReset()
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  storageState = {}
  vi.doUnmock(secureStorageModulePath)
  vi.doUnmock(oauthServiceModulePath)
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

  expect(readXaiOauthCredentials()).toBeUndefined()
  expect(saveXaiOauthCredentials(storedBlob()).success).toBe(true)
  expect(readXaiOauthAccessToken()).toBe('access-1')
  expect(readXaiOauthCredentials()?.refreshToken).toBe('refresh-1')
  expect(clearXaiOauthCredentials().success).toBe(true)
  expect(readXaiOauthCredentials()).toBeUndefined()
})

test('quarantined credentials do not surface a bearer', async () => {
  const { readXaiOauthAccessToken, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(
    storedBlob({ quarantinedAt: Date.now(), quarantineReason: 'invalid_grant' }),
  )
  expect(readXaiOauthAccessToken()).toBeUndefined()
})

test('isXaiOauthBearer matches only the stored access token', async () => {
  const { isXaiOauthBearer, saveXaiOauthCredentials } = await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
  expect(isXaiOauthBearer('access-1')).toBe(true)
  expect(isXaiOauthBearer('xai-real-api-key')).toBe(false)
  expect(isXaiOauthBearer(undefined)).toBe(false)
})

test('refreshIfNeeded no-ops when the token is far from expiry', async () => {
  const { refreshXaiOauthCredentialsIfNeeded, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
  const result = await refreshXaiOauthCredentialsIfNeeded()
  expect(result?.accessToken).toBe('access-1')
  expect(refreshMock).not.toHaveBeenCalled()
})

test('force refresh rotates tokens and persists them', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
  refreshMock.mockResolvedValue({
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: Date.now() + 6 * 3600 * 1000,
  })

  const refreshed = await forceRefreshXaiOauthCredentials()
  expect(refreshed?.accessToken).toBe('access-2')
  const stored = readXaiOauthCredentials()
  expect(stored?.accessToken).toBe('access-2')
  expect(stored?.refreshToken).toBe('refresh-2')
  expect(refreshMock).toHaveBeenCalledWith({
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    refreshToken: 'refresh-1',
  })
})

test('refresh response without a rotated token keeps the previous grant', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
  refreshMock.mockResolvedValue({ accessToken: 'access-2' })

  await forceRefreshXaiOauthCredentials()
  expect(readXaiOauthCredentials()?.refreshToken).toBe('refresh-1')
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

  saveXaiOauthCredentials(storedBlob())
  refreshMock.mockRejectedValue(
    new XaiOauthError('invalid_grant', 'xAI OAuth error invalid_grant', 400),
  )

  expect(await forceRefreshXaiOauthCredentials()).toBeUndefined()
  expect(readXaiOauthCredentials()?.quarantinedAt).toBeTypeOf('number')
  expect(readXaiOauthAccessToken()).toBeUndefined()

  // Quarantined: further refreshes bail without touching the endpoint.
  refreshMock.mockClear()
  expect(await forceRefreshXaiOauthCredentials()).toBeUndefined()
  expect(refreshMock).not.toHaveBeenCalled()
})

test('transient refresh failure leaves the blob untouched', async () => {
  const {
    forceRefreshXaiOauthCredentials,
    readXaiOauthCredentials,
    saveXaiOauthCredentials,
  } = await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
  refreshMock.mockRejectedValue(new Error('connection reset'))

  expect(await forceRefreshXaiOauthCredentials()).toBeUndefined()
  const stored = readXaiOauthCredentials()
  expect(stored?.accessToken).toBe('access-1')
  expect(stored?.quarantinedAt).toBeUndefined()
})

test('concurrent force refreshes share a single flight', async () => {
  const { forceRefreshXaiOauthCredentials, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(storedBlob())
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

  const first = forceRefreshXaiOauthCredentials()
  const second = forceRefreshXaiOauthCredentials()
  // The refresh now acquires a cross-process lock before hitting the
  // endpoint; wait for the exchange to actually start before releasing.
  await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  release(undefined)
  const [a, b] = await Promise.all([first, second])
  expect(a?.accessToken).toBe('access-2')
  expect(b?.accessToken).toBe('access-2')
  expect(refreshMock).toHaveBeenCalledTimes(1)
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

  saveXaiOauthCredentials(storedBlob())
  refreshMock.mockImplementation(async () => {
    throw new Error('endpoint must not be called when a sibling rotated')
  })

  // Simulate a sibling process holding the refresh lock: acquire the same
  // lock target first, start the refresh (it waits on lock retries), rotate
  // the stored grant "from the sibling", then release. The under-lock
  // re-read must observe the rotation and adopt it without hitting the
  // token endpoint.
  const { getAgenCConfigHomeDir } = await import('../../src/utils/envUtils.js')
  const home = getAgenCConfigHomeDir()
  await mkdir(home, { recursive: true })
  const releaseSibling = await lockfileMod.lock(
    join(home, '.xai-oauth-refresh'),
    { realpath: false },
  )
  const pending = forceRefreshXaiOauthCredentials()
  await new Promise(resolve => setTimeout(resolve, 50))
  storageState = {
    xaiOauth: storedBlob({
      accessToken: 'access-sibling',
      refreshToken: 'refresh-sibling',
    }),
  }
  await releaseSibling()

  const result = await pending
  expect(result?.accessToken).toBe('access-sibling')
  expect(refreshMock).not.toHaveBeenCalled()
  expect(readXaiOauthCredentials()?.refreshToken).toBe('refresh-sibling')
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

  saveXaiOauthCredentials(storedBlob())
  // The exchange fails with terminal invalid_grant because a sibling
  // process consumed refresh-1 first — and by the time the failure lands,
  // the sibling has persisted its rotated grant. Quarantining now would
  // destroy the sibling's good credentials (the observed live failure:
  // grok session flaps to "Not logged in" mid-turn).
  refreshMock.mockImplementation(async () => {
    storageState = {
      xaiOauth: storedBlob({
        accessToken: 'access-sibling',
        refreshToken: 'refresh-sibling',
      }),
    }
    throw new XaiOauthError('invalid_grant', 'xAI OAuth error invalid_grant', 400)
  })

  const result = await forceRefreshXaiOauthCredentials()
  expect(result?.accessToken).toBe('access-sibling')
  const stored = readXaiOauthCredentials()
  expect(stored?.quarantinedAt).toBeUndefined()
  expect(stored?.refreshToken).toBe('refresh-sibling')
  expect(readXaiOauthAccessToken()).toBe('access-sibling')
})

test('xaiOauthRequiresRelogin distinguishes dead grants from viable ones', async () => {
  const { saveXaiOauthCredentials, xaiOauthRequiresRelogin, clearXaiOauthCredentials } =
    await importFreshModule()

  // No credentials at all → re-login required.
  expect(xaiOauthRequiresRelogin()).toBe(true)

  // Viable grant → no re-login.
  saveXaiOauthCredentials(storedBlob())
  expect(xaiOauthRequiresRelogin()).toBe(false)

  // Quarantined grant → re-login required.
  saveXaiOauthCredentials(
    storedBlob({ quarantinedAt: Date.now(), quarantineReason: 'invalid_grant' }),
  )
  expect(xaiOauthRequiresRelogin()).toBe(true)

  // Grant without a refresh token → re-login required.
  clearXaiOauthCredentials()
  saveXaiOauthCredentials(storedBlob({ refreshToken: undefined }))
  expect(xaiOauthRequiresRelogin()).toBe(true)
})

test('missing token endpoint falls back to discovery', async () => {
  const { forceRefreshXaiOauthCredentials, saveXaiOauthCredentials } =
    await importFreshModule()

  saveXaiOauthCredentials(storedBlob({ tokenEndpoint: undefined }))
  discoveryMock.mockResolvedValue({
    authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
  })
  refreshMock.mockResolvedValue({ accessToken: 'access-2' })

  const refreshed = await forceRefreshXaiOauthCredentials()
  expect(refreshed?.accessToken).toBe('access-2')
  expect(discoveryMock).toHaveBeenCalledTimes(1)
})
