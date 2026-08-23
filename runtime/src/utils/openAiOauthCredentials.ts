/**
 * Storage for the ChatGPT sign-in: the RFC 8693-exchanged platform API
 * key (long-lived — the thing the runtime actually consumes) plus the
 * login tokens that produced it. Modeled on xaiOauthCredentials, minus
 * the refresh machinery the exchanged key does not need.
 */

import { getSecureStorage, type SecureStorageData } from './secureStorage/index.js'
import { isBareMode } from './envUtils.js'
import {
  PROVIDER_CODE_REFRESH_URL,
  decodeJwtPayload,
  getOpenAiCodeOAuthClientId,
  normalizeOAuthTokenPayload,
} from '../services/api/openAiCodeOAuthShared.js'

export const OPENAI_OAUTH_STORAGE_KEY = 'openAiOauth' as const

export type OpenAiOauthCredentialBlob = NonNullable<
  SecureStorageData[typeof OPENAI_OAUTH_STORAGE_KEY]
>

const READ_CACHE_TTL_MS = 30_000
let readCache: { at: number; blob: OpenAiOauthCredentialBlob | undefined } | null =
  null

export function readOpenAiOauthCredentials(): OpenAiOauthCredentialBlob | undefined {
  if (isBareMode()) return undefined
  if (readCache !== null && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.blob
  }
  const data = getSecureStorage().read()
  const blob = data?.[OPENAI_OAUTH_STORAGE_KEY]
  readCache = { at: Date.now(), blob }
  return blob
}

/** The exchanged platform API key, when signed in. */
export function readOpenAiOauthApiKey(): string | undefined {
  const blob = readOpenAiOauthCredentials()
  const key = blob?.apiKey?.trim()
  return key !== undefined && key.length > 0 ? key : undefined
}

/**
 * The ChatGPT backend that a subscription sign-in talks to. Requests go
 * to `{base}/responses` with the access token as the bearer and the
 * account id in a header — no platform API key is involved, which is why
 * this path works for accounts that have no platform organization.
 */
// branding-scan: allow factual reference to real provider in endpoint
export const CHATGPT_BACKEND_BASE_URL =
  'https://chatgpt.com/backend-api/codex'

/**
 * Identifies the calling client to that backend. It accepts third-party
 * values (other harnesses send their own name), so we send ours rather
 * than impersonating a first-party client.
 */
export const CHATGPT_BACKEND_ORIGINATOR = 'agenc'

export interface OpenAiSubscriptionAuth {
  readonly accessToken: string
  readonly accountId: string
  readonly baseUrl: string
  readonly accountLabel?: string
}

/**
 * Subscription credentials, when the sign-in produced tokens but no
 * platform API key. Returns undefined when a real API key exists — that
 * path is simpler and takes precedence.
 */
export function readOpenAiSubscriptionAuth():
  | OpenAiSubscriptionAuth
  | undefined {
  const blob = readOpenAiOauthCredentials()
  if (blob === undefined) return undefined
  if (blob.apiKey?.trim()) return undefined
  const accessToken = blob.accessToken?.trim()
  const accountId = blob.accountId?.trim()
  if (!accessToken || !accountId) return undefined
  return {
    accessToken,
    accountId,
    baseUrl: CHATGPT_BACKEND_BASE_URL,
    ...(blob.accountLabel !== undefined
      ? { accountLabel: blob.accountLabel }
      : {}),
  }
}

export function saveOpenAiOauthCredentials(
  blob: OpenAiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  // Either credential shape is valid: a platform API key, or the
  // subscription pair the ChatGPT backend authenticates with.
  const hasApiKey = Boolean(blob.apiKey?.trim())
  const hasSubscription =
    Boolean(blob.accessToken?.trim()) && Boolean(blob.accountId?.trim())
  if (!hasApiKey && !hasSubscription) {
    return {
      success: false,
      warning: 'No API key and no ChatGPT subscription tokens to store.',
    }
  }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const result = secureStorage.update({
    ...prev,
    [OPENAI_OAUTH_STORAGE_KEY]: blob,
  })
  if (result.success) {
    readCache = { at: Date.now(), blob }
  }
  return result
}

/**
 * Refresh the subscription access token when it is close to expiring.
 * Returns true when the stored credential was updated. The refresh
 * response restates the tokens but never the account id, so that field
 * is carried forward from the existing blob.
 */
export async function refreshOpenAiSubscriptionIfNeeded(options?: {
  readonly nowMs?: number
  readonly windowMs?: number
}): Promise<boolean> {
  const blob = readOpenAiOauthCredentials()
  const refreshToken = blob?.refreshToken?.trim()
  if (blob === undefined || !refreshToken) return false
  if (blob.apiKey?.trim()) return false

  const now = options?.nowMs ?? Date.now()
  const window = options?.windowMs ?? 5 * 60_000
  const expiresAt = jwtExpiryMs(blob.accessToken)
  if (expiresAt !== undefined && expiresAt - window > now) return false

  const response = await fetch(PROVIDER_CODE_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: getOpenAiCodeOAuthClientId(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) return false
  const payload = normalizeOAuthTokenPayload(await response.json())
  if (!payload.accessToken) return false

  const saved = saveOpenAiOauthCredentials({
    ...blob,
    accessToken: payload.accessToken,
    ...(payload.idToken ? { idToken: payload.idToken } : {}),
    // Refresh tokens rotate; reusing a spent one is rejected.
    ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
    obtainedAt: now,
  })
  return saved.success
}

/** `exp` from a JWT payload, in ms. Undefined when unreadable. */
function jwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined
  const claims = decodeJwtPayload(token)
  const exp = claims?.['exp']
  return typeof exp === 'number' ? exp * 1000 : undefined
}

export function clearOpenAiOauthCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) return { success: true }
  const secureStorage = getSecureStorage()
  const prev = secureStorage.read() ?? {}
  const next = { ...prev }
  delete next[OPENAI_OAUTH_STORAGE_KEY]
  const result = secureStorage.update(next)
  if (result.success) {
    readCache = { at: Date.now(), blob: undefined }
  }
  return result
}
