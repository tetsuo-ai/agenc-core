import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveHomeContext } from '../../src/config/home.js'

type MockStorageData = Record<string, unknown>

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
const HOME_A = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-gemini-home-a' },
  { platformHome: '/tmp' },
)
const HOME_B = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-gemini-home-b' },
  { platformHome: '/tmp' },
)
let storageByHome = new Map<string, MockStorageData>()

async function importFreshModule() {
  vi.resetModules()
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: { path: string }) => ({
      name: 'mock-secure-storage',
      read: () => storageByHome.get(home.path) ?? {},
      readAsync: async () => storageByHome.get(home.path) ?? {},
      update: (next: MockStorageData) => {
        storageByHome.set(home.path, next)
        return { success: true }
      },
      delete: () => {
        storageByHome.delete(home.path)
        return true
      },
    }),
  }))

  return import('../../src/utils/geminiCredentials.ts')
}

beforeEach(() => {
  process.env = { ...originalEnv }
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageByHome = new Map()
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  storageByHome = new Map()
  vi.doUnmock(secureStorageModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

test('saveGeminiAccessToken stores and reads back the token', async () => {
  const {
    readGeminiAccessToken,
    saveGeminiAccessToken,
  } = await importFreshModule()

  const result = saveGeminiAccessToken(HOME_A, 'token-123')
  expect(result.success).toBe(true)
  expect(readGeminiAccessToken(HOME_A)).toBe('token-123')
})

test('clearGeminiAccessToken removes the stored token', async () => {
  const {
    clearGeminiAccessToken,
    readGeminiAccessToken,
    saveGeminiAccessToken,
  } = await importFreshModule()

  expect(saveGeminiAccessToken(HOME_A, 'token-123').success).toBe(true)
  expect(clearGeminiAccessToken(HOME_A).success).toBe(true)
  expect(readGeminiAccessToken(HOME_A)).toBeUndefined()
})

test('homes are isolated and namespace mutations preserve unrelated secrets', async () => {
  const {
    clearGeminiAccessToken,
    readGeminiAccessToken,
    saveGeminiAccessToken,
  } = await importFreshModule()
  storageByHome.set(HOME_A.path, {
    remoteAuth: { bearerToken: 'remote-a' },
  })

  expect(saveGeminiAccessToken(HOME_A, 'gemini-a').success).toBe(true)
  expect(saveGeminiAccessToken(HOME_B, 'gemini-b').success).toBe(true)
  expect(readGeminiAccessToken(HOME_A)).toBe('gemini-a')
  expect(readGeminiAccessToken(HOME_B)).toBe('gemini-b')
  expect(storageByHome.get(HOME_A.path)?.remoteAuth).toEqual({
    bearerToken: 'remote-a',
  })

  expect(clearGeminiAccessToken(HOME_A).success).toBe(true)
  expect(readGeminiAccessToken(HOME_A)).toBeUndefined()
  expect(readGeminiAccessToken(HOME_B)).toBe('gemini-b')
  expect(storageByHome.get(HOME_A.path)?.remoteAuth).toEqual({
    bearerToken: 'remote-a',
  })
})
