import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { SecureStorageData } from '../../utils/secureStorage/index.js'
import {
  AgenCAuthProvider,
  getServerKey,
  wrapFetchWithStepUpDetection,
} from './auth.js'
import type { McpSSEServerConfig } from './types.js'
import { performCrossAppAccess } from './xaa.js'
import * as lockfile from '../../utils/lockfile.js'
import { resolveHomeContext } from '../../config/home.js'

const TEST_HOME = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-mcp-auth-test' },
  { platformHome: '/tmp' },
)

const probes = vi.hoisted(() => {
  const release = vi.fn(async () => {})
  const releaseNative = vi.fn()
  return {
    release,
    releaseNative,
    lock: vi.fn(async () => release),
    lockSync: vi.fn(() => releaseNative),
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
    getXaaIdpConfig: vi.fn(() => ({
      issuer: 'https://agenc.tech/idp',
      client_id: 'idp-client',
    })),
    clearIdpIdToken: vi.fn(),
    refreshAuthorization: vi.fn(),
    logMCPDebug: vi.fn(),
    sleep: vi.fn(async () => {}),
  }
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@modelcontextprotocol/sdk/client/auth.js')
  >()),
  refreshAuthorization: probes.refreshAuthorization,
}))

vi.mock('../../utils/envUtils.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/envUtils.js')>()),
  getAgenCHomeDir: () => '/tmp/agenc-mcp-auth-test',
}))

vi.mock('../../utils/lockfile.js', () => ({
  lock: probes.lock,
  lockSync: probes.lockSync,
}))

vi.mock('../../utils/log.js', () => ({
  logMCPDebug: probes.logMCPDebug,
}))

vi.mock('../../utils/secureStorage/native.js', () => ({
  readNativeSecureStorage: () => structuredClone(probes.storageData ?? {}),
  updateNativeSecureStorage: (
    _home: unknown,
    update: (current: SecureStorageData) => SecureStorageData,
  ) => {
    const next = update(structuredClone(probes.storageData ?? {}))
    probes.update(next)
    return { success: true }
  },
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
  getXaaIdpConfig: probes.getXaaIdpConfig,
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
    TEST_HOME,
    'github',
    config,
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
    probes.releaseNative.mockClear()
    probes.lockSync.mockClear()
    probes.lock.mockReset()
    probes.lock.mockResolvedValue(probes.release)
    probes.storageData = null
    mockPerformCrossAppAccess.mockReset()
    probes.getCachedIdpIdToken.mockReturnValue('id-token')
    probes.getIdpClientSecret.mockReturnValue('idp-secret')
    probes.getXaaIdpConfig.mockReturnValue({
      issuer: 'https://agenc.tech/idp',
      client_id: 'idp-client',
    })
    probes.discoverOidc.mockResolvedValue({
      token_endpoint: 'https://agenc.tech/idp/token',
    })
    probes.refreshAuthorization.mockReset()
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
      {},
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

  it('refreshes an expiring standard OAuth token and stores the replacement', async () => {
    const config: McpSSEServerConfig = {
      type: 'sse',
      url: 'https://mcp.example.test/sse',
      oauth: { clientId: 'mcp-client' },
    }
    const key = getServerKey('github', config)
    probes.storageData = clientSecretStorage(key, {
      [key]: {
        serverName: 'github',
        serverUrl: config.url,
        accessToken: 'expiring-access',
        refreshToken: 'current-refresh',
        expiresAt: Date.now() + 60_000,
        scope: 'read',
      },
    })
    probes.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      expires_in: 3600,
      scope: 'read write',
      token_type: 'Bearer',
    })
    const provider = makeProvider(config)
    provider.setMetadata({
      issuer: 'https://auth.example.test',
      authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: 'https://auth.example.test/token',
      response_types_supported: ['code'],
    })

    await expect(provider.tokens()).resolves.toEqual(
      expect.objectContaining({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
      }),
    )

    expect(probes.refreshAuthorization).toHaveBeenCalledWith(
      new URL(config.url),
      expect.objectContaining({
        clientInformation: {
          client_id: 'mcp-client',
          client_secret: 'mcp-secret',
        },
        refreshToken: 'current-refresh',
      }),
    )
    expect(probes.storageData?.mcpOAuth?.[key]).toEqual(
      expect.objectContaining({
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        scope: 'read write',
      }),
    )
    expect(probes.release).toHaveBeenCalledOnce()
  })

  it('clears invalid standard OAuth tokens while preserving client identity', async () => {
    const config: McpSSEServerConfig = {
      type: 'sse',
      url: 'https://mcp.example.test/sse',
      oauth: { clientId: 'mcp-client' },
    }
    const key = getServerKey('github', config)
    probes.storageData = clientSecretStorage(key, {
      [key]: {
        serverName: 'github',
        serverUrl: config.url,
        accessToken: 'expired-access',
        refreshToken: 'revoked-refresh',
        expiresAt: 0,
        scope: 'read',
        clientId: 'stored-client',
        clientSecret: 'stored-secret',
      },
    })
    probes.refreshAuthorization.mockRejectedValue(
      new InvalidGrantError('refresh token revoked'),
    )
    const provider = makeProvider(config)
    provider.setMetadata({
      issuer: 'https://auth.example.test',
      authorization_endpoint: 'https://auth.example.test/authorize',
      token_endpoint: 'https://auth.example.test/token',
      response_types_supported: ['code'],
    })

    await expect(
      provider.refreshAuthorization('revoked-refresh'),
    ).resolves.toBeUndefined()

    expect(probes.storageData?.mcpOAuth?.[key]).toEqual(
      expect.objectContaining({
        accessToken: '',
        expiresAt: 0,
        clientId: 'stored-client',
        clientSecret: 'stored-secret',
      }),
    )
    expect(probes.storageData?.mcpOAuth?.[key]?.refreshToken).toBeUndefined()
    expect(probes.release).toHaveBeenCalledOnce()
  })

  it('turns insufficient-scope responses into in-memory needs-auth tokens', async () => {
    const config: McpSSEServerConfig = {
      type: 'sse',
      url: 'https://mcp.example.test/sse',
      oauth: { clientId: 'mcp-client' },
    }
    const key = getServerKey('github', config)
    probes.storageData = clientSecretStorage(key, {
      [key]: {
        serverName: 'github',
        serverUrl: config.url,
        accessToken: 'current-access',
        refreshToken: 'current-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: 'read',
      },
    })
    const provider = makeProvider(config)
    const fetchWithStepUpDetection = wrapFetchWithStepUpDetection(
      vi.fn(async () =>
        new Response(null, {
          status: 403,
          headers: {
            'WWW-Authenticate':
              'Bearer error="insufficient_scope", scope="read write"',
          },
        })),
      provider,
    )

    await fetchWithStepUpDetection('https://mcp.example.test/sse')
    await expect(provider.tokens()).resolves.toEqual(
      expect.objectContaining({
        access_token: 'current-access',
        refresh_token: undefined,
        scope: 'read',
      }),
    )
    expect(probes.refreshAuthorization).not.toHaveBeenCalled()
    expect(probes.storageData?.mcpOAuth?.[key]?.refreshToken).toBe(
      'current-refresh',
    )
  })
})
