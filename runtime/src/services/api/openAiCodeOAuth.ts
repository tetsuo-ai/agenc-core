// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../oauth/crypto.js'
import {
  asTrimmedString,
  PROVIDER_CODE_OAUTH_ISSUER,
  PROVIDER_CODE_OAUTH_ORIGINATOR,
  PROVIDER_CODE_OAUTH_SCOPE,
  escapeHtml,
  exchangeProviderCodeIdTokenForApiKey,
  getOpenAiCodeOAuthCallbackPort,
  getOpenAiCodeOAuthClientId,
  parseChatgptAccountId,
} from './openAiCodeOAuthShared.js'

type OpenAiCodeOAuthTokenResponse = {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

export type OpenAiCodeOAuthTokens = {
  apiKey?: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
}

function buildProviderCodeAuthorizeUrl(options: {
  port: number
  codeChallenge: string
  state: string
}): string {
  const redirectUri = `http://localhost:${options.port}/auth/callback`
  const authUrl = new URL(`${PROVIDER_CODE_OAUTH_ISSUER}/oauth/authorize`)

  authUrl.searchParams.append('response_type', 'code')
  authUrl.searchParams.append('client_id', getOpenAiCodeOAuthClientId())
  authUrl.searchParams.append('redirect_uri', redirectUri)
  authUrl.searchParams.append('scope', PROVIDER_CODE_OAUTH_SCOPE)
  authUrl.searchParams.append('code_challenge', options.codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('id_token_add_organizations', 'true')
  authUrl.searchParams.append('providerCode_cli_simplified_flow', 'true')
  authUrl.searchParams.append('state', options.state)
  authUrl.searchParams.append('originator', PROVIDER_CODE_OAUTH_ORIGINATOR)

  return authUrl.toString()
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ProviderCode Login Complete</title>
    <style>
      body { font-family: sans-serif; padding: 32px; line-height: 1.5; color: #111827; }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 10px; }
    </style>
  </head>
  <body>
    <h1>ProviderCode login complete</h1>
    <p>You can return to AgenC now.</p>
    <p>AgenC will finish activating your new ProviderCode OAuth login.</p>
  </body>
</html>`
}

function renderErrorPage(message: string): string {
  const safeMessage = escapeHtml(message)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ProviderCode Login Failed</title>
    <style>
      body { font-family: sans-serif; padding: 32px; line-height: 1.5; color: #111827; }
      h1 { margin: 0 0 12px; font-size: 22px; color: #991b1b; }
      p { margin: 0 0 10px; }
    </style>
  </head>
  <body>
    <h1>ProviderCode login failed</h1>
    <p>${safeMessage}</p>
    <p>You can close this window and try again in AgenC.</p>
  </body>
</html>`
}

function renderCancelledPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>ProviderCode Login Cancelled</title>
    <style>
      body { font-family: sans-serif; padding: 32px; line-height: 1.5; color: #111827; }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0 0 10px; }
    </style>
  </head>
  <body>
    <h1>ProviderCode login cancelled</h1>
    <p>You can close this window and retry in AgenC.</p>
  </body>
</html>`
}

async function exchangeAuthorizationCode(options: {
  authorizationCode: string
  codeVerifier: string
  port: number
  signal?: AbortSignal
}): Promise<OpenAiCodeOAuthTokens> {
  const redirectUri = `http://localhost:${options.port}/auth/callback`
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.authorizationCode,
    redirect_uri: redirectUri,
    client_id: getOpenAiCodeOAuthClientId(),
    code_verifier: options.codeVerifier,
  })

  const response = await fetch(`${PROVIDER_CODE_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      errorText.trim()
        ? `ProviderCode OAuth token exchange failed (${response.status}): ${errorText.trim()}`
        : `ProviderCode OAuth token exchange failed with status ${response.status}.`,
    )
  }

  const payload = (await response.json()) as OpenAiCodeOAuthTokenResponse
  const accessToken = asTrimmedString(payload.access_token)
  const refreshToken = asTrimmedString(payload.refresh_token)
  if (!accessToken || !refreshToken) {
    throw new Error(
      'ProviderCode OAuth completed, but the token response was missing credentials.',
    )
  }

  const idToken = asTrimmedString(payload.id_token)
  const apiKey = idToken
    ? await exchangeProviderCodeIdTokenForApiKey(idToken).catch(() => undefined)
    : undefined

  return {
    apiKey,
    accessToken,
    refreshToken,
    idToken,
    accountId:
      parseChatgptAccountId(idToken) ?? parseChatgptAccountId(accessToken),
  }
}

export class OpenAiCodeOAuthService {
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
  private tokenExchangeAbortController: AbortController | null = null

  private buildCancellationError(): Error {
    return new Error('ProviderCode OAuth flow was cancelled.')
  }

  async startOAuthFlow(
    authURLHandler: (authUrl: string) => Promise<void>,
  ): Promise<OpenAiCodeOAuthTokens> {
    const codeVerifier = generateCodeVerifier()
    const callbackPort = getOpenAiCodeOAuthCallbackPort()
    const authCodeListener = new AuthCodeListener('/auth/callback')

    this.authCodeListener = authCodeListener
    this.port = null

    try {
      const port = await authCodeListener.start(callbackPort)
      this.port = port

      const state = generateState()
      const codeChallenge = await generateCodeChallenge(codeVerifier)
      const authUrl = buildProviderCodeAuthorizeUrl({
        port,
        codeChallenge,
        state,
      })

      try {
        const authorizationCode = await authCodeListener.waitForAuthorization(
          state,
          async () => {
            await authURLHandler(authUrl)
          },
        )

        const tokenExchangeAbortController = new AbortController()
        this.tokenExchangeAbortController = tokenExchangeAbortController

        let tokens: OpenAiCodeOAuthTokens
        try {
          tokens = await exchangeAuthorizationCode({
            authorizationCode,
            codeVerifier,
            port,
            signal: tokenExchangeAbortController.signal,
          })
        } finally {
          if (
            this.tokenExchangeAbortController === tokenExchangeAbortController
          ) {
            this.tokenExchangeAbortController = null
          }
        }

        if (this.authCodeListener !== authCodeListener) {
          throw this.buildCancellationError()
        }

        authCodeListener.handleSuccessRedirect([], res => {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
          })
          res.end(renderSuccessPage())
        })

        return tokens
      } catch (error) {
        const resolvedError =
          this.authCodeListener === authCodeListener
            ? error
            : this.buildCancellationError()

        if (authCodeListener.hasPendingResponse()) {
          const isCancellation =
            resolvedError instanceof Error &&
            resolvedError.message === 'ProviderCode OAuth flow was cancelled.'

          authCodeListener.handleErrorRedirect(res => {
            res.writeHead(isCancellation ? 200 : 400, {
              'Content-Type': 'text/html; charset=utf-8',
            })
            res.end(
              isCancellation
                ? renderCancelledPage()
                : renderErrorPage(
                    resolvedError instanceof Error
                      ? resolvedError.message
                      : String(resolvedError),
                  ),
            )
          })
        }
        throw resolvedError
      } finally {
        this.cleanup()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        message.includes('EADDRINUSE') ||
        message.includes(String(callbackPort))
      ) {
        throw new Error(
          `ProviderCode OAuth needs localhost:${callbackPort} for its callback. Close any app already using that port and try again.`,
        )
      }
      throw error
    }
  }

  cleanup(): void {
    const cancellationError = this.buildCancellationError()

    this.tokenExchangeAbortController?.abort(cancellationError)
    this.tokenExchangeAbortController = null

    if (this.authCodeListener?.hasPendingResponse()) {
      this.authCodeListener.handleErrorRedirect(res => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
        })
        res.end(renderCancelledPage())
      })
    }

    this.authCodeListener?.cancelPendingAuthorization(cancellationError)
    this.authCodeListener = null
    this.port = null
  }
}
