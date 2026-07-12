import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type MockStorageData = Record<string, unknown>

const secureStorageModulePath = '../../src/utils/secureStorage/index.js'
const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
let storageState: MockStorageData = {}

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

  return import('../../src/utils/geminiCredentials.ts')
}

beforeEach(() => {
  process.env = { ...originalEnv }
  delete process.env.AGENC_SIMPLE
  delete process.env.GEMINI_ACCESS_TOKEN
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.AGENC_GEMINI_TOKEN_HYDRATED
  process.env.AGENC_USE_GEMINI = '1'
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageState = {}
})

afterEach(() => {
  process.env = { ...originalEnv }
  process.argv = [...originalArgv]
  storageState = {}
  vi.doUnmock(secureStorageModulePath)
  vi.clearAllMocks()
  vi.resetModules()
})

test('sets GEMINI_ACCESS_TOKEN from secure storage when env token empty', async () => {
  storageState = { gemini: { accessToken: 'stored-token-1' } }

  const { hydrateGeminiAccessTokenFromSecureStorage } =
    await importFreshModule()
  hydrateGeminiAccessTokenFromSecureStorage()

  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('stored-token-1')
  expect(process.env.AGENC_GEMINI_TOKEN_HYDRATED).toBe('1')
})

test('never overwrites a user-provided GEMINI_ACCESS_TOKEN', async () => {
  process.env.GEMINI_ACCESS_TOKEN = 'user-token'
  storageState = { gemini: { accessToken: 'stored-token-1' } }

  const { hydrateGeminiAccessTokenFromSecureStorage } =
    await importFreshModule()
  hydrateGeminiAccessTokenFromSecureStorage()
  hydrateGeminiAccessTokenFromSecureStorage()

  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('user-token')
  expect(process.env.AGENC_GEMINI_TOKEN_HYDRATED).toBeUndefined()
})

test('re-hydration refreshes a previously hydrated token after rotation', async () => {
  storageState = { gemini: { accessToken: 'stored-token-1' } }

  const { hydrateGeminiAccessTokenFromSecureStorage } =
    await importFreshModule()
  hydrateGeminiAccessTokenFromSecureStorage()
  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('stored-token-1')

  // Simulate a token refresh persisting a new token to secure storage
  // while the daemon keeps running.
  storageState = { gemini: { accessToken: 'stored-token-2' } }
  hydrateGeminiAccessTokenFromSecureStorage()

  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('stored-token-2')
  expect(process.env.AGENC_GEMINI_TOKEN_HYDRATED).toBe('1')
})

test('keeps the hydrated token when storage has no replacement', async () => {
  storageState = { gemini: { accessToken: 'stored-token-1' } }

  const { hydrateGeminiAccessTokenFromSecureStorage } =
    await importFreshModule()
  hydrateGeminiAccessTokenFromSecureStorage()
  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('stored-token-1')

  storageState = {}
  hydrateGeminiAccessTokenFromSecureStorage()

  expect(process.env.GEMINI_ACCESS_TOKEN).toBe('stored-token-1')
})

test('does nothing when a non access-token auth mode is selected', async () => {
  process.env.GEMINI_AUTH_MODE = 'adc'
  storageState = { gemini: { accessToken: 'stored-token-1' } }

  const { hydrateGeminiAccessTokenFromSecureStorage } =
    await importFreshModule()
  hydrateGeminiAccessTokenFromSecureStorage()

  expect(process.env.GEMINI_ACCESS_TOKEN).toBeUndefined()
})
