import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext, type HomeContext } from '../../src/config/home.js'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'

const CONFIG_MODULE = '../../src/utils/config.js'
const SECURE_STORAGE_MODULE = '../../src/utils/secureStorage/index.js'

const originalHome = process.env.AGENC_HOME
let home = ''
let secondHome = ''
let runtimeState: Record<string, unknown>
let vault: SecureStorageData
let vaults: Map<string, SecureStorageData>
let stateWrites = 0
let vaultWrites = 0
let failVaultWrite = false
let storageCalls = 0

async function loadAuthModule() {
  vi.resetModules()
  vi.doMock(CONFIG_MODULE, () => ({
    checkHasTrustDialogAccepted: () => true,
    getRuntimeState: () => runtimeState,
    updateRuntimeState: (
      updater: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      stateWrites++
      runtimeState = updater(runtimeState)
    },
  }))
  vi.doMock(SECURE_STORAGE_MODULE, () => ({
    getSecureStorage: (boundHome: HomeContext) => {
      storageCalls++
      const storageHome = boundHome.path
      return {
        name: 'test-native-vault',
        read: () => structuredClone(vaults.get(storageHome) ?? {}),
        readAsync: async () => structuredClone(vaults.get(storageHome) ?? {}),
        update: (next: SecureStorageData) => {
          vaultWrites++
          if (failVaultWrite) {
            return { success: false, warning: 'native vault unavailable' }
          }
          const stored = structuredClone(next)
          vaults.set(storageHome, stored)
          if (storageHome === home) vault = stored
          return { success: true }
        },
        delete: () => true,
      }
    },
  }))
  return import('../../src/utils/auth.js')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agenc-primary-key-'))
  secondHome = mkdtempSync(join(tmpdir(), 'agenc-primary-key-'))
  process.env.AGENC_HOME = home
  runtimeState = {
    customApiKeyResponses: { approved: [], rejected: [] },
  }
  vault = { agenc: { accessToken: 'unrelated-token' } }
  vaults = new Map([[home, vault]])
  stateWrites = 0
  vaultWrites = 0
  failVaultWrite = false
  storageCalls = 0
})

afterEach(() => {
  vi.doUnmock(CONFIG_MODULE)
  vi.doUnmock(SECURE_STORAGE_MODULE)
  vi.resetModules()
  if (originalHome === undefined) delete process.env.AGENC_HOME
  else process.env.AGENC_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
  rmSync(secondHome, { recursive: true, force: true })
})

describe('primary API-key native storage', () => {
  test('stores both the secret and its ambient-key approval only in the native vault', async () => {
    const { saveApiKey } = await loadAuthModule()

    await saveApiKey('sk_test-key')

    expect(vault.primaryApiKey).toBe('sk_test-key')
    expect(vault.agenc?.accessToken).toBe('unrelated-token')
    expect(vault.apiKeyApprovals).toEqual({
      approved: [expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)],
      rejected: [],
    })
    expect(runtimeState).not.toHaveProperty('primaryApiKey')
    expect(runtimeState.customApiKeyResponses).toEqual({ approved: [], rejected: [] })
    expect(stateWrites).toBe(0)
    expect(JSON.stringify(runtimeState)).not.toContain('sk_test-key')
    expect(storageCalls).toBeGreaterThan(0)
  })

  test('fails closed before touching state when the native vault rejects the write', async () => {
    failVaultWrite = true
    const { saveApiKey } = await loadAuthModule()

    await expect(saveApiKey('sk_test-key')).rejects.toThrow(
      /native vault unavailable/u,
    )
    expect(stateWrites).toBe(0)
    expect(runtimeState).not.toHaveProperty('primaryApiKey')
  })

  test('cannot authorize an ambient key through runtime-state edits', async () => {
    runtimeState.customApiKeyResponses = {
      approved: ['sha256:forged-state-entry'],
      rejected: [],
    }
    const { isCustomApiKeyApproved } = await loadAuthModule()

    expect(isCustomApiKeyApproved('sk_test-key')).toBe(false)
    expect(vaultWrites).toBe(0)
  })

  test('reads and removes the primary key without a plaintext fallback', async () => {
    vault.primaryApiKey = 'stored-key'
    const {
      getPrimaryApiKeyFromSecureStorage,
      removeApiKey,
    } = await loadAuthModule()

    const boundHome = resolveHomeContext({ AGENC_HOME: home })
    expect(getPrimaryApiKeyFromSecureStorage(boundHome)).toEqual({
      key: 'stored-key',
      source: '/login managed key',
    })
    await removeApiKey()

    expect(vault).not.toHaveProperty('primaryApiKey')
    expect(vault.agenc?.accessToken).toBe('unrelated-token')
    expect(stateWrites).toBe(0)
    expect(storageCalls).toBeGreaterThan(0)
  })

  test('binds primary-key reads to the explicit home without a process-global cache', async () => {
    const homeA = resolveHomeContext({ AGENC_HOME: home })
    const homeB = resolveHomeContext({ AGENC_HOME: secondHome })
    vaults.set(homeA.path, { primaryApiKey: 'home-a-key' })
    vaults.set(homeB.path, { primaryApiKey: 'home-b-key' })
    const { getPrimaryApiKeyFromSecureStorage } = await loadAuthModule()

    expect(getPrimaryApiKeyFromSecureStorage(homeA)?.key).toBe('home-a-key')
    expect(getPrimaryApiKeyFromSecureStorage(homeB)?.key).toBe('home-b-key')

    vaults.set(homeA.path, { primaryApiKey: 'home-a-newer-key' })
    expect(getPrimaryApiKeyFromSecureStorage(homeA)?.key).toBe('home-a-newer-key')
    expect(getPrimaryApiKeyFromSecureStorage(homeB)?.key).toBe('home-b-key')
  })
})
