import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'
import { AgenCAuthProvider, getServerKey } from './auth.js'
import type { McpSSEServerConfig } from './types.js'
import { performCrossAppAccess } from './xaa.js'
import * as lockfile from '../../utils/lockfile.js'

const probes = vi.hoisted(() => {
  const release = vi.fn(async () => {})
  return {
    release,
    lock: vi.fn(async () => release),
    storageData: null as SecureStorageData | null,
    update: vi.fn((data: SecureStorageData) => {
      probes.storageData = data
      return { success: true }
    }),
    clearKeychainCache: vi.fn(),
    getCachedIdpIdToken: vi.fn(() => 'id-token'),
    getIdpClientSecret: vi.fn(() => 'idp-secret'),
    discoverOidc: vi.fn(async () => ({
      token_endpoint: 'https://agenc.tech/idp/token',
    })),
    getXaaIdpSettings: vi.fn(() => ({
      issuer: 'https://agenc.tech/idp',
      clientId: 'idp-client',
    })),
    clearIdpIdToken: vi.fn(),
    logMCPDebug: vi.fn(),
    logEvent: vi.fn(),
    sleep: vi.fn(async () => {}),
  }
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/envUtils.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/envUtils.js')>()),
  getAgenCConfigHomeDir: () => '/tmp/agenc-mcp-auth-test',
}))

vi.mock('../../utils/lockfile.js', () => ({
  lock: probes.lock,
}))

vi.mock('../../utils/log.js', () => ({
  logMCPDebug: probes.logMCPDebug,
}))

vi.mock('../analytics/index.js', () => ({
  logEvent: probes.logEvent,
}))

vi.mock('../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    name: 'test-secure-storage',
    read: () => probes.storageData,
    readAsync: async () => probes.storageData,
    update: probes.update,
    delete: () => true,
  }),
}))

vi.mock('../../utils/secureStorage/macOsKeychainHelpers.js', () => ({
  clearKeychainCache: probes.clearKeychainCache,
}))

vi.mock('../../utils/sleep.js', () => ({
  sleep: probes.sleep,
}))

vi.mock('./xaaIdpLogin.js', () => ({
  acquireIdpIdToken: vi.fn(),
  clearIdpIdToken: probes.clearIdpIdToken,
  discoverOidc: probes.discoverOidc,
  getCachedIdpIdToken: probes.getCachedIdpIdToken,
  getIdpClientSecret: probes.getIdpClientSecret,
  getXaaIdpSettings: probes.getXaaIdpSettings,
  isXaaEnabled: () => true,
}))

vi.mock('./xaa.js', () => ({
  XaaTokenExchangeError: class XaaTokenExchangeError extends Error {
    constructor(
      message: string,
      readonly shouldClearIdToken = false,
    ) {
      super(message)
    }
  },
  performCrossAppAccess: vi.fn(),
}))

vi.mock('./utils.js', () => ({
  getLoggingSafeMcpBaseUrl: (url: string) => url,
}))

const mockPerformCrossAppAccess = vi.mocked(performCrossAppAccess)
const mockLock = vi.mocked(lockfile.lock)

function serverConfig(): McpSSEServerConfig {
  return {
    type: 'sse',
    url: 'https://agenc.tech/mcp',
    oauth: {
      clientId: 'mcp-client',
      xaa: true,
    },
  }
}

function makeProvider(config = serverConfig()): AgenCAuthProvider {
  return new AgenCAuthProvider(
    'github',
    config,
    'http://127.0.0.1:3000/callback',
    false,
    undefined,
    true,
  )
}

function clientSecretStorage(
  key: string,
  mcpOAuth: SecureStorageData['mcpOAuth'] = {},
): SecureStorageData {
  return {
    mcpOAuth,
    mcpOAuthClientConfig: {
      [key]: {
        clientSecret: 'mcp-secret',
      },
    },
  }
}

async function runXaaRefresh(
  provider: AgenCAuthProvider,
): Promise<unknown> {
  return (provider as unknown as { xaaRefresh(): Promise<unknown> }).xaaRefresh()
}

function createDeferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AgenCAuthProvider XAA refresh locking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.release.mockClear()
    probes.lock.mockReset()
    probes.lock.mockResolvedValue(probes.release)
    probes.storageData = null
    mockPerformCrossAppAccess.mockReset()
    probes.getCachedIdpIdToken.mockReturnValue('id-token')
    probes.getIdpClientSecret.mockReturnValue('idp-secret')
    probes.getXaaIdpSettings.mockReturnValue({
      issuer: 'https://agenc.tech/idp',
      clientId: 'idp-client',
    })
    probes.discoverOidc.mockResolvedValue({
      token_endpoint: 'https://agenc.tech/idp/token',
    })
  })

  it('reuses tokens another process refreshed while waiting for the lock', async () => {
    const config = serverConfig()
    const key = getServerKey('github', config)
    const lockEntered = createDeferred()
    const releaseLock = createDeferred()
    probes.storageData = clientSecretStorage(key)
    probes.lock.mockImplementationOnce(async () => {
      lockEntered.resolve()
      await releaseLock.promise
      return probes.release
    })

    const resultPromise = runXaaRefresh(makeProvider(config))
    await lockEntered.promise
    probes.storageData = clientSecretStorage(key, {
      [key]: {
        serverName: 'github',
        serverUrl: config.url,
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: 'openid',
      },
    })
    releaseLock.resolve()
    const result = await resultPromise

    expect(mockLock).toHaveBeenCalledWith(
      expect.stringContaining(`mcp-refresh-${key.replace(/[^a-zA-Z0-9]/g, '_')}.lock`),
      expect.objectContaining({ realpath: false }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        token_type: 'Bearer',
      }),
    )
    expect(mockPerformCrossAppAccess).not.toHaveBeenCalled()
    expect(probes.release).toHaveBeenCalledOnce()
  })

  it('serializes the XAA exchange and releases the refresh lock after storing tokens', async () => {
    const config = serverConfig()
    const key = getServerKey('github', config)
    probes.storageData = clientSecretStorage(key)
    mockPerformCrossAppAccess.mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'openid profile',
      authorizationServerUrl: 'https://agenc.tech/as',
    })

    const result = await runXaaRefresh(makeProvider(config))

    expect(mockLock).toHaveBeenCalledOnce()
    expect(mockPerformCrossAppAccess).toHaveBeenCalledWith(
      config.url,
      expect.objectContaining({
        clientId: 'mcp-client',
        clientSecret: 'mcp-secret',
        idpClientId: 'idp-client',
        idpClientSecret: 'idp-secret',
        idpIdToken: 'id-token',
        idpTokenEndpoint: 'https://agenc.tech/idp/token',
      }),
      'github',
    )
    expect(result).toEqual(
      expect.objectContaining({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      }),
    )
    expect(probes.storageData?.mcpOAuth?.[key]).toEqual(
      expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        clientId: 'mcp-client',
        clientSecret: 'mcp-secret',
      }),
    )
    expect(probes.release).toHaveBeenCalledOnce()
    expect(probes.update.mock.invocationCallOrder[0]).toBeLessThan(
      probes.release.mock.invocationCallOrder[0],
    )
  })

  it('does not start XAA exchange when the refresh lock stays contended', async () => {
    const config = serverConfig()
    const key = getServerKey('github', config)
    const locked = Object.assign(new Error('locked'), { code: 'ELOCKED' })
    probes.storageData = clientSecretStorage(key)
    probes.lock.mockRejectedValue(locked)

    await expect(runXaaRefresh(makeProvider(config))).rejects.toThrow(
      'Could not acquire MCP refresh lock',
    )

    expect(mockPerformCrossAppAccess).not.toHaveBeenCalled()
    expect(probes.update).not.toHaveBeenCalled()
    expect(probes.release).not.toHaveBeenCalled()
    expect(probes.sleep).toHaveBeenCalled()
  })
})
