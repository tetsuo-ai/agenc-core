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

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.AGENC_SIMPLE
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
  release(undefined)
  const [a, b] = await Promise.all([first, second])
  expect(a?.accessToken).toBe('access-2')
  expect(b?.accessToken).toBe('access-2')
  expect(refreshMock).toHaveBeenCalledTimes(1)
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
