/**
 * Sign in with ChatGPT — browser PKCE against auth.openai.com using the
 * shared CLI OAuth client, with a loopback callback on the well-known
 * port. The id_token from the login is exchanged (RFC 8693, existing
 * helper) for a platform API key, so the rest of the runtime consumes a
 * plain key and no wire changes are needed.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import {
  PROVIDER_CODE_OAUTH_SCOPE,
  PROVIDER_CODE_REFRESH_URL,
  decodeJwtPayload,
  escapeHtml,
  getOpenAiCodeOAuthCallbackPort,
  getOpenAiCodeOAuthClientId,
  normalizeOAuthTokenPayload,
  readOAuthTokenJsonResponse,
} from '../api/openAiCodeOAuthShared.js'

const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CALLBACK_PATH = '/auth/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60_000

export type OpenAiOauthErrorCode =
  | 'callback_failed'
  | 'state_mismatch'
  | 'exchange_failed'
  | 'timeout'
  | 'denied'

export class OpenAiOauthError extends Error {
  constructor(
    readonly code: OpenAiOauthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OpenAiOauthError'
  }
}

export interface OpenAiOauthTokens {
  readonly accessToken: string
  readonly idToken?: string
  readonly refreshToken?: string
}

export interface OpenAiBrowserLoginResult {
  readonly tokens: OpenAiOauthTokens
  readonly accountLabel?: string
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function redirectUri(): string {
  return `http://localhost:${getOpenAiCodeOAuthCallbackPort()}${CALLBACK_PATH}`
}

function buildAuthorizeUrl(opts: {
  readonly challenge: string
  readonly state: string
}): string {
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', getOpenAiCodeOAuthClientId())
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('scope', PROVIDER_CODE_OAUTH_SCOPE)
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  // The shared CLI client's simplified flow: organization claims ride
  // the id_token so the API-key exchange can scope itself.
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  return url.toString()
}

function waitForCallback(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const gotState = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const finish = (
        status: number,
        title: string,
        detail: string,
      ): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<html><body style="font-family:system-ui;padding:40px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></body></html>`,
        )
      }
      if (error !== null) {
        finish(200, 'Sign-in was not completed', 'You can close this tab.')
        cleanup()
        reject(new OpenAiOauthError('denied', `authorization denied: ${error}`))
        return
      }
      if (gotState !== state) {
        // Non-fatal: a stale consent tab from an earlier attempt can hit
        // the live listener with an old state. Answer it and keep
        // waiting for the redirect that belongs to THIS attempt —
        // rejecting here let any leftover tab kill a healthy login.
        finish(
          400,
          'This sign-in tab is stale',
          'Close this tab and use the most recent sign-in tab, or retry from the app.',
        )
        return
      }
      if (code === null || code.length === 0) {
        finish(400, 'Sign-in failed', 'No authorization code was returned.')
        cleanup()
        reject(new OpenAiOauthError('callback_failed', 'callback carried no code'))
        return
      }
      finish(
        200,
        'Signed in',
        'You are signed in to ChatGPT for AgenC. You can close this tab and return to the app.',
      )
      cleanup()
      resolve(code)
    })
    const timer = setTimeout(() => {
      cleanup()
      reject(new OpenAiOauthError('timeout', 'sign-in timed out'))
    }, CALLBACK_TIMEOUT_MS)
    function cleanup(): void {
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        // already closed
      }
    }
    server.on('error', (error: NodeJS.ErrnoException) => {
      cleanup()
      reject(
        new OpenAiOauthError(
          'callback_failed',
          error.code === 'EADDRINUSE'
            ? `port ${getOpenAiCodeOAuthCallbackPort()} is in use`
            : `callback listener failed: ${error.message}`,
        ),
      )
    })
    server.listen(getOpenAiCodeOAuthCallbackPort(), '127.0.0.1')
  })
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<OpenAiOauthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: getOpenAiCodeOAuthClientId(),
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  })
  const response = await fetch(PROVIDER_CODE_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new OpenAiOauthError(
      'exchange_failed',
      text.trim()
        ? `token exchange failed (${response.status}): ${text.trim().slice(0, 300)}`
        : `token exchange failed with status ${response.status}`,
    )
  }
  const payload = normalizeOAuthTokenPayload(
    await readOAuthTokenJsonResponse(response, 'OpenAI sign-in'),
  )
  if (!payload.accessToken) {
    throw new OpenAiOauthError('exchange_failed', 'no access token returned')
  }
  return {
    accessToken: payload.accessToken,
    ...(payload.idToken ? { idToken: payload.idToken } : {}),
    ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
  }
}

function accountLabelFromIdToken(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined
  const claims = decodeJwtPayload(idToken)
  if (claims === null || typeof claims !== 'object') return undefined
  const record = claims as Record<string, unknown>
  const email = record['email']
  if (typeof email === 'string' && email.length > 0) return email
  const name = record['name']
  if (typeof name === 'string' && name.length > 0) return name
  return undefined
}

export type OpenAiLoginStage = 'callback_received' | 'exchanging_code'

export async function runOpenAiBrowserLogin(opts: {
  readonly onAuthorizeUrl: (url: string) => Promise<void> | void
  /** Progress reporting so long stages are visible, not silent. */
  readonly onStage?: (stage: OpenAiLoginStage) => void
}): Promise<OpenAiBrowserLoginResult> {
  const { verifier, challenge } = createPkcePair()
  const state = base64Url(randomBytes(16))
  const callback = waitForCallback(state)
  // Hand the URL out only after the listener is armed, so the redirect
  // cannot race the server.
  await opts.onAuthorizeUrl(buildAuthorizeUrl({ challenge, state }))
  const code = await callback
  opts.onStage?.('callback_received')
  opts.onStage?.('exchanging_code')
  const tokens = await exchangeAuthorizationCode(code, verifier)
  const label = accountLabelFromIdToken(tokens.idToken)
  return { tokens, ...(label !== undefined ? { accountLabel: label } : {}) }
}
