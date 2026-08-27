import { beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../../src/config/home.js'

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  save: vi.fn(),
}))

vi.mock('../../../src/services/api/openAiCodeOAuthShared.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../../../src/services/api/openAiCodeOAuthShared.js')
  >()
  return {
    ...actual,
    exchangeProviderCodeIdTokenForApiKey: mocks.exchange,
  }
})

vi.mock('../../../src/utils/openAiOauthCredentials.js', () => ({
  saveOpenAiOauthCredentials: mocks.save,
}))

import {
  completeOpenAiLogin,
  OpenAiLoginCompletionError,
} from '../../../src/services/openai/login.js'

const home = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-openai-login-test' },
  { platformHome: '/tmp' },
)
const environment = Object.freeze({
  PROVIDER_CODE_OAUTH_CLIENT_ID: 'captured-client',
})

function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}.signature`
}

describe('OpenAI login completion authority', () => {
  beforeEach(() => {
    mocks.exchange.mockReset()
    mocks.save.mockReset()
    mocks.save.mockReturnValue({ success: true })
  })

  test('stores an exchanged platform credential once', async () => {
    mocks.exchange.mockResolvedValue('platform-key')
    const result = await completeOpenAiLogin({
      home,
      environment,
      obtainedAt: 123,
      login: {
        accountLabel: 'operator@example.com',
        tokens: {
          accessToken: 'access-token',
          idToken: jwt({ chatgpt_account_id: 'acct-platform' }),
          refreshToken: 'refresh-token',
        },
      },
    })

    expect(result).toEqual({
      account: 'operator@example.com',
      authMode: 'apiKey',
    })
    expect(mocks.exchange).toHaveBeenCalledWith(
      expect.any(String),
      environment,
    )
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledWith(home, expect.objectContaining({
      apiKey: 'platform-key',
      authMode: 'apiKey',
      accountId: 'acct-platform',
      obtainedAt: 123,
    }))
  })

  test('falls back to a usable ChatGPT subscription credential', async () => {
    mocks.exchange.mockRejectedValue(new Error('no platform organization'))
    const accessToken = jwt({ chatgpt_account_id: 'acct-subscription' })

    await expect(completeOpenAiLogin({
      home,
      environment,
      login: {
        tokens: {
          accessToken,
          idToken: 'identity-token',
          refreshToken: 'refresh-token',
        },
      },
    })).resolves.toEqual({
      account: 'ChatGPT account',
      authMode: 'chatgpt',
    })
    expect(mocks.save).toHaveBeenCalledWith(home, expect.objectContaining({
      accessToken,
      accountId: 'acct-subscription',
      authMode: 'chatgpt',
    }))
  })

  test('rejects a login that cannot authenticate either backend', async () => {
    mocks.exchange.mockRejectedValue(new Error('exchange rejected'))

    await expect(completeOpenAiLogin({
      home,
      environment,
      login: {
        tokens: {
          accessToken: 'opaque-token-without-account',
          idToken: 'opaque-identity-token',
        },
      },
    })).rejects.toMatchObject<Partial<OpenAiLoginCompletionError>>({
      code: 'no_credential',
    })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  test('reports a native-storage failure without creating another store', async () => {
    mocks.exchange.mockResolvedValue('platform-key')
    mocks.save.mockReturnValue({ success: false, warning: 'secure storage unavailable' })

    await expect(completeOpenAiLogin({
      home,
      environment,
      login: {
        tokens: {
          accessToken: 'access-token',
          idToken: 'identity-token',
        },
      },
    })).rejects.toMatchObject<Partial<OpenAiLoginCompletionError>>({
      code: 'store_failed',
    })
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })
})
