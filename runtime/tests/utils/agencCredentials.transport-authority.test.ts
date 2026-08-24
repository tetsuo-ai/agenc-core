import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import { resolveHomeContext } from '../../src/config/home.js'
import {
  clearProxyCache,
  getProxyAgent,
} from '../../src/utils/proxy.js'

const nativeStorageModulePath = '../../src/utils/secureStorage/native.js'
const envUtilsModulePath = '../../src/utils/envUtils.js'

const originalFetch = globalThis.fetch
const originalGlobalDispatcher = getGlobalDispatcher()
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalOAuthClientId = process.env.PROVIDER_CODE_OAUTH_CLIENT_ID

function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

afterEach(() => {
  vi.doUnmock(nativeStorageModulePath)
  vi.doUnmock(envUtilsModulePath)
  vi.clearAllMocks()
  vi.resetModules()
  globalThis.fetch = originalFetch
  setGlobalDispatcher(originalGlobalDispatcher)
  clearProxyCache()
  restoreEnvironment('HTTPS_PROXY', originalHttpsProxy)
  restoreEnvironment(
    'PROVIDER_CODE_OAUTH_CLIENT_ID',
    originalOAuthClientId,
  )
})

describe('ProviderCode refresh transport authority', () => {
  test('isolates same-home refresh and exchange work by immutable environment identity', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'agenc-provider-code-transport-'))
    const home = resolveHomeContext(
      { AGENC_HOME: join(homeRoot, 'same-home') },
      { platformHome: homeRoot },
    )
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct-shared',
    })
    let storageState: Record<string, unknown> = {
      agenc: {
        accessToken: expiredToken,
        refreshToken: 'refresh-shared',
        accountId: 'acct-shared',
      },
    }

    class TestNativeSecureStorageError extends Error {
      readonly name = 'NativeSecureStorageError'
    }

    vi.doMock(nativeStorageModulePath, () => ({
      NativeSecureStorageError: TestNativeSecureStorageError,
      readNativeSecureStorage: () => structuredClone(storageState),
      readNativeSecureStorageAsync: async () => structuredClone(storageState),
      updateNativeSecureStorage: (
        _home: unknown,
        updater: (
          current: Readonly<Record<string, unknown>>,
        ) => Record<string, unknown>,
      ) => {
        const previous = structuredClone(storageState)
        const written = structuredClone(updater(previous))
        storageState = written
        return { previous, written }
      },
    }))
    vi.doMock(envUtilsModulePath, async importOriginal => ({
      ...(await importOriginal<typeof import('../../src/utils/envUtils.js')>()),
      isBareMode: () => false,
    }))

    const environmentA = Object.freeze({
      HTTPS_PROXY: 'http://session-a.proxy.test:8080',
      PROVIDER_CODE_OAUTH_CLIENT_ID: 'session-a-client',
    })
    const environmentB = Object.freeze({
      PROVIDER_CODE_OAUTH_CLIENT_ID: 'session-b-client',
    })
    const contaminatedGlobalDispatcher = getProxyAgent(
      'http://ambient-global.proxy.test:8080',
      Object.freeze({
        HTTPS_PROXY: 'http://ambient-global.proxy.test:8080',
      }),
    )
    setGlobalDispatcher(contaminatedGlobalDispatcher)
    process.env.HTTPS_PROXY = 'http://ambient-initial.proxy.test:8080'
    process.env.PROVIDER_CODE_OAUTH_CLIENT_ID = 'ambient-initial-client'

    type RecordedRequest = {
      readonly clientId: string | null
      readonly grantType: string | null
      readonly dispatcher: object | undefined
    }
    const requests: RecordedRequest[] = []
    let releaseRefreshResponses!: () => void
    const refreshGate = new Promise<void>(resolve => {
      releaseRefreshResponses = resolve
    })

    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = init?.body
      if (!(body instanceof URLSearchParams)) {
        throw new Error('expected ProviderCode form body')
      }
      const clientId = body.get('client_id')
      const grantType = body.get('grant_type')
      requests.push({
        clientId,
        grantType,
        dispatcher: (
          init as RequestInit & { dispatcher?: object }
        ).dispatcher,
      })

      if (grantType === 'refresh_token') {
        await refreshGate
        return new Response(JSON.stringify({
          access_token: makeJwt({
            exp: Math.floor((Date.now() + 3_600_000) / 1000),
            chatgpt_account_id: 'acct-shared',
          }),
          refresh_token: `refresh-${clientId}`,
          id_token: `id-${clientId}`,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({
        access_token: `api-key-${clientId}`,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const { refreshAgencAccessTokenIfNeeded } = await import(
        '../../src/utils/agencCredentials.ts'
      )
      const refreshA = refreshAgencAccessTokenIfNeeded(home, environmentA)
      const refreshB = refreshAgencAccessTokenIfNeeded(home, environmentB)

      let isolationFailure: unknown
      try {
        await vi.waitFor(() => {
          expect(
            requests.filter(request => request.grantType === 'refresh_token'),
          ).toHaveLength(2)
        }, { timeout: 500 })
      } catch (error) {
        isolationFailure = error
      }

      process.env.HTTPS_PROXY = 'http://ambient-mutated.proxy.test:8080'
      process.env.PROVIDER_CODE_OAUTH_CLIENT_ID = 'ambient-mutated-client'
      releaseRefreshResponses()
      const results = await Promise.allSettled([refreshA, refreshB])
      if (isolationFailure !== undefined) throw isolationFailure

      expect(results.every(result => result.status === 'fulfilled')).toBe(true)
      expect(
        results.filter(
          result => result.status === 'fulfilled' && result.value.refreshed,
        ),
      ).toHaveLength(1)

      const requestsA = requests.filter(
        request => request.clientId === 'session-a-client',
      )
      const requestsB = requests.filter(
        request => request.clientId === 'session-b-client',
      )
      expect(requestsA).toHaveLength(2)
      expect(requestsB).toHaveLength(2)
      expect(requestsA.map(request => request.grantType)).toEqual([
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ])
      expect(requestsB.map(request => request.grantType)).toEqual([
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ])
      expect(requestsA[0].dispatcher?.constructor.name).toBe(
        'EnvHttpProxyAgent',
      )
      expect(requestsB[0].dispatcher?.constructor.name).toBe('Agent')
      expect(requestsA[0].dispatcher).toBe(requestsA[1].dispatcher)
      expect(requestsB[0].dispatcher).toBe(requestsB[1].dispatcher)
      expect(requestsA[0].dispatcher).not.toBe(requestsB[0].dispatcher)
      expect(requestsA[0].dispatcher).not.toBe(
        contaminatedGlobalDispatcher,
      )
      expect(requestsB[0].dispatcher).not.toBe(
        contaminatedGlobalDispatcher,
      )
      expect(
        requests.some(request => request.clientId?.startsWith('ambient-')),
      ).toBe(false)
    } finally {
      releaseRefreshResponses()
      rmSync(homeRoot, { recursive: true, force: true })
    }
  })
})
