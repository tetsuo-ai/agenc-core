/**
 * Persistence + refresh for xAI OAuth ("Sign in with X / Grok") credentials.
 *
 * Storage uses one namespace in the shared secure-storage payload. Refresh
 * follows the provider's rotating-token rules:
 *  - single-flight: concurrent callers share one refresh promise so a
 *    rotated refresh token is never replayed;
 *  - refresh ~1 h before expiry (~6 h access tokens);
 *  - a terminal `invalid_grant` quarantines the blob instead of retrying —
 *    the user must sign in again.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  discoverXaiOauthEndpoints,
  decodeXaiJwtClaims,
  refreshXaiOauthTokens,
  XaiOauthError,
  xaiIdentityFromTokens,
  isTrustedXaiOauthEndpoint,
} from '../services/xai/oauth.js'
import type { XaiOauthTokens } from '../services/xai/oauth.js'
import type { HomeContext } from '../config/home.js'
import * as lockfile from './lockfile.js'
import type { SecureStorageData } from './secureStorage/index.js'
import {
  readNativeSecureStorage,
  updateNativeSecureStorage,
} from './secureStorage/native.js'
import { secureStorageIdentityKey } from './secureStorage/home.js'

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
 * Secure-storage reads invoke the platform adapter, and the grok
 * credential fallback sits on provider-resolution
 * paths that run often. A short TTL cache keeps those paths cheap;
 * save/clear update it immediately and the refresh path bypasses it.
 */
const READ_CACHE_TTL_MS = 30_000
const readCacheByHome = new Map<
  string,
  { at: number; blob: XaiOauthCredentialBlob | undefined }
>()

function readXaiOauthCredentialsFresh(
  home: HomeContext,
): XaiOauthCredentialBlob | undefined {
  try {
    const data = readNativeSecureStorage(home) as StorageShape
    const blob = data?.xaiOauth
    const result = blob?.accessToken?.trim() ? blob : undefined
    readCacheByHome.set(secureStorageIdentityKey(home), {
      at: Date.now(),
      blob: result,
    })
    return result
  } catch {
    return undefined
  }
}

export function readXaiOauthCredentials(
  home: HomeContext,
): XaiOauthCredentialBlob | undefined {
  const cached = readCacheByHome.get(secureStorageIdentityKey(home))
  if (cached !== undefined && Date.now() - cached.at < READ_CACHE_TTL_MS) {
    return cached.blob
  }
  return readXaiOauthCredentialsFresh(home)
}

/**
 * The stored bearer for provider use, or `undefined` when absent or
 * quarantined. May be expired — the provider's 401-refresh path recovers.
 */
export function readXaiOauthAccessToken(home: HomeContext): string | undefined {
  const blob = readXaiOauthCredentials(home)
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  return blob.accessToken
}

/** True when `apiKey` is the stored OAuth bearer (vs a real xAI API key). */
export function isXaiOauthBearer(
  home: HomeContext,
  apiKey: string | undefined,
): boolean {
  if (!apiKey) return false
  const blob = readXaiOauthCredentials(home)
  return blob !== undefined &&
    blob.quarantinedAt === undefined &&
    blob.accessToken === apiKey
}

export function saveXaiOauthCredentials(
  home: HomeContext,
  blob: XaiOauthCredentialBlob,
): { success: boolean; warning?: string } {
  if (!blob.accessToken?.trim()) {
    return { success: false, warning: 'Access token is empty.' }
  }
  try {
    updateNativeSecureStorage(
      home,
      current => ({ ...current, [XAI_OAUTH_STORAGE_KEY]: blob }),
      'Native secure storage is unavailable; xAI OAuth credentials were not saved.',
    )
    readCacheByHome.set(secureStorageIdentityKey(home), {
      at: Date.now(),
      blob,
    })
    return { success: true }
  } catch (error) {
    return nativeFailure(error, 'xAI OAuth credential save failed.')
  }
}

export function clearXaiOauthCredentials(
  home: HomeContext,
): { success: boolean; warning?: string } {
  try {
    updateNativeSecureStorage(
      home,
      current => {
        const next = { ...current }
        delete next[XAI_OAUTH_STORAGE_KEY]
        return next
      },
      'Native secure storage is unavailable; xAI OAuth credentials were not cleared.',
    )
    readCacheByHome.set(secureStorageIdentityKey(home), {
      at: Date.now(),
      blob: undefined,
    })
    return { success: true }
  } catch (error) {
    return nativeFailure(error, 'xAI OAuth credential clear failed.')
  }
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
const inflightRefreshByHome = new Map<
  string,
  Promise<XaiOauthCredentialBlob | undefined>
>()

/**
 * Force a refresh of the stored grant, regardless of expiry. Returns the
 * updated blob, or `undefined` when no refresh is possible (missing/
 * quarantined credentials, or terminal invalid_grant — which quarantines).
 */
export function forceRefreshXaiOauthCredentials(home: HomeContext): Promise<
  XaiOauthCredentialBlob | undefined
> {
  const storageIdentity = secureStorageIdentityKey(home)
  const existing = inflightRefreshByHome.get(storageIdentity)
  if (existing) return existing
  const pending = doRefresh(home).finally(() => {
    if (inflightRefreshByHome.get(storageIdentity) === pending) {
      inflightRefreshByHome.delete(storageIdentity)
    }
  })
  inflightRefreshByHome.set(storageIdentity, pending)
  return pending
}

/**
 * Refresh only when the stored token is inside the expiry skew window.
 * Safe to call at startup; no-ops quickly when nothing is stored.
 */
export async function refreshXaiOauthCredentialsIfNeeded(
  home: HomeContext,
): Promise<
  XaiOauthCredentialBlob | undefined
> {
  const blob = readXaiOauthCredentials(home)
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  if (!xaiOauthTokenIsExpiring(blob)) return blob
  return forceRefreshXaiOauthCredentials(home)
}

/**
 * Cross-process advisory lock around the token-endpoint exchange. The
 * in-process single-flight above cannot see a sibling agenc process (TUI +
 * daemon, or two daemons on different projects share ~/.agenc credentials);
 * two processes exchanging the same rotating refresh token concurrently
 * means the loser gets a terminal `invalid_grant` and — before this fix —
 * quarantined the blob, clobbering the winner's freshly rotated grant and
 * killing the live session ("Not logged in" mid-turn).
 *
 * Best-effort: when the lock cannot be acquired the refresh still proceeds,
 * protected by the adopt-on-conflict checks in {@link doRefresh}.
 */
async function acquireRefreshLock(
  home: HomeContext,
): Promise<() => Promise<void>> {
  try {
    await mkdir(home.path, { recursive: true })
    return await lockfile.lock(join(home.path, '.xai-oauth-refresh'), {
      realpath: false,
      stale: 30_000,
      retries: { retries: 5, minTimeout: 200, maxTimeout: 2_000 },
    })
  } catch {
    return async () => {}
  }
}

async function doRefresh(
  home: HomeContext,
): Promise<XaiOauthCredentialBlob | undefined> {
  // Fresh read: another process may have already rotated the grant, and a
  // refresh with a stale (consumed) refresh token would burn it.
  const blob = readXaiOauthCredentialsFresh(home)
  if (blob === undefined || blob.quarantinedAt !== undefined) return undefined
  const refreshToken = blob.refreshToken?.trim()
  if (!refreshToken) return undefined

  const release = await acquireRefreshLock(home)
  try {
    // Re-read under the lock: a sibling process may have rotated the grant
    // while we waited. Exchanging the stale token would burn the account's
    // rotating-refresh chain, so adopt the sibling's rotation instead.
    const current = readXaiOauthCredentialsFresh(home)
    if (current === undefined || current.quarantinedAt !== undefined) {
      return undefined
    }
    const currentRefresh = current.refreshToken?.trim()
    if (!currentRefresh) return undefined
    if (currentRefresh !== refreshToken) {
      return current
    }

    let tokenEndpoint = current.tokenEndpoint
    if (
      tokenEndpoint === undefined ||
      !isTrustedXaiOauthEndpoint(tokenEndpoint)
    ) {
      try {
        tokenEndpoint = (await discoverXaiOauthEndpoints()).tokenEndpoint
      } catch {
        return undefined
      }
    }

    try {
      const tokens = await refreshXaiOauthTokens({
        tokenEndpoint,
        refreshToken: currentRefresh,
      })
      const next = xaiOauthTokensToBlob(tokens, {
        tokenEndpoint,
        previous: current,
      })
      const written = compareAndSetXaiOauthCredentials(home, current, next)
      return written ? next : readXaiOauthCredentialsFresh(home)
    } catch (error) {
      if (
        error instanceof XaiOauthError &&
        (error.code === 'invalid_grant' ||
          error.code === 'access_denied' ||
          error.code === 'expired_token')
      ) {
        // Terminal for OUR refresh token — but only quarantine when the
        // stored grant is still the one that just failed. If a sibling
        // process rotated the grant between our read and the failure
        // (lock unavailable / bypassed), writing a quarantined stale blob
        // here would destroy the sibling's good rotation and force a
        // needless re-login. Adopt the sibling's grant instead.
        const latest = readXaiOauthCredentialsFresh(home)
        if (
          latest !== undefined &&
          latest.quarantinedAt === undefined &&
          latest.refreshToken?.trim() !== currentRefresh
        ) {
          return latest
        }
        // Quarantine so no caller replays a doomed refresh; the user must
        // run the login again.
        const quarantineBase = latest ?? current
        compareAndSetXaiOauthCredentials(home, quarantineBase, {
          ...quarantineBase,
          quarantinedAt: Date.now(),
          quarantineReason: error.message,
        })
      }
      // Transport/transient failures leave the blob untouched: the refresh
      // token may not have been consumed, and a retry would burn it if it
      // was. The next 401 triggers another single attempt.
      return undefined
    }
  } finally {
    await release()
  }
}

function compareAndSetXaiOauthCredentials(
  home: HomeContext,
  expected: XaiOauthCredentialBlob,
  replacement: XaiOauthCredentialBlob,
): boolean {
  let written = false
  let observed: XaiOauthCredentialBlob | undefined
  updateNativeSecureStorage(
    home,
    current => {
      const latest = current.xaiOauth
      if (!sameXaiOauthCredentials(latest, expected)) {
        observed = latest
        return structuredClone(current) as SecureStorageData
      }
      written = true
      return { ...current, xaiOauth: replacement }
    },
    'Native secure storage is unavailable; xAI OAuth refresh state was not saved.',
  )
  if (written) {
    readCacheByHome.set(secureStorageIdentityKey(home), {
      at: Date.now(),
      blob: replacement,
    })
  } else {
    readCacheByHome.set(secureStorageIdentityKey(home), {
      at: Date.now(),
      blob: observed,
    })
  }
  return written
}

function sameXaiOauthCredentials(
  left: XaiOauthCredentialBlob | undefined,
  right: XaiOauthCredentialBlob | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.idToken === right.idToken &&
    left.expiresAt === right.expiresAt &&
    left.tokenEndpoint === right.tokenEndpoint &&
    left.accountLabel === right.accountLabel &&
    left.lastRefreshAt === right.lastRefreshAt &&
    left.quarantinedAt === right.quarantinedAt &&
    left.quarantineReason === right.quarantineReason
}

function nativeFailure(error: unknown, fallback: string): {
  success: false
  warning: string
} {
  return {
    success: false,
    warning: error instanceof Error ? error.message : fallback,
  }
}

/**
 * True when the stored grant is quarantined (terminal refresh failure) or
 * absent — i.e. a new `/grok-login` is genuinely required. Used by the
 * provider's refresh callback to keep the "run /grok-login" error honest:
 * a transient network failure during refresh must NOT tell the user they
 * are logged out.
 */
export function xaiOauthRequiresRelogin(home: HomeContext): boolean {
  const blob = readXaiOauthCredentialsFresh(home)
  return (
    blob === undefined ||
    blob.quarantinedAt !== undefined ||
    !blob.refreshToken?.trim()
  )
}
