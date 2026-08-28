import { describe, expect, test } from 'vitest'
import { defaultConfig } from '../../../src/config/schema.js'
import { verifyApiKey } from '../../../src/onboarding/useApiKeyVerification.js'
import { getProxyFetchOptions } from '../../../src/utils/proxy.js'

describe('canonical provider verification transport', () => {
  test('uses the prepared Anthropic endpoint, headers, and unix socket', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const result = await verifyApiKey({
      provider: 'anthropic',
      apiKey: 'test-key',
      config: defaultConfig(),
      env: {
        ANTHROPIC_BASE_URL: 'https://anthropic-gateway.example/v1',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway: prepared-header',
        ANTHROPIC_UNIX_SOCKET: '/tmp/agenc-test-anthropic.sock',
      },
      fetchImpl: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return new Response('{}', { status: 200 })
      },
    })

    expect(result).toEqual({ status: 'valid' })
    expect(capturedUrl).toBe('https://anthropic-gateway.example/v1/models')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('x-gateway')).toBe('prepared-header')
    expect(headers.get('x-api-key')).toBe('test-key')
    expect(capturedInit).toMatchObject(
      getProxyFetchOptions({
        forAnthropicAPI: true,
        environment: {
          ANTHROPIC_UNIX_SOCKET: '/tmp/agenc-test-anthropic.sock',
        },
      }) as RequestInit,
    )
  })

  test('uses the captured proxy and timeout', async () => {
    const startedAt = Date.now()
    let capturedInit: RequestInit | undefined
    const environment = {
      API_TIMEOUT_MS: '20',
      HTTPS_PROXY: 'http://proxy.example:8080',
    }
    const result = await verifyApiKey({
      provider: 'anthropic',
      apiKey: 'test-key',
      config: defaultConfig(),
      env: environment,
      fetchImpl: async (_input, init) => {
        capturedInit = init
        await new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason)
            return
          }
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        })
        return new Response('{}')
      },
    })

    expect(result.status).toBe('error')
    expect(capturedInit).toMatchObject(
      getProxyFetchOptions({
        forAnthropicAPI: true,
        environment,
      }) as RequestInit,
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
