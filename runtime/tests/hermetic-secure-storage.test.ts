import { describe, expect, it } from 'vitest'

import { getSecureStorage } from '../src/utils/secureStorage/index.js'
import { isMacOsKeychainLocked } from '../src/utils/secureStorage/macOsKeychainStorage.js'
import { resolveSecureStorageHome } from '../src/utils/secureStorage/home.js'

describe('hermetic secure-storage wiring', () => {
  it('never selects native host secure storage in the default suite', async () => {
    expect(getSecureStorage(resolveSecureStorageHome(process.env)).name).toBe(
      'hermetic-native-secure-storage',
    )

    expect(isMacOsKeychainLocked()).toBe(false)
  })
})
