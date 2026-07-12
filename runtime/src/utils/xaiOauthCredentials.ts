/**
 * Persistence + refresh for xAI OAuth ("Sign in with X / Grok") credentials.
 *
 * Storage follows the githubModels/gemini credential pattern: one blob in
 * the shared secure-storage payload. Refresh follows the Hermes/opencode
 * rules for xAI's ROTATING refresh tokens:
 *  - single-flight: concurrent callers share one refresh promise so a
 *    rotated refresh token is never replayed;
 *  - refresh ~1 h before expiry (~6 h access tokens);
 *  - a terminal `invalid_grant` quarantines the blob instead of retrying —
 *    the user must sign in again.
 */

import {
  discoverXaiOauthEndpoints,
  decodeXaiJwtClaims,
  refreshXaiOauthTokens,
  XaiOauthError,
  xaiIdentityFromTokens,
  isTrustedXaiOauthEndpoint,
} from '../services/xai/oauth.js'
import type { XaiOauthTokens } from '../services/xai/oauth.js'
import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'

export const XAI_OAUTH_STORAGE_KEY = 'xaiOauth' as const

/** Refresh this long before expiry (access tokens live ~6 h). */
export const XAI_OAUTH_REFRESH_SKEW_MS = 60 * 60 * 1000

export type XaiOauthCredentialBlob = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** ms epoch */
  expiresAt?: number
  /** Token endpoint the grant is bound to (from discovery at login time). */
  tokenEndpoint?: string
  /** Display label (email/name) decoded from the id token at login. */
  accountLabel?: string
  lastRefreshAt?: number
  /** Set when a refresh hit terminal invalid_grant; requires re-login. */
  quarantinedAt?: number
  quarantineReason?: string
}

type StorageShape = { xaiOauth?: XaiOauthCredentialBlob } & Record<string, unknown>

/**
 * Secure-storage reads can shell out (secret-tool on Linux, keychain on
 * macOS), and the grok credential fallback sits on provider-resolution
 * paths that run often. A short TTL cache keeps those paths cheap;
 * save/clear update it immediately and the refresh path bypasses it.
 */
const READ_CACHE_TTL_MS = 30_000
let readCache: { at: number; blob: XaiOauthCredentialBlob | undefined } | null =
  null

function readXaiOauthCredentialsFresh(): XaiOauthCredentialBlob | undefined {
  if (isBareMode()) return undefined
  try {
    const data = getSecureStorage().read() as StorageShape | null
    const blob = data?.xaiOauth
    const result = blob?.accessToken?.trim() ? blob : undefined
    readCache = { at: Date.now(), blob: result }
    return result
  } catch {
    return undefined
  }
}

export function readXaiOauthCredentials(): XaiOauthCredentialBlob | undefined {
  if (readCache !== null && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.blob
  }
  return readXaiOauthCredentialsFresh()
}

/**
 * The stored bearer for provider use, or `undefined` when absent or
 * quarantined. May be expired — the provider's 401-refresh path recovers.
 */
export function readXaiOauthAccessToken(): string | undefined {
  const blob = readXaiOauthCredentials()
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  return blob.accessToken
}

/** True when `apiKey` is the stored OAuth bearer (vs a real xAI API key). */
export function isXaiOauthBearer(apiKey: string | undefined): boolean {
  if (!apiKey) return false
  const blob = readXaiOauthCredentials()
  return blob !== undefined &&
    blob.quarantinedAt === undefined &&
    blob.accessToken === apiKey
}

export function saveXaiOauthCredentials(
  blob: XaiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: false, warning: 'Bare mode: secure storage is disabled.' }
  }
  if (!blob.accessToken?.trim()) {
    return { success: false, warning: 'Access token is empty.' }
  }
  const secureStorage = getSecureStorage()
  const prev = (secureStorage.read() || {}) as StorageShape
  const merged = { ...prev, [XAI_OAUTH_STORAGE_KEY]: blob }
  const result = secureStorage.update(merged as typeof prev)
  if (result.success) {
    readCache = { at: Date.now(), blob }
  }
  return result
}

export function clearXaiOauthCredentials(): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return { success: true }
  }
  const secureStorage = getSecureStorage()
  const prev = (secureStorage.read() || {}) as StorageShape
  const next = { ...prev }
  delete next[XAI_OAUTH_STORAGE_KEY]
  const result = secureStorage.update(next as typeof prev)
  if (result.success) {
    readCache = { at: Date.now(), blob: undefined }
  }
  return result
}

export function xaiOauthTokensToBlob(
  tokens: XaiOauthTokens,
  context: { tokenEndpoint?: string; previous?: XaiOauthCredentialBlob },
): XaiOauthCredentialBlob {
  const identity = xaiIdentityFromTokens(tokens)
  const accountLabel =
    identity.email ?? identity.name ?? context.previous?.accountLabel
  return {
    accessToken: tokens.accessToken,
    // A refresh response without a rotated refresh_token keeps the old one.
    ...(tokens.refreshToken ?? context.previous?.refreshToken
      ? { refreshToken: tokens.refreshToken ?? context.previous?.refreshToken }
      : {}),
    ...(tokens.idToken ?? context.previous?.idToken
      ? { idToken: tokens.idToken ?? context.previous?.idToken }
      : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...(context.tokenEndpoint ?? context.previous?.tokenEndpoint
      ? { tokenEndpoint: context.tokenEndpoint ?? context.previous?.tokenEndpoint }
      : {}),
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    lastRefreshAt: Date.now(),
  }
}

function blobExpiryMs(blob: XaiOauthCredentialBlob): number | undefined {
  if (typeof blob.expiresAt === 'number' && Number.isFinite(blob.expiresAt)) {
    return blob.expiresAt
  }
  const exp = decodeXaiJwtClaims(blob.accessToken)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

export function xaiOauthTokenIsExpiring(blob: XaiOauthCredentialBlob): boolean {
  const expiry = blobExpiryMs(blob)
  // Unknown expiry: treat as expiring so the refresh path keeps it warm.
  if (expiry === undefined) return true
  return Date.now() >= expiry - XAI_OAUTH_REFRESH_SKEW_MS
}

/** Single-flight guard: rotating refresh tokens must never race. */
let inflightRefresh: Promise<XaiOauthCredentialBlob | undefined> | null = null

/**
 * Force a refresh of the stored grant, regardless of expiry. Returns the
 * updated blob, or `undefined` when no refresh is possible (missing/
 * quarantined credentials, or terminal invalid_grant — which quarantines).
 */
export function forceRefreshXaiOauthCredentials(): Promise<
  XaiOauthCredentialBlob | undefined
> {
  if (inflightRefresh) return inflightRefresh
  inflightRefresh = doRefresh().finally(() => {
    inflightRefresh = null
  })
  return inflightRefresh
}

/**
 * Refresh only when the stored token is inside the expiry skew window.
 * Safe to call at startup; no-ops quickly when nothing is stored.
 */
export async function refreshXaiOauthCredentialsIfNeeded(): Promise<
  XaiOauthCredentialBlob | undefined
> {
  const blob = readXaiOauthCredentials()
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  if (!xaiOauthTokenIsExpiring(blob)) return blob
  return forceRefreshXaiOauthCredentials()
}

async function doRefresh(): Promise<XaiOauthCredentialBlob | undefined> {
  // Fresh read: another process may have already rotated the grant, and a
  // refresh with a stale (consumed) refresh token would burn it.
  const blob = readXaiOauthCredentialsFresh()
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  const refreshToken = blob.refreshToken?.trim()
  if (!refreshToken) return undefined

  let tokenEndpoint = blob.tokenEndpoint
  if (tokenEndpoint === undefined || !isTrustedXaiOauthEndpoint(tokenEndpoint)) {
    try {
      tokenEndpoint = (await discoverXaiOauthEndpoints()).tokenEndpoint
    } catch {
      return undefined
    }
  }

  try {
    const tokens = await refreshXaiOauthTokens({ tokenEndpoint, refreshToken })
    const next = xaiOauthTokensToBlob(tokens, { tokenEndpoint, previous: blob })
    saveXaiOauthCredentials(next)
    return next
  } catch (error) {
    if (
      error instanceof XaiOauthError &&
      (error.code === 'invalid_grant' ||
        error.code === 'access_denied' ||
        error.code === 'expired_token')
    ) {
      // Terminal: the rotated grant is dead. Quarantine so no caller
      // replays a doomed refresh; the user must run the login again.
      saveXaiOauthCredentials({
        ...blob,
        quarantinedAt: Date.now(),
        quarantineReason: error.message,
      })
    }
    // Transport/transient failures leave the blob untouched: the refresh
    // token may not have been consumed, and a retry would burn it if it
    // was. The next 401 triggers another single attempt.
    return undefined
  }
}
