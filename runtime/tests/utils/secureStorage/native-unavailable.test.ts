import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../../src/config/home.js'
import {
  getSecureStorage,
  type SecureStorage,
} from '../../../src/utils/secureStorage/index.js'
import { SecureStorageUnavailableError } from '../../../src/utils/secureStorage/unavailable.js'
import {
  NativeSecureStorageError,
  NativeSecureStorageUnavailableError,
  readNativeSecureStorage,
  readNativeSecureStorageAsync,
  readNativeSecureStorageFresh,
  resetNativeSecureStorageUnavailableWarningForTest,
  updateNativeSecureStorage,
} from '../../../src/utils/secureStorage/native.js'
import { createTempWorkspaceFixture } from '../../helpers/temp-workspace.js'

const fixture = createTempWorkspaceFixture('agenc-native-unavailable-')
const getSecureStorageMock = vi.mocked(getSecureStorage)
const hermeticStorageFactory = getSecureStorageMock.getMockImplementation()

/** A host with no Secret Service at all: every backend call reports absence. */
const absentBackend: SecureStorage = {
  name: 'absent-libsecret',
  read: () => {
    throw new SecureStorageUnavailableError(
      'Secret Service is unavailable: libsecret-1.so.0: cannot open shared object file',
    )
  },
  readFresh: () => {
    throw new SecureStorageUnavailableError(
      'Secret Service is unavailable: libsecret-1.so.0: cannot open shared object file',
    )
  },
  readAsync: async () => {
    throw new SecureStorageUnavailableError(
      'Secret Service is unavailable: libsecret-1.so.0: cannot open shared object file',
    )
  },
  update: () => ({ success: false, warning: 'no backend' }),
  delete: () => true,
}

describe('native secure storage on a host without a backend', () => {
  beforeEach(() => {
    if (!hermeticStorageFactory) throw new Error('Expected the hermetic secure-storage mock')
    getSecureStorageMock.mockReturnValue(absentBackend)
    resetNativeSecureStorageUnavailableWarningForTest()
  })

  afterEach(async () => {
    if (hermeticStorageFactory) getSecureStorageMock.mockImplementation(hermeticStorageFactory)
    await fixture.cleanup()
  })

  async function home() {
    const path = await fixture.create()
    return resolveHomeContext({ AGENC_HOME: path }, { platformHome: '/unused' })
  }

  test('plain reads answer empty and warn once, so environment credentials keep working', async () => {
    const boundHome = await home()
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
    try {
      expect(readNativeSecureStorage(boundHome)).toEqual({})
      expect(readNativeSecureStorage(boundHome)).toEqual({})
      expect(await readNativeSecureStorageAsync(boundHome)).toEqual({})
    } finally {
      spy.mockRestore()
    }
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('native secure storage is unavailable on this host')
    expect(writes[0]).toContain('libsecret-1.so.0')
  })

  test('fresh reads and writes stay fail-closed', async () => {
    const boundHome = await home()
    expect(() => readNativeSecureStorageFresh(boundHome)).toThrow(NativeSecureStorageUnavailableError)
    expect(() => readNativeSecureStorageFresh(boundHome)).toThrow(NativeSecureStorageError)
    expect(() =>
      updateNativeSecureStorage(boundHome, (current) => ({ ...current, primaryApiKey: 'k' }), 'no storage'),
    ).toThrow(NativeSecureStorageError)
  })
})
