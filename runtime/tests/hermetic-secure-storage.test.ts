import { describe, expect, it } from 'vitest'

import { getSecureStorage } from '../src/utils/secureStorage/index.js'
import {
  ensureKeychainPrefetchCompleted,
  getLegacyApiKeyPrefetchResult,
  startKeychainPrefetch,
} from '../src/utils/secureStorage/keychainPrefetch.js'
import { isMacOsKeychainLocked } from '../src/utils/secureStorage/macOsKeychainStorage.js'

describe('hermetic secure-storage wiring', () => {
  it('never selects a native host vault in the default suite', async () => {
    expect(getSecureStorage().name).toBe('plaintext')
    expect(getSecureStorage({ allowPlainTextFallback: false }).name).toBe(
      'hermetic-unavailable-secure-storage',
    )

    startKeychainPrefetch()
    await expect(ensureKeychainPrefetchCompleted()).resolves.toBeUndefined()
    expect(getLegacyApiKeyPrefetchResult()).toEqual({ stdout: null })
    expect(isMacOsKeychainLocked()).toBe(false)
  })
})
