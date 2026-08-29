import { afterEach, describe, expect, test, vi } from 'vitest'

const ID_JAG_TOKEN_TYPE =
  'urn:ietf:params:oauth:token-type:id-jag'

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@modelcontextprotocol/sdk/client/auth.js')
  >()),
  discoverOAuthProtectedResourceMetadata: vi.fn(
    async (
      serverUrl: string,
      _resourceMetadataUrl: URL | undefined,
      fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
    ) => {
      await fetchFn(`${serverUrl}/.well-known/oauth-protected-resource`)
      return {
        resource: serverUrl,
        authorization_servers: ['https://as.example.test'],
      }
    },
  ),
  discoverAuthorizationServerMetadata: vi.fn(
    async (
      asUrl: string,
      options: {
        fetchFn: (url: string, init?: RequestInit) => Promise<Response>
      },
    ) => {
      await options.fetchFn(
        `${asUrl}/.well-known/oauth-authorization-server`,
      )
      return {
        issuer: asUrl,
        authorization_endpoint: `${asUrl}/authorize`,
        token_endpoint: 'https://as.example.test/as-token',
        response_types_supported: ['code'],
        grant_types_supported: [
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        ],
      }
    },
  ),
}))

import { performCrossAppAccess } from '../../../src/services/mcp/xaa.js'
import { clearProxyCache } from '../../../src/utils/proxy.js'

const originalFetch = globalThis.fetch
const originalHttpsProxy = process.env.HTTPS_PROXY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = originalHttpsProxy
  clearProxyCache()
  vi.restoreAllMocks()
})

describe('XAA request transport authority', () => {
  test('all discovery and exchange legs use the owning A/B session', async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push(init ?? {})
      const url = String(input)
      if (url.endsWith('/idp-token')) {
        return new Response(JSON.stringify({
          access_token: 'id-jag',
          issued_token_type: ID_JAG_TOKEN_TYPE,
        }), { status: 200 })
      }
      if (url.endsWith('/as-token')) {
        return new Response(JSON.stringify({
          access_token: 'mcp-access-token',
          token_type: 'Bearer',
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    process.env.HTTPS_PROXY = 'http://ambient.proxy.test:8080'

    const config = {
      clientId: 'as-client',
      clientSecret: 'as-secret',
      idpClientId: 'idp-client',
      idpIdToken: 'id-token',
      idpTokenEndpoint: 'https://idp.example.test/idp-token',
    }
    await performCrossAppAccess(
      'https://mcp-a.example.test/mcp',
      config,
      Object.freeze({
        HTTPS_PROXY: 'http://session-a.proxy.test:8080',
      }),
      'session-a',
    )
    await performCrossAppAccess(
      'https://mcp-b.example.test/mcp',
      config,
      Object.freeze({}),
      'session-b',
    )

    expect(calls).toHaveLength(8)
    for (const call of calls.slice(0, 4)) {
      expect(
        (call as RequestInit & { dispatcher?: object }).dispatcher
          ?.constructor.name,
      ).toBe('EnvHttpProxyAgent')
    }
    for (const call of calls.slice(4)) {
      expect(
        (call as RequestInit & { dispatcher?: object }).dispatcher
          ?.constructor.name,
      ).toBe('Agent')
    }
  })
})
