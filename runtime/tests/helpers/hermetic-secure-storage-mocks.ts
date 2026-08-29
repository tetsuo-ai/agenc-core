import { vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The default suite must not query the host's Keychain, Secret Service, or
// Windows credential infrastructure. Tests for those adapters import them
// directly with explicit subprocess mocks; ordinary runtime consumers get an
// isolated in-memory native secure storage stand-in.
vi.mock('../../src/utils/secureStorage/index.js', () => {
  type Data = import('../../src/utils/secureStorage/index.js').SecureStorageData
  type Identity = import('../../src/utils/secureStorage/index.js').SecureStorageMigrationIdentity
  type Home = import('../../src/config/home.js').HomeContext
  const dataByHome = new Map<string, Data | null>()
  const canonicalStorageKey = (home: Home): string => {
    // Match the identity inputs used by the real adapters, rather than keying
    // only by path. A local/custom OAuth run at the same AGENC_HOME is a
    // different native record, while Linux/macOS default homes intentionally
    // share the historical unscoped service name.
    const serviceScope = process.platform === 'win32'
      ? home.identityKey
      : home.isDefault
        ? 'default-service'
        : home.identityKey
    return `canonical:${serviceScope}\0${home.oauthFileSuffix}\0${home.secureStorageAccount}`
  }
  const storageFor = (home?: Home, explicitKey?: string) => {
    const key = explicitKey ?? (home === undefined
      ? process.env.AGENC_HOME?.trim() || join(homedir(), '.agenc')
      : canonicalStorageKey(home))
    return {
      name: 'hermetic-native-secure-storage',
      read: () => {
        const data = dataByHome.get(key) ?? null
        return data === null ? null : structuredClone(data)
      },
      readFresh: () => {
        const data = dataByHome.get(key) ?? null
        return data === null ? null : structuredClone(data)
      },
      readAsync: async () => {
        const data = dataByHome.get(key) ?? null
        return data === null ? null : structuredClone(data)
      },
      update: (next: Data) => {
        dataByHome.set(key, structuredClone(next))
        return { success: true }
      },
      delete: () => {
        if (home === undefined) dataByHome.clear()
        else dataByHome.delete(key)
        return true
      },
    }
  }
  const migrationStorageFor = (home: Home, identity: Identity) => {
    // Keychain and Secret Service records are scoped by the per-user service
    // identity, not by AGENC_HOME. Keep that sharing visible in tests so a
    // relocated home cannot accidentally treat the old unscoped native record
    // as its private record. DPAPI is an actual home-relative file.
    const key = process.platform === 'win32'
      ? `${identity.homePath}\0${identity.serviceName}\0${identity.accountName}`
      : `native-service:${identity.serviceName}\0${identity.accountName}`
    return storageFor(home, key)
  }
  return {
    getSecureStorage: vi.fn((home?: Home) => storageFor(home)),
    getSecureStorageForMigration: vi.fn(
      (home: Home, identity: Identity) => migrationStorageFor(home, identity),
    ),
  }
})
