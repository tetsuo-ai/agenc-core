/**
 * xAI OAuth ("Sign in with X / Grok") for subscription-based Grok inference.
 *
 * Implements the same flow as Hermes agent, OpenClaw, and opencode: OIDC
 * discovery against `auth.x.ai`, browser authorization-code + PKCE with a
 * loopback callback (primary), and RFC 8628 device-code (headless fallback).
 * The resulting access token is a short-lived (~6 h) JWT used directly as
 * the bearer on `https://api.x.ai/v1`; the refresh token ROTATES on every
 * refresh, so refresh requests are never blindly retried.
 *
 * Uses xAI's shared Grok-CLI OAuth client (no per-app registration program
 * exists yet). Per xAI's request, the authorize URL carries
 * `referrer=agenc` so xAI can attribute logins to this app; the consent
 * screen may be labeled "Grok Build" because the client id is shared.
 *
 * Security invariants:
 *  - Every endpoint (discovered or configured) must be https on `x.ai` or a
 *    subdomain — a poisoned discovery document or base-URL override must
 *    never receive the bearer or the refresh token.
 *  - The loopback redirect is pinned to 127.0.0.1:56121/callback; xAI
 *    rejects redirect URIs that are not part of the client registration.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { asRecord } from '../../utils/record.js'

/** xAI's shared Grok-CLI OAuth client (public client, no secret). */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const XAI_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access'
const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
export const XAI_OAUTH_DISCOVERY_URL =
  `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
/** App attribution requested by xAI so they can identify usage sources. */
export const XAI_OAUTH_REFERRER = 'agenc'
/** Opts the consent screen into xAI's generic OAuth plan tier. */
const XAI_OAUTH_PLAN = 'generic'
/**
 * Loopback redirect. Host:port is part of xAI's client registration for the
 * shared client id — do not change. The Grok CLI may hold the same port.
 */
export const XAI_OAUTH_REDIRECT_PORT = 56121
export const XAI_OAUTH_REDIRECT_URI =
  `http://127.0.0.1:${XAI_OAUTH_REDIRECT_PORT}/callback`

/** Static fallbacks when the discovery document cannot be fetched. */
const XAI_OAUTH_FALLBACK_ENDPOINTS: XaiOauthEndpoints = {
  authorizationEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/authorize`,
  tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
  deviceAuthorizationEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/device/code`,
}

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_DEVICE_POLL_INTERVAL_S = 5
const MIN_DEVICE_POLL_INTERVAL_S = 1
const DEFAULT_DEVICE_TIMEOUT_S = 300
/** Cloudflare challenge pages on the token endpoint get a bounded retry. */
const CLOUDFLARE_CHALLENGE_MAX_RETRIES = 3
const CLOUDFLARE_CHALLENGE_RETRY_DELAY_MS = 250

export type XaiOauthEndpoints = {
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
}

export type XaiOauthTokens = {
  accessToken: string
  /** Absent only on refresh responses that do not rotate the token. */
  refreshToken?: string
  idToken?: string
  /** ms epoch, from `expires_in` or the access-token JWT `exp` claim. */
  expiresAt?: number
}

export type XaiOauthIdentity = {
  email?: string
  name?: string
  sub?: string
}

export type XaiDeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export type XaiOauthErrorCode =
  | 'untrusted_endpoint'
  | 'discovery_failed'
  | 'invalid_grant'
  | 'access_denied'
  | 'expired_token'
  | 'malformed_response'
  | 'callback_failed'
  | 'timeout'
  | 'oauth_error'

export class XaiOauthError extends Error {
  readonly code: XaiOauthErrorCode
  readonly status?: number

  constructor(code: XaiOauthErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'XaiOauthError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new XaiOauthError('timeout', 'xAI login aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new XaiOauthError('timeout', 'xAI login aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * True only for https URLs on `x.ai` or a subdomain. Applied to every
 * discovered endpoint so a poisoned discovery response cannot redirect
 * tokens off-origin.
 */
export function isTrustedXaiOauthEndpoint(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'x.ai' || host.endsWith('.x.ai')
}

/**
 * Hosts the OAuth bearer may be sent to for INFERENCE: xAI's API
 * (`api.x.ai`, Hermes' choice) and the Grok Build CLI proxy
 * (`cli-chat-proxy.grok.com`, OpenClaw's choice). A custom base-URL
 * override outside these origins must never receive the subscription
 * bearer — that is a token-exfiltration vector, not a configuration.
 */
export function isTrustedXaiOauthInferenceBaseUrl(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return (
    host === 'x.ai' ||
    host.endsWith('.x.ai') ||
    host === 'grok.com' ||
    host.endsWith('.grok.com')
  )
}

function requireTrustedEndpoint(url: unknown, label: string): string {
  if (typeof url !== 'string' || !isTrustedXaiOauthEndpoint(url)) {
    throw new XaiOauthError(
      'untrusted_endpoint',
      `xAI OAuth discovery returned an untrusted ${label}: ${String(url)}`,
    )
  }
  return url
}

/**
 * Fetch the OIDC discovery document and validate every endpoint against the
 * `*.x.ai` origin. Falls back to the known-good static endpoints when the
 * document cannot be fetched (the static values are trusted by construction).
 */
export async function discoverXaiOauthEndpoints(
  fetchImpl?: FetchLike,
): Promise<XaiOauthEndpoints> {
  const fetchFn = fetchImpl ?? fetch
  let data: Record<string, unknown> | undefined
  try {
    const res = await fetchFn(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      data = asRecord(await res.json()) ?? undefined
    }
  } catch {
    data = undefined
  }
  if (data === undefined) return { ...XAI_OAUTH_FALLBACK_ENDPOINTS }

  const endpoints: XaiOauthEndpoints = {
    authorizationEndpoint: requireTrustedEndpoint(
      data.authorization_endpoint,
      'authorization_endpoint',
    ),
    tokenEndpoint: requireTrustedEndpoint(data.token_endpoint, 'token_endpoint'),
  }
  if (typeof data.device_authorization_endpoint === 'string') {
    endpoints.deviceAuthorizationEndpoint = requireTrustedEndpoint(
      data.device_authorization_endpoint,
      'device_authorization_endpoint',
    )
  }
  return endpoints
}

export type XaiPkcePair = {
  verifier: string
  challenge: string
}

export function createXaiPkcePair(): XaiPkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createXaiOauthState(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Authorization URL for the browser PKCE flow. Carries `plan=generic`
 * (required for loopback OAuth on the shared client) and `referrer=agenc`
 * (usage attribution requested by xAI).
 */
export function buildXaiAuthorizeUrl(params: {
  authorizationEndpoint: string
  codeChallenge: string
  state: string
  nonce: string
  redirectUri?: string
}): string {
  const url = new URL(params.authorizationEndpoint)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: params.redirectUri ?? XAI_OAUTH_REDIRECT_URI,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    nonce: params.nonce,
    plan: XAI_OAUTH_PLAN,
    referrer: XAI_OAUTH_REFERRER,
  })
  url.search = query.toString()
  return url.toString()
}

function looksLikeCloudflareChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 503 && status !== 429) return false
  return /cloudflare|cf-ray|challenge-platform|just a moment/i.test(body)
}

async function postTokenEndpoint(
  tokenEndpoint: string,
  body: URLSearchParams,
  fetchFn: FetchLike,
  options?: { retryCloudflareChallenges?: boolean },
): Promise<Record<string, unknown>> {
  if (!isTrustedXaiOauthEndpoint(tokenEndpoint)) {
    throw new XaiOauthError(
      'untrusted_endpoint',
      `refusing to send OAuth credentials to untrusted token endpoint: ${tokenEndpoint}`,
    )
  }
  let attempt = 0
  for (;;) {
    const res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    const text = await res.text().catch(() => '')
    if (
      options?.retryCloudflareChallenges === true &&
      looksLikeCloudflareChallenge(res.status, text) &&
      attempt < CLOUDFLARE_CHALLENGE_MAX_RETRIES
    ) {
      attempt += 1
      await sleep(CLOUDFLARE_CHALLENGE_RETRY_DELAY_MS)
      continue
    }
    let data: Record<string, unknown> | undefined
    try {
      data = asRecord(JSON.parse(text)) ?? undefined
    } catch {
      data = undefined
    }
    if (data === undefined) {
      throw new XaiOauthError(
        'malformed_response',
        `xAI token endpoint returned non-JSON response (HTTP ${res.status})`,
        res.status,
      )
    }
    if (!res.ok || typeof data.error === 'string') {
      const err = typeof data.error === 'string' ? data.error : `http_${res.status}`
      const description =
        typeof data.error_description === 'string' ? `: ${data.error_description}` : ''
      // Poll-state errors are surfaced verbatim for the device-flow loop.
      if (
        err === 'authorization_pending' ||
        err === 'slow_down'
      ) {
        return data
      }
      const code: XaiOauthErrorCode =
        err === 'invalid_grant'
          ? 'invalid_grant'
          : err === 'access_denied'
          ? 'access_denied'
          : err === 'expired_token'
          ? 'expired_token'
          : 'oauth_error'
      throw new XaiOauthError(code, `xAI OAuth error ${err}${description}`, res.status)
    }
    return data
  }
}

/** Decode JWT payload claims without verification (expiry + display only). */
export function decodeXaiJwtClaims(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return asRecord(JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))) ??
      undefined
  } catch {
    return undefined
  }
}

export function xaiIdentityFromTokens(tokens: XaiOauthTokens): XaiOauthIdentity {
  const claims =
    decodeXaiJwtClaims(tokens.idToken) ?? decodeXaiJwtClaims(tokens.accessToken) ?? {}
  return {
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    ...(typeof claims.sub === 'string' ? { sub: claims.sub } : {}),
  }
}

function parseTokenResponse(
  data: Record<string, unknown>,
  options: { requireRefreshToken: boolean },
): XaiOauthTokens {
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (!accessToken) {
    throw new XaiOauthError('malformed_response', 'xAI token response had no access_token')
  }
  const refreshToken =
    typeof data.refresh_token === 'string' && data.refresh_token
      ? data.refresh_token
      : undefined
  if (options.requireRefreshToken && refreshToken === undefined) {
    throw new XaiOauthError(
      'malformed_response',
      'xAI token response had no refresh_token — the offline_access scope was ' +
        'rejected; sign in again and approve all requested permissions',
    )
  }
  // xAI does not always return expires_in; the JWT exp claim is the
  // load-bearing fallback (matches opencode's handling).
  let expiresAt: number | undefined
  if (typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)) {
    expiresAt = Date.now() + Math.max(0, data.expires_in) * 1000
  } else {
    const exp = decodeXaiJwtClaims(accessToken)?.exp
    if (typeof exp === 'number' && Number.isFinite(exp)) {
      expiresAt = exp * 1000
    }
  }
  return {
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(typeof data.id_token === 'string' && data.id_token
      ? { idToken: data.id_token }
      : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/**
 * Exchange a PKCE authorization code. Echoes `code_challenge` alongside
 * `code_verifier` as defense-in-depth for xAI's "code_challenge is required"
 * token-endpoint quirk (same workaround as Hermes).
 */
export async function exchangeXaiAuthorizationCode(params: {
  tokenEndpoint: string
  code: string
  codeVerifier: string
  codeChallenge: string
  redirectUri?: string
  fetchImpl?: FetchLike
}): Promise<XaiOauthTokens> {
  const data = await postTokenEndpoint(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: XAI_OAUTH_CLIENT_ID,
      code: params.code,
      redirect_uri: params.redirectUri ?? XAI_OAUTH_REDIRECT_URI,
      code_verifier: params.codeVerifier,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    }),
    params.fetchImpl ?? fetch,
  )
  return parseTokenResponse(data, { requireRefreshToken: true })
}

export async function requestXaiDeviceCode(params: {
  deviceAuthorizationEndpoint: string
  fetchImpl?: FetchLike
}): Promise<XaiDeviceCode> {
  if (!isTrustedXaiOauthEndpoint(params.deviceAuthorizationEndpoint)) {
    throw new XaiOauthError(
      'untrusted_endpoint',
      `refusing untrusted device authorization endpoint: ${params.deviceAuthorizationEndpoint}`,
    )
  }
  const fetchFn = params.fetchImpl ?? fetch
  const res = await fetchFn(params.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new XaiOauthError(
      'oauth_error',
      `xAI device code request failed: ${res.status} ${text}`,
      res.status,
    )
  }
  const data = asRecord(await res.json().catch(() => undefined)) ?? {}
  const deviceCode = data.device_code
  const userCode = data.user_code
  const verificationUri = data.verification_uri
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string'
  ) {
    throw new XaiOauthError('malformed_response', 'Malformed xAI device code response')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof data.verification_uri_complete === 'string'
      ? { verificationUriComplete: data.verification_uri_complete }
      : {}),
    expiresIn:
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_DEVICE_TIMEOUT_S,
    interval:
      typeof data.interval === 'number' && data.interval > 0
        ? data.interval
        : DEFAULT_DEVICE_POLL_INTERVAL_S,
  }
}

export async function pollXaiDeviceToken(params: {
  tokenEndpoint: string
  deviceCode: XaiDeviceCode
  fetchImpl?: FetchLike
  signal?: AbortSignal
}): Promise<XaiOauthTokens> {
  const fetchFn = params.fetchImpl ?? fetch
  let intervalS = Math.max(MIN_DEVICE_POLL_INTERVAL_S, params.deviceCode.interval)
  // +3s margin past the server-declared expiry so a final in-flight approval
  // still lands.
  const deadline = Date.now() + (params.deviceCode.expiresIn + 3) * 1000

  while (Date.now() < deadline) {
    const data = await postTokenEndpoint(
      params.tokenEndpoint,
      new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: params.deviceCode.deviceCode,
      }),
      fetchFn,
    )
    const err = typeof data.error === 'string' ? data.error : undefined
    if (err === undefined) {
      return parseTokenResponse(data, { requireRefreshToken: true })
    }
    if (err === 'slow_down') {
      intervalS =
        typeof data.interval === 'number' && data.interval > 0
          ? data.interval
          : intervalS + 5
    }
    await sleep(Math.max(MIN_DEVICE_POLL_INTERVAL_S, intervalS) * 1000, params.signal)
  }
  throw new XaiOauthError('timeout', 'Timed out waiting for xAI device authorization.')
}

/**
 * Refresh with a ROTATING refresh token. Never retried on transport failure:
 * if xAI consumed the token but the response was lost, a resend would burn
 * the rotated grant. Only Cloudflare challenge responses (which xAI has been
 * seen serving on this endpoint) are retried, and only because the request
 * never reached the OAuth server.
 */
export async function refreshXaiOauthTokens(params: {
  tokenEndpoint: string
  refreshToken: string
  fetchImpl?: FetchLike
}): Promise<XaiOauthTokens> {
  const data = await postTokenEndpoint(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: params.refreshToken,
    }),
    params.fetchImpl ?? fetch,
    { retryCloudflareChallenges: true },
  )
  return parseTokenResponse(data, { requireRefreshToken: false })
}

const CALLBACK_ALLOWED_ORIGINS = new Set([
  'https://accounts.x.ai',
  'https://auth.x.ai',
])

export type XaiLoopbackResult = {
  code: string
}

/**
 * One-shot loopback listener for the PKCE redirect. Resolves with the
 * authorization code after validating `state` (CSRF), then shuts down.
 */
export function waitForXaiLoopbackCallback(params: {
  state: string
  timeoutMs: number
  port?: number
}): { promise: Promise<XaiLoopbackResult>; close: () => void } {
  const port = params.port ?? XAI_OAUTH_REDIRECT_PORT
  let closeServer: () => void = () => {}

  const promise = new Promise<XaiLoopbackResult>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      // Delay close one tick so the response body flushes.
      setImmediate(() => server.close())
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin
      if (typeof origin === 'string' && CALLBACK_ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end('<html><body>Sign-in failed. You can close this tab.</body></html>')
        settle(() =>
          reject(
            new XaiOauthError(
              error === 'access_denied' ? 'access_denied' : 'callback_failed',
              `xAI sign-in was not completed: ${error}`,
            ),
          ),
        )
        return
      }
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (state !== params.state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end('<html><body>Invalid sign-in callback. You can close this tab.</body></html>')
        settle(() =>
          reject(
            new XaiOauthError(
              'callback_failed',
              'xAI sign-in callback failed state validation (possible CSRF); start the login again',
            ),
          ),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<html><body>Signed in. You can close this tab and return to the terminal.</body></html>',
      )
      settle(() => resolve({ code }))
    })

    const timer = setTimeout(() => {
      settle(() =>
        reject(new XaiOauthError('timeout', 'Timed out waiting for the browser sign-in.')),
      )
    }, params.timeoutMs)

    server.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'EADDRINUSE'
          ? `Port ${port} is in use (the Grok CLI may be holding it). ` +
            'Close it and retry, or use the device-code login instead.'
          : `xAI sign-in callback server failed: ${err.message}`
      settle(() => reject(new XaiOauthError('callback_failed', message)))
    })

    server.listen(port, '127.0.0.1')
    closeServer = () => {
      settle(() =>
        reject(new XaiOauthError('timeout', 'xAI sign-in was cancelled.')),
      )
    }
  })

  return { promise, close: () => closeServer() }
}

export type XaiBrowserLoginResult = {
  tokens: XaiOauthTokens
  identity: XaiOauthIdentity
  tokenEndpoint: string
}

/**
 * Full browser PKCE login: discovery → loopback listener → authorize URL →
 * code exchange. `onAuthorizeUrl` receives the URL to open/display; the
 * caller owns browser launching and UI.
 */
export async function runXaiBrowserLogin(params: {
  onAuthorizeUrl: (url: string) => void | Promise<void>
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<XaiBrowserLoginResult> {
  const endpoints = await discoverXaiOauthEndpoints(params.fetchImpl)
  const pkce = createXaiPkcePair()
  const state = createXaiOauthState()
  const nonce = createXaiOauthState()
  const callback = waitForXaiLoopbackCallback({
    state,
    timeoutMs: params.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_S * 1000,
  })
  try {
    const authorizeUrl = buildXaiAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      codeChallenge: pkce.challenge,
      state,
      nonce,
    })
    await params.onAuthorizeUrl(authorizeUrl)
    const { code } = await callback.promise
    const tokens = await exchangeXaiAuthorizationCode({
      tokenEndpoint: endpoints.tokenEndpoint,
      code,
      codeVerifier: pkce.verifier,
      codeChallenge: pkce.challenge,
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    })
    return {
      tokens,
      identity: xaiIdentityFromTokens(tokens),
      tokenEndpoint: endpoints.tokenEndpoint,
    }
  } catch (error) {
    callback.close()
    throw error
  }
}

export type XaiDeviceLoginResult = XaiBrowserLoginResult

/**
 * Headless RFC 8628 device-code login. `onUserCode` receives the code and
 * verification URL to show the user; polling continues until approval,
 * denial, or expiry.
 */
export async function runXaiDeviceLogin(params: {
  onUserCode: (info: {
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
  }) => void | Promise<void>
  fetchImpl?: FetchLike
  signal?: AbortSignal
}): Promise<XaiDeviceLoginResult> {
  const endpoints = await discoverXaiOauthEndpoints(params.fetchImpl)
  const deviceEndpoint =
    endpoints.deviceAuthorizationEndpoint ??
    XAI_OAUTH_FALLBACK_ENDPOINTS.deviceAuthorizationEndpoint
  if (deviceEndpoint === undefined) {
    throw new XaiOauthError('discovery_failed', 'xAI device authorization endpoint unavailable')
  }
  const deviceCode = await requestXaiDeviceCode({
    deviceAuthorizationEndpoint: deviceEndpoint,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  })
  await params.onUserCode({
    userCode: deviceCode.userCode,
    verificationUri: deviceCode.verificationUri,
    ...(deviceCode.verificationUriComplete !== undefined
      ? { verificationUriComplete: deviceCode.verificationUriComplete }
      : {}),
  })
  const tokens = await pollXaiDeviceToken({
    tokenEndpoint: endpoints.tokenEndpoint,
    deviceCode,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  })
  return {
    tokens,
    identity: xaiIdentityFromTokens(tokens),
    tokenEndpoint: endpoints.tokenEndpoint,
  }
}
