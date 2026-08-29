import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  DEFAULT_PROVIDER_CODE_OAUTH_CALLBACK_PORT,
  exchangeProviderCodeIdTokenForApiKey,
  getOpenAiCodeOAuthCallbackPort,
} from '../../../src/services/api/openAiCodeOAuthShared.ts'

describe('openAiCodeOAuthShared', () => {
  const originalFetch = globalThis.fetch
  const environment = Object.freeze({})

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  test('exchangeProviderCodeIdTokenForApiKey rejects malformed token payloads predictably', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('null', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    ) as unknown as typeof fetch

    await expect(
      exchangeProviderCodeIdTokenForApiKey('id-token', environment),
    ).rejects.toThrow(
      'ProviderCode API key exchange completed, but no API key token was returned.',
    )
  })

  test('exchangeProviderCodeIdTokenForApiKey rejects non-JSON successful responses predictably', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>login</html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
        },
      }),
    ) as unknown as typeof fetch

    await expect(
      exchangeProviderCodeIdTokenForApiKey('id-token', environment),
    ).rejects.toThrow('ProviderCode API key exchange returned invalid JSON.')
  })

  test('callback port uses the captured environment or its one default', () => {
    expect(getOpenAiCodeOAuthCallbackPort(Object.freeze({}))).toBe(
      DEFAULT_PROVIDER_CODE_OAUTH_CALLBACK_PORT,
    )
    expect(getOpenAiCodeOAuthCallbackPort(Object.freeze({
      PROVIDER_CODE_OAUTH_CALLBACK_PORT: '32145',
    }))).toBe(32145)
  })

  test.each(['0', '65536', '1.5', 'not-a-port']) (
    'callback port rejects %s',
    value => {
      expect(() => getOpenAiCodeOAuthCallbackPort(Object.freeze({
        PROVIDER_CODE_OAUTH_CALLBACK_PORT: value,
      }))).toThrow(/integer from 1 to 65535/)
    },
  )
})
