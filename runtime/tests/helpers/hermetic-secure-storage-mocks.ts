import { vi } from 'vitest'

// The default suite must not query the host's Keychain, Secret Service, or
// Windows credential infrastructure. Tests for those adapters import them
// directly with explicit subprocess mocks; ordinary runtime consumers get an
// isolated plaintext fixture only when their production call allows fallback.
vi.mock('../../src/utils/secureStorage/index.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/utils/secureStorage/index.js')
  >()
  const { plainTextStorage } = await import(
    '../../src/utils/secureStorage/plainTextStorage.js'
  )
  const unavailable = {
    name: 'hermetic-unavailable-secure-storage',
    read: () => null,
    readAsync: async () => null,
    update: () => ({
      success: false,
      warning: 'Native secure storage is unavailable in hermetic tests.',
    }),
    delete: () => true,
  }
  return {
    ...original,
    getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) =>
      options?.allowPlainTextFallback === false
        ? unavailable
        : plainTextStorage,
  }
})

vi.mock(
  '../../src/utils/secureStorage/keychainPrefetch.js',
  async importOriginal => {
    const original = await importOriginal<
      typeof import('../../src/utils/secureStorage/keychainPrefetch.js')
    >()
    return {
      ...original,
      clearLegacyApiKeyPrefetch: () => undefined,
      ensureKeychainPrefetchCompleted: async () => undefined,
      getLegacyApiKeyPrefetchResult: () => ({ stdout: null }),
      startKeychainPrefetch: () => undefined,
    }
  },
)

vi.mock(
  '../../src/utils/secureStorage/macOsKeychainStorage.js',
  async importOriginal => {
    const original = await importOriginal<
      typeof import('../../src/utils/secureStorage/macOsKeychainStorage.js')
    >()
    return {
      ...original,
      isMacOsKeychainLocked: () => false,
    }
  },
)
