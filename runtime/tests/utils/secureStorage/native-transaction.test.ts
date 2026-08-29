import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../../src/config/home.js'
import { getSecureStorage } from '../../../src/utils/secureStorage/index.js'
import {
  NativeSecureStorageError,
  rollbackNativeSecureStorage,
  updateNativeSecureStorage,
} from '../../../src/utils/secureStorage/native.js'
import type {
  SecureStorage,
  SecureStorageData,
} from '../../../src/utils/secureStorage/index.js'
import { createTempWorkspaceFixture } from '../../helpers/temp-workspace.js'

const fixture = createTempWorkspaceFixture('agenc-native-secure-storage-')
const getSecureStorageMock = vi.mocked(getSecureStorage)
const hermeticStorageFactory = getSecureStorageMock.getMockImplementation()

describe('native secure storage transactions', () => {
  beforeEach(() => {
    if (!hermeticStorageFactory) {
      throw new Error('Expected the hermetic secure-storage mock')
    }
    getSecureStorageMock.mockImplementation(hermeticStorageFactory)
  })

  afterEach(async () => {
    if (hermeticStorageFactory) {
      getSecureStorageMock.mockImplementation(hermeticStorageFactory)
    }
    await fixture.cleanup()
  })

  async function home() {
    const path = await fixture.create()
    return resolveHomeContext({ AGENC_HOME: path }, { platformHome: '/unused' })
  }

  test('preserves unrelated namespaces in a shared-storage read-modify-write', async () => {
    const boundHome = await home()
    const original: SecureStorageData = {
      primaryApiKey: 'old-primary',
      mcpOAuth: {
        server: {
          serverName: 'server',
          serverUrl: 'https://example.test',
          accessToken: 'mcp-token',
          expiresAt: 42,
        },
      },
    }
    let stored = structuredClone(original)
    const storage: SecureStorage = {
      name: 'seeded-secure-storage',
      // Simulate a stale ordinary macOS cache that predates an unrelated
      // writer. Locked RMW must use readFresh and preserve the MCP namespace.
      read: () => ({ primaryApiKey: 'stale-primary' }),
      readFresh: () => structuredClone(stored),
      readAsync: async () => structuredClone(stored),
      update: next => {
        stored = structuredClone(next)
        return { success: true }
      },
      delete: () => true,
    }
    getSecureStorageMock.mockReturnValue(storage)

    updateNativeSecureStorage(
      boundHome,
      current => ({ ...current, primaryApiKey: 'new-primary' }),
      'could not update credentials',
    )

    expect(stored.primaryApiKey).toBe('new-primary')
    expect(stored.mcpOAuth).toEqual(original.mcpOAuth)
  })

  test('never writes when the secure-storage read fails', async () => {
    const boundHome = await home()
    const update = vi.fn(() => ({ success: true }))
    getSecureStorageMock.mockReturnValue({
      name: 'unreadable-secure-storage',
      read: () => {
        throw new Error('decrypt failed')
      },
      readAsync: async () => {
        throw new Error('decrypt failed')
      },
      update,
      delete: () => true,
    })

    expect(() =>
      updateNativeSecureStorage(
        boundHome,
        current => ({ ...current, primaryApiKey: 'must-not-write' }),
        'could not update credentials',
      ),
    ).toThrow(NativeSecureStorageError)
    expect(update).not.toHaveBeenCalled()
  })

  test('never performs a compensating write when rollback cannot read', async () => {
    const boundHome = await home()
    const update = vi.fn(() => ({ success: true }))
    getSecureStorageMock.mockReturnValue({
      name: 'unreadable-secure-storage',
      read: () => {
        throw new Error('native secure storage unavailable')
      },
      readAsync: async () => {
        throw new Error('native secure storage unavailable')
      },
      update,
      delete: () => true,
    })

    expect(() =>
      rollbackNativeSecureStorage(
        boundHome,
        {
          previous: { primaryApiKey: 'before' },
          written: { primaryApiKey: 'after' },
        },
        current => ({ ...current, primaryApiKey: 'before' }),
        'could not roll back credentials',
      ),
    ).toThrow(NativeSecureStorageError)
    expect(update).not.toHaveBeenCalled()
  })
})
