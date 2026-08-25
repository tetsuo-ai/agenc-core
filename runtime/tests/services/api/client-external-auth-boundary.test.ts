import { expect, mock, test } from 'bun:test'
import { runWithStartupProviderSelection } from '../../../src/utils/model/providers.ts'

const firstPartyAuthCalls = {
  refresh: 0,
  subscriber: 0,
  oauth: 0,
  apiKey: 0,
}

const actualAuth = await import(
  '../../../src/utils/auth.ts?external-auth-boundary-original'
)

mock.module('src/utils/auth.js', () => ({
  ...actualAuth,
  checkAndRefreshOAuthTokenIfNeeded: async () => {
    firstPartyAuthCalls.refresh += 1
    throw new Error('external provider touched first-party OAuth refresh')
  },
  isAgenCAISubscriber: () => {
    firstPartyAuthCalls.subscriber += 1
    throw new Error('external provider touched first-party subscriber state')
  },
  getAgenCAIOAuthTokens: () => {
    firstPartyAuthCalls.oauth += 1
    throw new Error('external provider touched first-party OAuth tokens')
  },
  getproviderApiKey: () => {
    firstPartyAuthCalls.apiKey += 1
    throw new Error('external provider touched first-party API-key state')
  },
  getproviderApiKeyWithSource: () => ({ key: undefined, source: 'none' }),
  getOauthAccountInfo: () => null,
  handleOAuth401Error: async () => false,
  isEnterpriseSubscriber: () => false,
}))

test('constructs an external provider without touching first-party auth', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  const environment = {
    AGENC_PROVIDER: 'mistral',
    AGENC_MODEL: 'mistral-medium-latest',
    MISTRAL_API_KEY: 'mistral-test-key',
    MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
  }
  const { getproviderClient } = await import(
    '../../../src/services/api/client.ts?external-auth-boundary'
  )

  const client = await runWithStartupProviderSelection(
    {
      provider: 'mistral',
      model: 'mistral-medium-latest',
      environment,
    },
    () => getproviderClient({
      maxRetries: 0,
      model: 'mistral-medium-latest',
    }),
  )

  expect(client).toBeDefined()
  expect(firstPartyAuthCalls).toEqual({
    refresh: 0,
    subscriber: 0,
    oauth: 0,
    apiKey: 0,
  })
})
