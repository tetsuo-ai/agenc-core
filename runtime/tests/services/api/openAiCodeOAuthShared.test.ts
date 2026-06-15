import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  exchangeProviderCodeIdTokenForApiKey,
} from '../../../src/services/api/openAiCodeOAuthShared.ts'

describe('openAiCodeOAuthShared', () => {
  const originalFetch = globalThis.fetch

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
      exchangeProviderCodeIdTokenForApiKey('id-token'),
    ).rejects.toThrow(
      'ProviderCode API key exchange completed, but no API key token was returned.',
    )
  })
})
