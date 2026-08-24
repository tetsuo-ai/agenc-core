import { expect, test } from 'bun:test'

import { resolveRuntimeChatGptSubscriptionCredentials } from '../../../src/services/api/providerConfig.ts'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

test('uses the subscription access token when the native record also has a platform API key', () => {
  const credentials = resolveRuntimeChatGptSubscriptionCredentials({
    environment: Object.freeze({}),
    storedCredentials: {
      apiKey: 'stored-platform-key',
      accessToken: 'stored-subscription-token',
      accountId: 'acct_stored',
    },
  })

  expect(credentials).toEqual({
    bearerToken: 'stored-subscription-token',
    accountId: 'acct_stored',
    source: 'native-vault',
  })
})

test('native sign-in wins over conflicting ProviderCode environment credentials', () => {
  const credentials = resolveRuntimeChatGptSubscriptionCredentials({
    environment: Object.freeze({
      PROVIDER_CODE_API_KEY: 'environment-token',
      PROVIDER_CODE_ACCOUNT_ID: 'acct_environment',
    }),
    storedCredentials: {
      accessToken: 'stored-subscription-token',
      accountId: 'acct_stored',
    },
  })

  expect(credentials).toEqual({
    bearerToken: 'stored-subscription-token',
    accountId: 'acct_stored',
    source: 'native-vault',
  })
})

test('uses the explicit ProviderCode environment token only without a usable native sign-in', () => {
  const token = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_environment',
    },
  })
  const credentials = resolveRuntimeChatGptSubscriptionCredentials({
    environment: Object.freeze({ PROVIDER_CODE_API_KEY: token }),
    storedCredentials: { apiKey: 'platform-only-key' },
  })

  expect(credentials).toEqual({
    bearerToken: token,
    accountId: 'acct_environment',
    source: 'environment',
  })
})

test('does not consume retired auth paths or AgenC managed-auth aliases', () => {
  const credentials = resolveRuntimeChatGptSubscriptionCredentials({
    environment: Object.freeze({
      PROVIDER_CODE_AUTH_JSON_PATH: '/tmp/retired-auth.json',
      AGENC_API_KEY: 'managed-auth-key',
      AGENC_ACCOUNT_ID: 'managed-account',
    }),
  })

  expect(credentials).toEqual({ bearerToken: '', source: 'none' })
})
