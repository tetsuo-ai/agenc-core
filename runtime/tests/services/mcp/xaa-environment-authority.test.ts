import { afterEach, describe, expect, test, vi } from 'vitest'

import { snapshotProviderEnvironment } from '../../../src/llm/provider-options.js'
import {
  discoverOidc,
  isXaaEnabled,
} from '../../../src/services/mcp/xaaIdpLogin.js'
import { clearProxyCache } from '../../../src/utils/proxy.js'

const originalXaaValue = process.env.AGENC_ENABLE_XAA
const originalHttpsProxy = process.env.HTTPS_PROXY
const originalFetch = globalThis.fetch

afterEach(() => {
  if (originalXaaValue === undefined) {
    delete process.env.AGENC_ENABLE_XAA
  } else {
    process.env.AGENC_ENABLE_XAA = originalXaaValue
  }
  if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = originalHttpsProxy
  globalThis.fetch = originalFetch
  clearProxyCache()
  vi.restoreAllMocks()
})

describe('XAA environment authority', () => {
  test('A/B session snapshots remain isolated after ambient mutation', () => {
    const enabledSession = snapshotProviderEnvironment({
      AGENC_ENABLE_XAA: '1',
    })
    const disabledSession = snapshotProviderEnvironment({
      AGENC_ENABLE_XAA: '0',
    })

    process.env.AGENC_ENABLE_XAA = '0'
    expect(isXaaEnabled(enabledSession)).toBe(true)
    expect(isXaaEnabled(disabledSession)).toBe(false)

    process.env.AGENC_ENABLE_XAA = '1'
    expect(isXaaEnabled(enabledSession)).toBe(true)
    expect(isXaaEnabled(disabledSession)).toBe(false)
  })

  test('OIDC discovery uses each captured session transport', async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({
        issuer: 'https://idp.example.test',
        authorization_endpoint: 'https://idp.example.test/authorize',
        token_endpoint: 'https://idp.example.test/token',
        jwks_uri: 'https://idp.example.test/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    process.env.HTTPS_PROXY = 'http://ambient.proxy.test:8080'

    await discoverOidc(
      'https://idp.example.test',
      Object.freeze({
        HTTPS_PROXY: 'http://session-a.proxy.test:8080',
      }),
    )
    await discoverOidc(
      'https://idp.example.test',
      Object.freeze({}),
    )

    const dispatcherA = (calls[0] as RequestInit & { dispatcher?: object })
      .dispatcher
    const dispatcherB = (calls[1] as RequestInit & { dispatcher?: object })
      .dispatcher
    expect(dispatcherA?.constructor.name).toBe('EnvHttpProxyAgent')
    expect(dispatcherB?.constructor.name).toBe('Agent')
    expect(dispatcherA).not.toBe(dispatcherB)
  })
})
