import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext, type HomeContext } from '../../src/config/home.js'
import type { StatusNoticeContext } from '../../src/tui/startup/statusNoticeDefinitions.js'
import type { SecureStorageData } from '../../src/utils/secureStorage/index.js'

const CONFIG_MODULE = '../../src/utils/config.js'
const SECURE_STORAGE_MODULE = '../../src/utils/secureStorage/index.js'
const ENV_UTILS_MODULE = '../../src/utils/envUtils.js'
const PROVIDERS_MODULE = '../../src/utils/model/providers.js'

const originalHome = process.env.AGENC_HOME
const originalNodeEnv = process.env.NODE_ENV
let home = ''
let secondHome = ''
let runtimeState: Record<string, unknown>
let storedData: SecureStorageData
let storageByHome: Map<string, SecureStorageData>
let stateWrites = 0
let secureStorageWrites = 0
let failSecureStorageWrite = false
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
        name: 'test-native-secure-storage',
        read: () => structuredClone(storageByHome.get(storageHome) ?? {}),
        readAsync: async () =>
          structuredClone(storageByHome.get(storageHome) ?? {}),
        update: (next: SecureStorageData) => {
          secureStorageWrites++
          if (failSecureStorageWrite) {
            return { success: false, warning: 'native secure storage unavailable' }
          }
          const stored = structuredClone(next)
          storageByHome.set(storageHome, stored)
          if (storageHome === home) storedData = stored
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
  storedData = { agenc: { accessToken: 'unrelated-token' } }
  storageByHome = new Map([[home, storedData]])
  stateWrites = 0
  secureStorageWrites = 0
  failSecureStorageWrite = false
  storageCalls = 0
})

afterEach(() => {
  vi.doUnmock(CONFIG_MODULE)
  vi.doUnmock(SECURE_STORAGE_MODULE)
  vi.doUnmock(ENV_UTILS_MODULE)
  vi.doUnmock(PROVIDERS_MODULE)
  vi.resetModules()
  if (originalHome === undefined) delete process.env.AGENC_HOME
  else process.env.AGENC_HOME = originalHome
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  rmSync(home, { recursive: true, force: true })
  rmSync(secondHome, { recursive: true, force: true })
})

describe('primary API-key native storage', () => {
  test.each(['test', 'production'] as const)(
    'does not read Anthropic credentials for an external provider in %s mode',
    async nodeEnv => {
      process.env.NODE_ENV = nodeEnv
      const {
        getAnthropicApiKeyWithSourceForContext,
        getAuthTokenSourceForContext,
        isAgenCAISubscriberForContext,
        isAnthropicAuthEnabledForContext,
      } = await loadAuthModule()
      const boundHome = resolveHomeContext({ AGENC_HOME: home })
      const context = {
        home: boundHome,
        environment: {
          AGENC_OAUTH_TOKEN: 'irrelevant-agenc-token',
          ANTHROPIC_API_KEY: 'irrelevant-anthropic-key',
          ANTHROPIC_AUTH_TOKEN: 'irrelevant-anthropic-token',
        },
        provider: 'openai-compatible',
      }

      expect(
        isAnthropicAuthEnabledForContext(context),
      ).toBe(false)
      expect(getAnthropicApiKeyWithSourceForContext(context)).toEqual({
        key: null,
        source: 'none',
      })
      expect(getAuthTokenSourceForContext(context)).toEqual({
        source: 'none',
        hasToken: false,
      })
      expect(isAgenCAISubscriberForContext(context)).toBe(false)
      const { getActiveNotices } = await import(
        '../../src/tui/startup/statusNoticeDefinitions.js'
      )
      expect(
        getActiveNotices({
          config: {} as StatusNoticeContext['config'],
          homeContext: boundHome,
          providerAuthContext: context,
          memoryDiagnostics: [],
          daemonStatus: { autostartDisabled: false },
        }),
      ).toEqual([])
      expect(storageCalls).toBe(0)
    },
  )

  test.each(['test', 'production'] as const)(
    'does not inspect persisted credentials for an external provider in %s mode',
    async nodeEnv => {
      process.env.NODE_ENV = nodeEnv
      storedData.primaryApiKey = 'irrelevant-stored-key'
      storedData.agenc = {
        accessToken: 'irrelevant-stored-token',
      }
      const {
        getAnthropicApiKeyWithSourceForContext,
        getAuthTokenSourceForContext,
      } = await loadAuthModule()
      const context = {
        home: resolveHomeContext({ AGENC_HOME: home }),
        environment: { XAI_API_KEY: 'provider-owned-key' },
        provider: 'grok',
      }

      expect(getAnthropicApiKeyWithSourceForContext(context)).toEqual({
        key: null,
        source: 'none',
      })
      expect(getAuthTokenSourceForContext(context)).toEqual({
        source: 'none',
        hasToken: false,
      })
      expect(storageCalls).toBe(0)
    },
  )

  test.each(['test', 'production'] as const)(
    'keeps an external provider off the ssh auth proxy path in %s mode',
    async nodeEnv => {
      process.env.NODE_ENV = nodeEnv
      storedData.agencAiOauth = { accessToken: 'irrelevant-stored-token' }
      const {
        isAgenCAISubscriberForContext,
        isAnthropicAuthEnabledForContext,
      } = await loadAuthModule()
      const boundHome = resolveHomeContext({ AGENC_HOME: home })
      const proxyEnvironment = {
        AGENC_OAUTH_TOKEN: 'proxy-placeholder-token',
        ANTHROPIC_UNIX_SOCKET: '/tmp/agenc-ssh-auth.sock',
      }

      expect(
        isAnthropicAuthEnabledForContext({
          home: boundHome,
          environment: { ...proxyEnvironment, XAI_API_KEY: 'provider-owned-key' },
          provider: 'grok',
        }),
      ).toBe(false)
      expect(
        isAgenCAISubscriberForContext({
          home: boundHome,
          environment: { ...proxyEnvironment, XAI_API_KEY: 'provider-owned-key' },
          provider: 'grok',
        }),
      ).toBe(false)
      expect(storageCalls).toBe(0)

      // The proxy placeholder still decides the first-party case.
      expect(
        isAnthropicAuthEnabledForContext({
          home: boundHome,
          environment: proxyEnvironment,
          provider: 'anthropic',
        }),
      ).toBe(true)
      expect(
        isAnthropicAuthEnabledForContext({
          home: boundHome,
          environment: { ANTHROPIC_UNIX_SOCKET: '/tmp/agenc-ssh-auth.sock' },
          provider: 'anthropic',
        }),
      ).toBe(false)
    },
  )

  test.each(['test', 'production'] as const)(
    'keeps proxy account lookups off native storage for an external provider in %s mode',
    async nodeEnv => {
      process.env.NODE_ENV = nodeEnv
      storedData.agencAiOauth = { accessToken: 'irrelevant-stored-token' }
      storedData.oauthAccountMetadata = {
        accountUuid: 'irrelevant-account',
        emailAddress: 'irrelevant@example.com',
        organizationUuid: 'irrelevant-org',
      }
      vi.doMock(PROVIDERS_MODULE, async importOriginal => {
        const actual = await importOriginal<
          typeof import('../../src/utils/model/providers.ts')
        >()
        return {
          ...actual,
          getSelectedProviderName: () => 'grok',
          getSelectedProviderEnvironment: () => ({
            AGENC_OAUTH_TOKEN: 'proxy-placeholder-token',
            ANTHROPIC_UNIX_SOCKET: '/tmp/agenc-ssh-auth.sock',
            XAI_API_KEY: 'provider-owned-key',
          }),
        }
      })
      const { getOauthAccountInfo, isAnthropicAuthEnabled } =
        await loadAuthModule()
      const boundHome = resolveHomeContext({ AGENC_HOME: home })

      expect(isAnthropicAuthEnabled()).toBe(false)
      expect(getOauthAccountInfo(boundHome)).toBeUndefined()
      expect(storageCalls).toBe(0)
    },
  )

  test('bare mode keeps the canonical saved credential authority', async () => {
    storedData.primaryApiKey = 'stored-bare-key'
    vi.doMock(ENV_UTILS_MODULE, async importOriginal => {
      const actual = await importOriginal<
        typeof import('../../src/utils/envUtils.ts')
      >()
      return { ...actual, isBareMode: () => true }
    })
    const {
      getAnthropicApiKeyWithSourceForContext,
      getPrimaryApiKeyFromSecureStorage,
    } = await loadAuthModule()
    const boundHome = resolveHomeContext({ AGENC_HOME: home })

    expect(getPrimaryApiKeyFromSecureStorage(boundHome)).toEqual({
      key: 'stored-bare-key',
      source: '/login managed key',
    })
    process.env.NODE_ENV = 'production'
    expect(
      getAnthropicApiKeyWithSourceForContext({
        home: boundHome,
        environment: {},
        provider: 'anthropic',
      }),
    ).toEqual({
      key: 'stored-bare-key',
      source: '/login managed key',
    })
  })

  test('stores both the secret and its ambient-key approval only in the native secure storage', async () => {
    const { saveApiKey } = await loadAuthModule()

    await saveApiKey('sk_test-key')

    expect(storedData.primaryApiKey).toBe('sk_test-key')
    expect(storedData.agenc?.accessToken).toBe('unrelated-token')
    expect(storedData.apiKeyApprovals).toEqual({
      approved: [expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)],
      rejected: [],
    })
    expect(runtimeState).not.toHaveProperty('primaryApiKey')
    expect(runtimeState.customApiKeyResponses).toEqual({ approved: [], rejected: [] })
    expect(stateWrites).toBe(0)
    expect(JSON.stringify(runtimeState)).not.toContain('sk_test-key')
    expect(storageCalls).toBeGreaterThan(0)
  })

  test('fails closed before touching state when the native secure storage rejects the write', async () => {
    failSecureStorageWrite = true
    const { saveApiKey } = await loadAuthModule()

    await expect(saveApiKey('sk_test-key')).rejects.toThrow(
      /native secure storage unavailable/u,
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
    expect(secureStorageWrites).toBe(0)
  })

  test('reads and removes the primary key without a plaintext fallback', async () => {
    storedData.primaryApiKey = 'stored-key'
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

    expect(storedData).not.toHaveProperty('primaryApiKey')
    expect(storedData.agenc?.accessToken).toBe('unrelated-token')
    expect(stateWrites).toBe(0)
    expect(storageCalls).toBeGreaterThan(0)
  })

  test('binds primary-key reads to the explicit home without a process-global cache', async () => {
    const homeA = resolveHomeContext({ AGENC_HOME: home })
    const homeB = resolveHomeContext({ AGENC_HOME: secondHome })
    storageByHome.set(homeA.path, { primaryApiKey: 'home-a-key' })
    storageByHome.set(homeB.path, { primaryApiKey: 'home-b-key' })
    const { getPrimaryApiKeyFromSecureStorage } = await loadAuthModule()

    expect(getPrimaryApiKeyFromSecureStorage(homeA)?.key).toBe('home-a-key')
    expect(getPrimaryApiKeyFromSecureStorage(homeB)?.key).toBe('home-b-key')

    storageByHome.set(homeA.path, { primaryApiKey: 'home-a-newer-key' })
    expect(getPrimaryApiKeyFromSecureStorage(homeA)?.key).toBe('home-a-newer-key')
    expect(getPrimaryApiKeyFromSecureStorage(homeB)?.key).toBe('home-b-key')
  })
})
