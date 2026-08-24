import type { HomeContext } from '../../config/home.js'
import type { ProviderEnvironment } from '../../llm/provider-options.js'
import {
  exchangeProviderCodeIdTokenForApiKey,
  parseChatgptAccountId,
} from '../api/openAiCodeOAuthShared.js'
import {
  saveOpenAiOauthCredentials,
} from '../../utils/openAiOauthCredentials.js'
import type { OpenAiBrowserLoginResult } from './oauth.js'

export type OpenAiLoginCompletionErrorCode =
  | 'no_credential'
  | 'store_failed'

export class OpenAiLoginCompletionError extends Error {
  constructor(
    readonly code: OpenAiLoginCompletionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OpenAiLoginCompletionError'
  }
}

export interface OpenAiLoginCompletion {
  readonly account: string
  readonly authMode: 'apiKey' | 'chatgpt'
}

/**
 * Complete one browser login against one captured home/environment authority.
 * Platform API-key exchange is opportunistic: ChatGPT-only accounts remain a
 * valid subscription credential when the access token carries an account id.
 */
export async function completeOpenAiLogin(options: {
  readonly home: HomeContext
  readonly environment: ProviderEnvironment
  readonly login: OpenAiBrowserLoginResult
  readonly obtainedAt?: number
}): Promise<OpenAiLoginCompletion> {
  const { home, environment, login } = options
  let apiKey: string | undefined
  if (login.tokens.idToken !== undefined) {
    try {
      apiKey = await exchangeProviderCodeIdTokenForApiKey(
        login.tokens.idToken,
        environment,
      )
    } catch {
      apiKey = undefined
    }
  }

  const accountId =
    parseChatgptAccountId(login.tokens.idToken) ??
    parseChatgptAccountId(login.tokens.accessToken)
  if (apiKey === undefined && accountId === undefined) {
    throw new OpenAiLoginCompletionError(
      'no_credential',
      'the login produced neither a platform API key nor a ChatGPT account id, so there is no way to authenticate with it.',
    )
  }

  const authMode = apiKey === undefined ? 'chatgpt' : 'apiKey'
  const saved = saveOpenAiOauthCredentials(home, {
    ...(apiKey === undefined ? {} : { apiKey }),
    authMode,
    accessToken: login.tokens.accessToken,
    ...(accountId === undefined ? {} : { accountId }),
    ...(login.accountLabel === undefined
      ? {}
      : { accountLabel: login.accountLabel }),
    ...(login.tokens.idToken === undefined
      ? {}
      : { idToken: login.tokens.idToken }),
    ...(login.tokens.refreshToken === undefined
      ? {}
      : { refreshToken: login.tokens.refreshToken }),
    obtainedAt: options.obtainedAt ?? Date.now(),
  })
  if (!saved.success) {
    throw new OpenAiLoginCompletionError(
      'store_failed',
      `signed in, but storing the credential failed: ${saved.warning ?? 'unknown error'}`,
    )
  }

  return Object.freeze({
    account: login.accountLabel ?? 'ChatGPT account',
    authMode,
  })
}
